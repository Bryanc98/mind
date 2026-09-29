/**
 * Colector de estado de contenedores. Sin dependencias: habla con la Engine
 * API de Docker por HTTP, sobre el socket unix o sobre TCP.
 *
 * Es la misma informacion que `docker inspect`, pero sin lanzar un proceso por
 * contenedor ni depender de que el binario `docker` este instalado en el nodo.
 *
 * Solo se usan peticiones GET. El agente no crea, detiene ni reinicia
 * contenedores (ADR 0002). Aun asi, acceso al socket de Docker equivale a
 * acceso de root en el anfitrion, porque la API permite crear un contenedor
 * privilegiado que monte `/`. La forma recomendada de despliegue es a traves de
 * un proxy del socket que solo permita `GET /containers/*`; por eso se admite
 * `tcp://` ademas de `unix://`.
 */

import http from 'node:http'

/**
 * @param {string} dockerHost unix:///ruta/al/socket o tcp://host:puerto
 * @param {{ timeoutMs?: number }} [opts]
 */
export function createDockerClient (dockerHost, { timeoutMs = 5000 } = {}) {
  const target = parseDockerHost(dockerHost)

  function get (path, { raw = false, binary = false } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({ ...target, path, method: 'GET', timeout: timeoutMs }, (res) => {
        const chunks = []
        res.on('data', (chunk) => { chunks.push(chunk) })
        res.on('end', () => {
          const buf = Buffer.concat(chunks)
          if (res.statusCode !== 200) {
            reject(new Error(`docker ${path} respondio ${res.statusCode}: ${buf.toString('utf8').slice(0, 200)}`))
            return
          }
          if (binary) { resolve(buf); return }
          const body = buf.toString('utf8')
          if (raw) { resolve(body); return }
          try { resolve(JSON.parse(body)) } catch (err) { reject(err) }
        })
      })
      req.on('timeout', () => req.destroy(new Error(`docker ${path}: sin respuesta en ${timeoutMs}ms`)))
      req.on('error', reject)
      req.end()
    })
  }

  return {
    listContainers ({ label } = {}) {
      const filters = label ? `&filters=${encodeURIComponent(JSON.stringify({ label: [label] }))}` : ''
      return get(`/containers/json?all=1${filters}`)
    },
    inspect: (id) => get(`/containers/${encodeURIComponent(id)}/json`),
    // one-shot: una sola lectura, sin esperar el segundo muestreo de CPU que
    // la API hace por defecto (~1 s por contenedor).
    stats: (id) => get(`/containers/${encodeURIComponent(id)}/stats?stream=false&one-shot=true`),
    /**
     * Ultimas lineas del log de un contenedor, stdout y stderr intercalados.
     * Se devuelven en crudo: quien las envie fuera del nodo debe enmascararlas.
     */
    async logs (id, { tail = 30 } = {}) {
      const buf = await get(`/containers/${encodeURIComponent(id)}/logs?stdout=1&stderr=1&tail=${tail}`, { binary: true })
      return demuxLogs(buf)
    },
    /**
     * Muertes de contenedores (die, oom) en un intervalo cerrado. Con `until`
     * la API responde y cierra en lugar de quedarse transmitiendo.
     */
    async deaths ({ since, until, label }) {
      const filters = { type: ['container'], event: ['die', 'oom'], ...(label ? { label: [label] } : {}) }
      const body = await get(`/events?since=${since}&until=${until}&filters=${encodeURIComponent(JSON.stringify(filters))}`, { raw: true })
      return body.split('\n').filter(Boolean).map((l) => JSON.parse(l))
    }
  }
}

/**
 * Separa el flujo multiplexado de `docker logs` de un contenedor sin TTY: cada
 * trama lleva 8 bytes de cabecera (tipo de flujo, 3 de relleno, longitud en
 * big-endian) y luego el contenido. Un contenedor con TTY envia texto plano, lo
 * que se detecta porque el primer byte no es un tipo de flujo valido.
 *
 * @param {Buffer} buf
 * @returns {string}
 */
export function demuxLogs (buf) {
  if (buf.length < 8 || buf[0] > 2 || buf[1] !== 0 || buf[2] !== 0 || buf[3] !== 0) return buf.toString('utf8')
  const parts = []
  let i = 0
  while (i + 8 <= buf.length) {
    const size = buf.readUInt32BE(i + 4)
    parts.push(buf.subarray(i + 8, i + 8 + size))
    i += 8 + size
  }
  return Buffer.concat(parts).toString('utf8')
}

export function parseDockerHost (dockerHost) {
  if (dockerHost.startsWith('unix://')) return { socketPath: dockerHost.slice('unix://'.length) }
  const url = new URL(dockerHost.replace(/^tcp:/, 'http:'))
  return { host: url.hostname, port: Number(url.port) }
}

/**
 * Traduce la salida de inspect a un resultado de chequeo. Funcion pura.
 *
 * Un contenedor esta sano si corre y su healthcheck, si lo tiene, no reporta
 * `unhealthy`. Un contenedor `restarting` cuenta como fallo: un bucle de
 * reinicios es una caida intermitente que `docker ps` disfraza de actividad.
 * `starting` no cuenta como fallo, porque el healthcheck aun no ha concluido.
 */
export function containerCheck (info) {
  const state = info.State ?? {}
  const health = state.Health?.Status ?? null
  const running = state.Running === true && state.Restarting !== true
  const ok = running && health !== 'unhealthy'

  let detail
  if (state.Restarting) detail = `reiniciando (reinicios: ${info.RestartCount ?? 0})`
  else if (!state.Running) detail = `detenido (${state.Status ?? 'desconocido'}, codigo ${state.ExitCode ?? '?'})`
  else if (health === 'unhealthy') detail = `healthcheck fallando: ${lastHealthOutput(state.Health)}`
  else detail = health ? `en ejecucion (${health})` : 'en ejecucion'

  return {
    id: String(info.Id ?? '').slice(0, 12),
    name: String(info.Name ?? '').replace(/^\//, ''),
    image: info.Config?.Image ?? null,
    ok,
    state: state.Status ?? null,
    health,
    restartCount: info.RestartCount ?? 0,
    exitCode: state.Running ? null : (state.ExitCode ?? null),
    oomKilled: state.OOMKilled === true,
    detail
  }
}

/**
 * Evalua los reinicios de un contenedor. Funcion pura.
 *
 * Un contenedor que se cae y Docker reinicia en un segundo aparece "running" en
 * ambas lecturas: sin comparar el contador de reinicios, la caida pasaria
 * inadvertida. Tampoco basta con marcar el fallo en el ciclo en que ocurrio: un
 * bucle de reinicios alterna "reinicio" y "corriendo", y la maquina de estados,
 * que exige fallos consecutivos, nunca lo declararia caido. Dos reglas:
 *
 *   - un reinicio aislado falla durante `recentMs`: degrada, no tumba;
 *   - dos o mas reinicios dentro de `loopWindowMs` son un bucle: falla sostenida
 *     hasta que pase la ventana sin reinicios.
 *
 * @param {{ restartCount?: number, restarts?: {at: number, oom: boolean, exitCode: number|null}[] }} prev
 * @param {object} check resultado de containerCheck, con `oomKilled` y `lastExitCode`
 * @param {{ now: number, recentMs: number, loopWindowMs: number }} opts
 * @returns {object} el chequeo, con `restarts` para el ciclo siguiente
 */
export function detectRestart (prev, check, { now, recentMs, loopWindowMs }) {
  const known = prev.restartCount !== undefined
  const restarted = known && check.restartCount > prev.restartCount
  const restarts = (prev.restarts ?? []).filter((r) => now - r.at < loopWindowMs).map((r) => ({ ...r }))
  const cause = { oom: check.oomKilled === true, exitCode: check.lastExitCode ?? null }
  if (restarted) {
    restarts.push({ at: now, ...cause })
  } else if (restarts.length && (cause.oom || cause.exitCode !== null)) {
    // El evento de la muerte puede llegar un ciclo despues que el reinicio (cae
    // justo en el borde del intervalo consultado): se completa la causa.
    const last = restarts[restarts.length - 1]
    if (!last.oom && last.exitCode === null) Object.assign(last, cause)
  }

  const last = restarts[restarts.length - 1]
  const loop = restarts.length >= 2
  if (!last || (!loop && now - last.at >= recentMs)) return { ...check, restarts }

  const why = last.oom
    ? ' por falta de memoria (OOM, codigo 137)'
    : (last.exitCode != null ? ` tras salir con codigo ${last.exitCode}` : '')
  const detail = loop
    ? `bucle de reinicios: ${restarts.length} en ${Math.round(loopWindowMs / 1000)}s` + (why ? `; el ultimo${why}` : '')
    : `se reinicio${why}, hace ${Math.round((now - last.at) / 1000)}s`
  return { ...check, ok: false, restarts, detail }
}

/**
 * Porcentaje de memoria usada respecto del limite del contenedor, a partir de
 * la salida de stats. Funcion pura. Descuenta la cache inactiva, con el mismo
 * criterio que `docker stats`. Null si el contenedor no tiene datos.
 */
export function memoryPercent (stats) {
  const used = memoryUsedBytes(stats)
  const limit = stats?.memory_stats?.limit
  if (used === null || !limit) return null
  return Math.round((used / limit) * 10000) / 100
}

/** Memoria usada en bytes, sin la cache inactiva. Null si no hay datos. */
export function memoryUsedBytes (stats) {
  const m = stats?.memory_stats
  if (!m?.usage) return null
  const inactive = m.stats?.inactive_file ?? m.stats?.total_inactive_file ?? 0
  return Math.max(0, m.usage - inactive)
}

function lastHealthOutput (health) {
  const log = health?.Log ?? []
  const last = log[log.length - 1]
  return String(last?.Output ?? 'sin salida').trim().slice(0, 200)
}

/**
 * Lista los contenedores y los inspecciona en paralelo. Un contenedor que
 * desaparece entre la lista y el inspect (404) se omite: fue eliminado, no se
 * cayo.
 *
 * @param {ReturnType<typeof createDockerClient>} client
 * @param {{ label?: string|null }} [opts]
 */
export async function collectContainers (client, { label, since, until } = {}) {
  const list = await client.listContainers({ label: label ?? undefined })

  // La marca OOMKilled de inspect se borra al reiniciar: la causa de una
  // muerte solo sobrevive en los eventos. Una consulta por ciclo para todos.
  const death = new Map()
  if (since !== undefined) {
    try {
      for (const e of await client.deaths({ since, until, label })) {
        const d = death.get(e.Actor?.ID) ?? { oom: false, exitCode: null }
        if (e.Action === 'oom') d.oom = true
        if (e.Action === 'die') d.exitCode = Number(e.Actor?.Attributes?.exitCode ?? NaN)
        if (Number.isNaN(d.exitCode)) d.exitCode = null
        death.set(e.Actor?.ID, d)
      }
    } catch {}
  }

  const results = await Promise.allSettled(list.map(async (c) => {
    const info = await client.inspect(c.Id)
    const check = containerCheck(info)
    const d = death.get(info.Id)
    if (d) {
      check.oomKilled = check.oomKilled || d.oom
      check.lastExitCode = d.exitCode ?? (d.oom ? 137 : null)
    }
    // La memoria es comportamiento de la aplicacion: una fuga se ve subir
    // hacia el limite antes del OOM. Un fallo al leer stats no invalida el
    // chequeo del contenedor.
    // Sin limite propio, stats reporta como limite la RAM del anfitrion y el
    // porcentaje saldria cercano a cero: se informa solo el uso en bytes.
    let memPercent = null
    let memBytes = null
    if (check.state === 'running') {
      try {
        const stats = await client.stats(c.Id)
        memBytes = memoryUsedBytes(stats)
        if (info.HostConfig?.Memory > 0) memPercent = memoryPercent(stats)
      } catch {}
    }
    return { ...check, memPercent, memBytes }
  }))
  const checks = []
  for (const r of results) {
    if (r.status === 'fulfilled') checks.push(r.value)
    else if (!/respondio 404/.test(r.reason?.message)) throw r.reason
  }
  return checks.sort((a, b) => a.name.localeCompare(b.name))
}
