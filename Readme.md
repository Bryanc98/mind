# M.I.N.D. — Monitor Inteligente de Nodos y Despliegues

Sistema de monitoreo de infraestructura para **flotas híbridas y heredadas**: un mismo
agente corre en un Debian con Docker y en un Windows Server 2012 con IIS, sin abrir
un solo puerto de escucha. Cuando algo se cae, diagnostica la causa raíz leyendo los
logs con un modelo de lenguaje y entrega el análisis en español junto con la alerta.

> **Estado: en desarrollo activo.** El agente y el Hub se construyen por etapas;
> ver [`docs/ROADMAP.md`](docs/ROADMAP.md) para el alcance de cada una.

---

## 1. Por qué existe, si ya existe Prometheus

Es la primera pregunta honesta que hay que responder, y hay que responderla antes de
escribir código. **Prometheus + node_exporter + Grafana + Loki hacen el 80% de esto,
gratis y mejor.** Si el argumento fuera solo "monitoreo sin costo de licenciamiento",
el proyecto no se justifica.

Lo que M.I.N.D. hace y ese stack hace mal:

| | Stack estándar | M.I.N.D. |
|---|---|---|
| **Flotas heredadas** | Un exporter distinto por tecnología, cada uno abriendo su puerto | Un agente para Linux, Windows, Docker y apps tradicionales |
| **Modelo de red** | *Pull*: el servidor central entra a cada nodo. Requiere abrir puertos y reglas de firewall por nodo | *Push*: el nodo sale hacia el Hub. Cero puertos de escucha |
| **Análisis de causa raíz** | Te da el gráfico; el diagnóstico lo haces tú | Correlaciona métrica y log y redacta el diagnóstico |
| **Costo de adopción** | Semanas de configuración y una curva de PromQL | Un `.env` y un servicio |

Y lo que el stack estándar hace mejor: series de tiempo a gran escala, retención
histórica, consultas ad-hoc y un ecosistema enorme de dashboards. **No competimos
ahí.** El Hub expone sus propias métricas en formato Prometheus, de modo que
ambos mundos convivan en vez de excluirse.

El diferenciador defendible es: **un solo agente, cero puertos abiertos, diagnóstico
en español.** Todo lo demás es secundario.

---

## 2. Arquitectura

Patrón **Agente-Recolector** en un monorepo.

*   **M.I.N.D. Agent** — proceso ligero en cada servidor. Es el núcleo open source.
*   **M.I.N.D. Hub** — servidor central: consolida telemetría, consulta a la IA y
    expone el panel de control.

### Modos de operación

El agente es **desacoplable**; la presencia de `MIND_HUB_URL` es lo único que decide
su comportamiento (ADR 0003):

1.  **Standalone** — sin `MIND_HUB_URL`. El agente procesa todo localmente: sanitiza,
    consulta al proveedor de IA y notifica por SMTP. Para servidores aislados o
    proyectos personales.
2.  **Hub** — con `MIND_HUB_URL`. El agente solo recolecta y hace `POST` de la
    telemetría sanitizada. El Hub asume la carga de la IA y las notificaciones.

### Decisiones ya tomadas

El documento original dejaba abiertas varias alternativas ("Node **o** .NET",
"Vue **o** Angular"). Están cerradas para no arrastrar ambigüedad:

| Componente | Elección | ADR |
|---|---|---|
| Runtime | Node.js 24 LTS | [0001](docs/adr/0001-stack-y-monorepo.md) |
| API del Hub | Fastify | [0001](docs/adr/0001-stack-y-monorepo.md) |
| Base de datos | PostgreSQL | [0001](docs/adr/0001-stack-y-monorepo.md) |
| Dashboard | Vue 3 | [0001](docs/adr/0001-stack-y-monorepo.md) |
| Monorepo | pnpm workspaces | [0001](docs/adr/0001-stack-y-monorepo.md) |
| Licencia | Apache-2.0 | [0005](docs/adr/0005-licencia-y-split-oss-interno.md) |

---

## 3. Componentes

### 3.1. M.I.N.D. Agent

*   **Entorno:** Node.js 24 LTS (`fetch` nativo, `node:test` integrado).
*   **Consumo objetivo:** < 65 MB de RAM y < 1% de CPU en reposo.
*   **Responsabilidades:**
    *   **Sistema operativo:** CPU y RAM. El uso de CPU se calcula como derivada de
        los contadores acumulados del kernel, no como lectura instantánea
        (`packages/collectors-os`).
    *   **Contenedores:** estado vía `docker inspect`. Sirve para servicios en .NET,
        Node o Laravel indistintamente.
    *   **HTTP activo:** ping a URLs para apps tradicionales (por ejemplo portales
        en WordPress) y extracción del `error_log` ante un 500 o un timeout.
    *   **Máquina de estados:** `UNKNOWN → UP → DEGRADED → DOWN` con umbrales
        asimétricos: bajar de estado exige fallos consecutivos, recuperarse
        ocurre con un solo éxito. Evita la fatiga de alertas.
    *   **Sanitización:** enmascarado de datos sensibles antes de cualquier salida.
    *   **Buffer local:** cola en disco cuando el Hub no responde, para no perder
        eventos durante un corte de red.

### 3.2. M.I.N.D. Hub

*   **Backend:** Node.js + Fastify.
*   **Frontend:** Vue 3.
*   **Base de datos:** PostgreSQL.
*   **Responsabilidades:**
    *   Validar la identidad de los agentes (tokens almacenados con hash, nunca en
        claro).
    *   Recibir telemetría y clasificar el estado de los nodos.
    *   Consultar al proveedor de IA ante un estado `DOWN`, con deduplicación,
        *cooldown* por nodo y techo de gasto diario.
    *   **Dead man's switch:** si un nodo deja de reportar por más de N intervalos,
        eso *es* la alerta. Es lo que resuelve "¿quién vigila al vigilante?".
    *   Distribuir las alertas diagnosticadas.

---

## 4. Ciberseguridad (Security by Design)

1.  **Cero puertos abiertos (modelo push).** El agente no expone ningún socket
    entrante. Toda la comunicación es unidireccional de salida por HTTPS hacia el
    Hub ([ADR 0002](docs/adr/0002-push-sin-puertos-abiertos.md)).
2.  **Cero RCE.** La arquitectura es estrictamente de telemetría. El Hub **no puede**
    enviar comandos de reinicio, scripts ni modificaciones de archivos a los nodos.
    No es una restricción de configuración: la capacidad no existe en el código.
3.  **Sanitización de PII y credenciales.** Antes de cualquier salida a red, el
    agente enmascara contraseñas, secretos y API keys, cadenas de conexión, tokens
    JWT/Bearer, correos e identificaciones (cédula RD, RNC).
    El log original **nunca sale del nodo**: solo la versión enmascarada y truncada.
4.  **Aislamiento de nodos.** Cada agente reporta con un `MIND_SERVER_TOKEN` único.
    Si un servidor se compromete, se revoca ese token y la brecha queda contenida.
5.  **Menor privilegio.** El proceso corre como usuario de servicio sin `root` ni
    Administrador, limitado al grupo de lectura de logs y al de Docker.
6.  **Proveedor de IA intercambiable.** Gemini en la versión open source; modelo
    local (Ollama) para entornos donde la política de datos prohíba enviar logs a
    un servicio de IA público. La aprobación institucional es un trámite, no un
    `if`: la arquitectura no puede depender de que salga bien.

---

## 5. Estructura del monorepo

```text
mind/
├── packages/
│   ├── agent-core/            # config, máquina de estados, bucle, logger
│   ├── collectors-os/         # CPU y RAM sobre node:os, cero dependencias
│   ├── collectors-docker/     # estado de contenedores (planificado)
│   ├── collectors-http/       # sondeo de endpoints (planificado)
│   ├── sanitizer/             # motor de enmascarado (planificado)
│   └── ai-provider/           # interfaz de IA: Gemini y Ollama (planificado)
│
├── apps/
│   ├── agent/                 # binario que se despliega en los servidores
│   ├── hub/                   # API Fastify (planificado)
│   └── dashboard/             # panel Vue 3 (planificado)
│
└── docs/
    ├── ROADMAP.md             # alcance por etapas
    └── adr/                   # decisiones de arquitectura, una por archivo
```

---

## 6. Alcance abierto vs. interno

Este repositorio es la **versión open source**, sin nada específico de ninguna
institución. Una organización que lo despliegue mantiene su propio repositorio
privado, que **consume estos paquetes como dependencia** y aporta sus plugins:
autenticación contra su directorio corporativo, persistencia alternativa, reglas
de PII locales, SMTP interno e inventario de servidores.

No hay fork y no hay divergencia. Ver
[ADR 0005](docs/adr/0005-licencia-y-split-oss-interno.md).

**Regla sin excepciones:** en este repositorio no entra ni un hostname, ni una IP,
ni un nombre de servidor, ni una convención de nomenclatura interna. Ni en un test,
ni en un comentario, ni en un mensaje de commit. Una vez que algo entra al historial
de git, está publicado, aunque después se borre el archivo.

---

## 7. Arrancar

Requiere Node.js >= 22.11. El proyecto fija 24.20.0 en `.node-version`, que
`fnm` y `nvm` leen automáticamente.

```sh
corepack enable   # habilita pnpm en la versión que declara package.json
pnpm install
pnpm test
```

Para ejecutar el agente en local:

```sh
cp apps/agent/.env.example apps/agent/.env
set -a && . apps/agent/.env && set +a
pnpm agent
```

El agente escribe NDJSON a `stdout`. Un supervisor como systemd captura esa
salida directamente, sin que el proceso gestione archivos de log ni rotación.

## Seguridad

Para reportar una vulnerabilidad, ver [`SECURITY.md`](SECURITY.md). Las tres
propiedades de seguridad que el proyecto afirma —sin sockets de escucha, sin
ejecución remota y enmascarado previo a la salida— están dentro del alcance:
un hallazgo que contradiga cualquiera de ellas es una vulnerabilidad.

## Licencia

Apache-2.0. Ver [`LICENSE`](LICENSE) y [`NOTICE`](NOTICE).
