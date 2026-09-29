#!/usr/bin/env bash
# Operacion del entorno de demostracion.
#
#   ./demo.sh up                   construye, genera tokens, registra agentes y arranca todo
#   ./demo.sh fuga                 trafico a /generar de reportes: fuga de memoria hasta el OOM
#   ./demo.sh carga                trafico concurrente a consultas (app-01): la latencia sube
#   ./demo.sh apagar <servidor>    apaga un servidor completo: web | app | db
#   ./demo.sh encender <servidor>  lo vuelve a encender
#   ./demo.sh cortar <servidor>    corta la red entre un servidor y el Hub
#   ./demo.sh restaurar <servidor> la restablece: el agente reenvia su cola
#   ./demo.sh reset                detiene el trafico provocado y enciende todo
#   ./demo.sh puertos              muestra que ningun agente escucha en un puerto
#   ./demo.sh revocar <servidor>   revoca el token de un servidor
#   ./demo.sh logs <servidor>      sigue el NDJSON de un agente
#   ./demo.sh down                 detiene y borra todo, incluidos los datos
set -euo pipefail
cd "$(dirname "$0")"

compose () { docker compose "$@"; }

# Servicios que forman cada servidor simulado. El agente va primero.
servidor () {
  case "${1:-}" in
    web|web-01) echo "agent-web portal tramites reportes" ;;
    app|app-01) echo "agent-app" ;;
    db|db-01)   echo "agent-db db-tramites" ;;
    *) echo "servidor desconocido: ${1:-} (web|app|db)" >&2; exit 64 ;;
  esac
}
agente () { set -- $(servidor "$1"); echo "$1"; }
nodo () { case "$(agente "$1")" in agent-web) echo web-01 ;; agent-app) echo app-01 ;; agent-db) echo db-01 ;; esac; }

case "${1:-}" in
  up)
    if [ ! -f .env ]; then
      # Secretos generados en local; .env esta en .gitignore y nunca se commitea.
      {
        echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)"
        echo "TOKEN_WEB=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"
        echo "TOKEN_APP=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"
        echo "TOKEN_DB=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"
      } > .env
      chmod 600 .env
    fi
    set -a; . ./.env; set +a
    compose build
    compose up -d --wait --remove-orphans postgres hub
    for pair in "web-01:$TOKEN_WEB" "app-01:$TOKEN_APP" "db-01:$TOKEN_DB"; do
      compose exec -T hub node apps/hub/src/cli.js agent add "${pair%%:*}" --token "${pair#*:}" >/dev/null 2>&1 || true
    done
    compose up -d --remove-orphans
    echo "Panel: http://localhost:8080"
    ;;
  fuga)
    echo "Generando reportes sin parar durante 45s: la memoria de 'reportes' sube hasta su limite (96 MB)..."
    compose exec -d trafico node trafico.js ritmo http://reportes:3000/generar 6 45
    ;;
  carga)
    echo "80 usuarios concurrentes contra 'consultas' (app-01) durante 45s..."
    compose exec -d trafico node trafico.js rafaga http://agent-app:8081/ 80 45
    ;;
  apagar)
    echo "Apagando $(nodo "${2:-}")..."
    compose stop $(servidor "${2:-}")
    ;;
  encender)      compose start $(servidor "${2:-}") ;;
  cortar)        docker network disconnect mind-demo_ingest "mind-demo-$(agente "${2:-}")-1" && echo "red cortada entre $(nodo "$2") y el Hub" ;;
  restaurar)     docker network connect mind-demo_ingest "mind-demo-$(agente "${2:-}")-1" && echo "red restablecida" ;;
  reset)
    # El trafico provocado corre dentro del contenedor `trafico`: reiniciarlo lo corta.
    compose restart trafico >/dev/null 2>&1
    for s in web app db; do
      docker network connect mind-demo_ingest "mind-demo-$(agente "$s")-1" 2>/dev/null || true
    done
    compose up -d >/dev/null 2>&1
    echo "todo encendido y sin trafico provocado"
    ;;
  puertos|ports)
    # Cruza los sockets TCP en LISTEN del namespace con los descriptores del
    # proceso del agente. netstat solo no basta: tambien lista el resolvedor DNS
    # interno de Docker y, en app-01, la aplicacion que corre en ese servidor.
    for s in agent-web agent-app agent-db; do
      printf '%-10s ' "$s"
      compose exec -T "$s" node -e '
        const fs = require("fs")
        const pid = fs.readdirSync("/proc").filter((p) => /^\d+$/.test(p) && p !== String(process.pid))
          .find((p) => { try { return fs.readFileSync(`/proc/${p}/cmdline`, "utf8").includes("apps/agent/src/main.js") } catch { return false } })
        const listen = new Set()
        for (const f of ["/proc/net/tcp", "/proc/net/tcp6"]) {
          for (const l of fs.readFileSync(f, "utf8").trim().split("\n").slice(1)) {
            const c = l.trim().split(/\s+/)
            if (c[3] === "0A") listen.add(c[9])
          }
        }
        const own = fs.readdirSync(`/proc/${pid}/fd`)
          .map((fd) => { try { return fs.readlinkSync(`/proc/${pid}/fd/${fd}`) } catch { return "" } })
          .map((l) => /^socket:\[(\d+)\]$/.exec(l)?.[1]).filter((i) => listen.has(i))
        console.log(own.length ? own.length + " socket(s) de escucha" : "0 sockets de escucha en el proceso del agente")'
    done
    ;;
  revocar)       compose exec -T hub node apps/hub/src/cli.js agent revoke "$(nodo "${2:-}")" ;;
  logs)          compose logs -f --no-log-prefix "$(agente "${2:-}")" ;;
  down)          compose down -v --remove-orphans; rm -f .env ;;
  *)             sed -n '2,16p' "$0"; exit 64 ;;
esac
