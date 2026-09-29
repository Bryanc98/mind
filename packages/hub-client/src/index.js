/**
 * Envio de reportes al Hub, con cola en disco para sobrevivir cortes de red.
 *
 * El agente solo inicia conexiones de salida (ADR 0002). Si el Hub no
 * responde, el reporte se guarda en disco y se reenvia en orden cuando vuelve
 * la conectividad, de modo que un corte de red no borra la historia de lo que
 * paso durante el corte, que suele ser justo lo que se quiere ver despues.
 */

import { mkdirSync, readFileSync, writeFileSync, appendFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Cola FIFO acotada, persistida como NDJSON.
 *
 * Al alcanzar `max` se descartan los mas antiguos: con el disco lleno, perder
 * el reporte de hace tres dias es preferible a perder el de ahora. La
 * escritura del archivo completo usa tmp + rename, que es atomico en POSIX: un
 * corte de luz a mitad deja la version vieja o la nueva, nunca media.
 *
 * @param {{ dir: string, max: number }} opts
 */
export function createDiskQueue ({ dir, max }) {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'queue.ndjson')
  let items = load(file)
  let dropped = 0

  if (items.length > max) {
    dropped += items.length - max
    items = items.slice(-max)
    rewrite()
  }

  function rewrite () {
    const tmp = `${file}.tmp`
    writeFileSync(tmp, items.map((i) => JSON.stringify(i) + '\n').join(''))
    renameSync(tmp, file)
  }

  return {
    push (item) {
      items.push(item)
      if (items.length > max) {
        dropped += items.length - max
        items = items.slice(-max)
        rewrite()
      } else {
        appendFileSync(file, JSON.stringify(item) + '\n')
      }
    },
    peek: (n) => items.slice(0, n),
    shift (n) {
      items = items.slice(n)
      rewrite()
    },
    size: () => items.length,
    /** Devuelve y reinicia la cuenta de descartados, para loguearla una vez. */
    takeDropped () {
      const d = dropped
      dropped = 0
      return d
    }
  }
}

function load (file) {
  let text
  try { text = readFileSync(file, 'utf8') } catch { return [] }
  const items = []
  for (const line of text.split('\n')) {
    if (!line) continue
    // Una linea truncada por un corte de luz se descarta; no invalida el resto.
    try { items.push(JSON.parse(line)) } catch {}
  }
  return items
}

export class HubRejectedError extends Error {}

/**
 * @param {{
 *   url: string, token: string, queue: ReturnType<typeof createDiskQueue>,
 *   logger: object, fetch?: typeof fetch, timeoutMs?: number, flushMax?: number
 * }} opts
 */
export function createHubClient ({ url, token, queue, logger, fetch = globalThis.fetch, timeoutMs = 5000, flushMax = 50 }) {
  const endpoint = new URL('/api/v1/reports', url).toString()

  async function post (report) {
    let res
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(report),
        signal: AbortSignal.timeout(timeoutMs)
      })
    } catch (err) {
      return { ok: false, retry: true, reason: err.cause?.code ?? err.name ?? err.message }
    }
    await res.body?.cancel().catch(() => {})
    if (res.ok) return { ok: true }
    // 408 y 429 son transitorios. Cualquier otro 4xx es un rechazo definitivo
    // (token revocado, reporte invalido): reintentarlo solo llenaria la cola.
    const transient = res.status >= 500 || res.status === 408 || res.status === 429
    return { ok: false, retry: transient, reason: `HTTP ${res.status}` }
  }

  return {
    /**
     * Envia el reporte. Si hay pendientes, se encola al final y se vacia la
     * cola en orden: un reporte nuevo nunca adelanta a uno viejo.
     * @returns {Promise<{ sent: number, pending: number }>}
     */
    async send (report) {
      if (queue.size() === 0) {
        const r = await post(report)
        if (r.ok) return { sent: 1, pending: 0 }
        if (!r.retry) {
          logger.error('el Hub rechazo el reporte', { motivo: r.reason })
          return { sent: 0, pending: 0 }
        }
        queue.push(report)
        logger.warn('Hub no disponible, reporte guardado en la cola local', { motivo: r.reason, pendientes: queue.size() })
        return { sent: 0, pending: queue.size() }
      }

      queue.push(report)
      const dropped = queue.takeDropped()
      if (dropped) logger.warn('cola local llena, se descartaron los reportes mas antiguos', { descartados: dropped })

      // Se limita el vaciado por tick para que un backlog grande no convierta
      // un tick en varios minutos de envios.
      let sent = 0
      for (const item of queue.peek(flushMax)) {
        const r = await post(item)
        if (!r.ok && r.retry) break
        if (!r.ok) logger.error('el Hub rechazo un reporte encolado, se descarta', { motivo: r.reason })
        queue.shift(1)
        if (r.ok) sent++
      }
      if (sent > 0) logger.info('cola local reenviada', { enviados: sent, pendientes: queue.size() })
      return { sent, pending: queue.size() }
    }
  }
}
