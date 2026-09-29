/**
 * Diagnostico de causa raiz por IA, disparado por las caidas.
 *
 * Controles, porque un modelo de lenguaje es caro, lento y a veces se equivoca:
 *   - Agrupacion: las caidas que llegan dentro de `delayMs` forman un solo
 *     incidente y un solo diagnostico. En una falla en cascada la causa y sus
 *     efectos llegan con segundos de diferencia; diagnosticarlos por separado
 *     daria tres respuestas parciales en vez de una completa.
 *   - Cooldown por servidor: un servidor que oscila no genera un diagnostico
 *     por oscilacion.
 *   - Techo diario: un error de configuracion no puede convertirse en una
 *     factura.
 *   - Validacion: la respuesta del modelo pasa por un esquema antes de guardarse.
 *
 * El diagnostico corre fuera del camino de la ingesta: un proveedor lento no
 * retrasa la recepcion de reportes.
 */
import { PROMPT_VERSION, SYSTEM_PROMPT, DIAGNOSIS_SCHEMA, validateDiagnosis, buildContext, userPrompt } from './prompt.js'

/**
 * @param {{
 *   store: object, provider: { name: string, model: string, generate: Function },
 *   fleet: () => Promise<object[]>, logger: object,
 *   delayMs?: number, cooldownMs?: number, dailyLimit?: number, windowMs?: number,
 *   now?: () => number, setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout
 * }} opts
 */
export function createDiagnoser ({
  store, provider, fleet, logger,
  delayMs = 5000, cooldownMs = 10 * 60 * 1000, dailyLimit = 50, windowMs = 10 * 60 * 1000,
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout
}) {
  let pending = null // { triggers: [], timer }
  const inFlight = new Set()
  const lastByNode = new Map()

  async function run (triggers) {
    const t = now()
    const startOfDay = new Date(t).setHours(0, 0, 0, 0)
    if (await store.countDiagnosesSince(startOfDay) >= dailyLimit) {
      logger.warn('techo diario de diagnosticos alcanzado, se omite', { limite: dailyLimit })
      return
    }
    for (const tr of triggers) lastByNode.set(tr.node, t)

    const id = await store.createDiagnosis({
      createdAt: t,
      status: 'pendiente',
      provider: provider.name,
      model: provider.model,
      promptVersion: PROMPT_VERSION,
      triggers
    })
    try {
      const first = Math.min(...triggers.map((x) => x.at))
      const [events, nodes] = await Promise.all([store.listEventsSince(first - windowMs), fleet()])
      const context = buildContext({ triggers, events, fleet: nodes, now: t })
      await store.updateDiagnosis(id, { status: 'pendiente', context })
      const r = await provider.generate({ system: SYSTEM_PROMPT, user: userPrompt(context), schema: DIAGNOSIS_SCHEMA })
      // Con una cadena de respaldo, quien respondio puede no ser el principal.
      await store.updateDiagnosis(id, {
        status: 'listo',
        result: validateDiagnosis(r.data),
        error: null,
        latencyMs: r.latencyMs,
        provider: r.provider ?? provider.name,
        model: r.model ?? provider.model
      })
      logger.info('diagnostico listo', { id, proveedor: r.provider ?? provider.name, modelo: r.model ?? provider.model, latencyMs: r.latencyMs, fallos: r.failures })
    } catch (err) {
      await store.updateDiagnosis(id, { status: 'error', result: null, error: err.message.slice(0, 500), latencyMs: null })
      logger.error('diagnostico fallido', { id, proveedor: provider.name, err: err.message })
    }
  }

  function track (promise) {
    inFlight.add(promise)
    promise.finally(() => inFlight.delete(promise))
    return promise
  }

  function fire () {
    const triggers = pending.triggers
    pending = null
    return track(run(triggers).catch((err) => logger.error('diagnostico: error inesperado', { err: err.message })))
  }

  return {
    /** Recibe los eventos recien registrados; solo las caidas disparan. */
    observe (events) {
      const t = now()
      for (const e of events) {
        if (e.to !== 'DOWN') continue
        const last = lastByNode.get(e.node)
        if (last !== undefined && t - last < cooldownMs) continue
        if (!pending) pending = { triggers: [], timer: setTimer(fire, delayMs) }
        pending.triggers.push({ node: e.node, target: e.target, at: e.at, reason: e.reason ?? null })
      }
    },
    /** Dispara ya el incidente pendiente y espera a que terminen todos. */
    async flush () {
      if (pending) {
        clearTimer(pending.timer)
        fire()
      }
      await Promise.all([...inFlight])
    },
    async stop () {
      if (pending) clearTimer(pending.timer)
      pending = null
      await Promise.all([...inFlight])
    }
  }
}
