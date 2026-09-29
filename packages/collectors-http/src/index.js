/**
 * Sondeo de aplicaciones por HTTP. Sin dependencias: `fetch` nativo.
 *
 * Es la senal mas cercana a lo que ve un usuario, y la unica que funciona igual
 * para cualquier forma de desplegar: una API en un contenedor, un sitio en IIS,
 * un WordPress en Apache. El estado del contenedor dice si el proceso existe;
 * el sondeo dice si la aplicacion responde, y en cuanto tiempo. Un contenedor
 * `healthy` puede estar devolviendo 500 o tardando diez segundos.
 *
 * El agente solo inicia la peticion (GET, sin cuerpo, sin credenciales): no
 * abre puertos ni cambia nada en la aplicacion (ADR 0002).
 */

/**
 * Traduce el resultado de una peticion a un resultado de chequeo. Funcion pura.
 *
 * Falla si: no hubo respuesta (red, DNS, timeout), el codigo no es 2xx/3xx, o
 * la respuesta tardo mas que `slowMs`. La lentitud cuenta como fallo porque
 * para el usuario una pagina que tarda diez segundos esta caida.
 *
 * @param {{ status?: number, latencyMs: number, error?: string }} r
 * @param {{ slowMs: number }} opts
 */
export function httpCheck (r, { slowMs }) {
  const latencyMs = Math.round(r.latencyMs)
  if (r.error) return { ok: false, httpStatus: null, latencyMs, detail: `sin respuesta: ${r.error}` }
  if (r.status >= 400) return { ok: false, httpStatus: r.status, latencyMs, detail: `HTTP ${r.status} en ${latencyMs} ms` }
  if (latencyMs > slowMs) return { ok: false, httpStatus: r.status, latencyMs, detail: `lenta: ${latencyMs} ms (limite ${slowMs} ms)` }
  return { ok: true, httpStatus: r.status, latencyMs, detail: `HTTP ${r.status} en ${latencyMs} ms` }
}

/**
 * Hace una peticion GET y mide la latencia hasta los encabezados de respuesta.
 * No sigue redirecciones: un 302 a la pagina de login es una respuesta valida
 * de la aplicacion, y seguirla mediria otra cosa.
 *
 * @param {string} url
 * @param {{ timeoutMs: number, fetch?: typeof fetch, now?: () => number }} opts
 */
export async function probe (url, { timeoutMs, fetch = globalThis.fetch, now = () => performance.now() }) {
  const t0 = now()
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'user-agent': 'mind-agent', accept: '*/*' },
      signal: AbortSignal.timeout(timeoutMs)
    })
    const latencyMs = now() - t0
    // El cuerpo no se lee: solo interesa el codigo y el tiempo.
    await res.body?.cancel().catch(() => {})
    return { status: res.status, latencyMs }
  } catch (err) {
    const latencyMs = now() - t0
    const reason = err.name === 'TimeoutError'
      ? `timeout tras ${timeoutMs} ms`
      : (err.cause?.code ?? err.cause?.message ?? err.message)
    return { error: reason, latencyMs }
  }
}

/**
 * Sondea todos los objetivos en paralelo. Un objetivo lento no retrasa a los
 * demas mas alla de su propio timeout.
 *
 * @param {{ name: string, url: string }[]} targets
 * @param {{ timeoutMs: number, slowMs: number, fetch?: typeof fetch }} opts
 */
export async function collectHttp (targets, { timeoutMs, slowMs, fetch }) {
  const results = await Promise.all(targets.map((t) => probe(t.url, { timeoutMs, fetch })))
  return targets.map((t, i) => ({ name: t.name, url: t.url, ...httpCheck(results[i], { slowMs }) }))
}
