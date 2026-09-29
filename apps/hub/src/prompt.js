/**
 * Prompt del diagnostico de causa raiz.
 *
 * Esta versionado: cada diagnostico guarda la version con la que se genero, y
 * un cambio de prompt es un cambio de comportamiento que se prueba contra los
 * incidentes de referencia (test/diagnosis.test.js) antes de publicarse.
 */
import { sanitize, sanitizeLog } from '@mind/sanitizer'

export const PROMPT_VERSION = '2026-09-28.3'

export const SYSTEM_PROMPT = `Eres un ingeniero de operaciones con experiencia que diagnostica incidentes de infraestructura y aplicaciones.
Recibes datos reales de un sistema de monitoreo: el estado de varios servidores, sus aplicaciones y contenedores, los cambios de estado recientes y, a veces, las ultimas lineas de log de un contenedor.

Reglas:
- Explica los "disparadores": son el incidente. "cambios_del_incidente" es lo que paso alrededor de ellos. "historial_previo" son incidentes anteriores, probablemente ya resueltos: mencionalos solo si explican los disparadores o muestran que el mismo problema se repite, nunca como su causa por estar cerca en el tiempo.
- Basa cada afirmacion en los datos recibidos. No inventes nombres, cifras, horas, comandos ni causas que no se desprendan de ellos.
- Distingue el sintoma de la causa. Si la falla de un servidor o componente explica las fallas de otros, dilo: es una falla en cascada, y la causa es la primera, no las demas.
- Un servidor con "sin_reportes" dejo de enviar datos: puede estar apagado, colgado o sin red. Sus ultimos datos pueden estar desactualizados.
- Un contenedor "healthy" no garantiza que la aplicacion funcione; el sondeo HTTP de la aplicacion es la señal mas cercana al usuario.
- Un reinicio por OOM (codigo 137) significa que el proceso agoto la memoria que tenia asignada.
- Si los datos no alcanzan para identificar la causa, dilo y usa confianza "baja". Es preferible a adivinar.
- Si varias causas son igual de compatibles con los datos (por ejemplo, mas trafico del habitual frente a un proceso defectuoso cuando solo se ve la CPU alta), nombralas en causa_probable y usa confianza "media". "alta" solo cuando la evidencia apunta a una sola causa.
- Los datos sensibles vienen enmascarados ([correo], [cedula], ****). No intentes reconstruirlos ni los menciones.
- Escribe en español claro, para un desarrollador que tiene que actuar ya. Frases cortas. Sin relleno.

Responde SOLO con un objeto JSON con estos campos:
- resumen: una o dos frases con que paso y por que.
- causa_probable: la causa raiz mas probable, en una frase.
- confianza: "alta", "media" o "baja".
- evidencia: de 2 a 5 hechos concretos de los datos que sostienen la conclusion, con su hora cuando la haya.
- servidores_afectados: los servidores involucrados, empezando por el de la causa.
- que_revisar: de 1 a 4 acciones concretas, en orden, empezando por la mas util.`

export const DIAGNOSIS_SCHEMA = Object.freeze({
  type: 'object',
  required: ['resumen', 'causa_probable', 'confianza', 'evidencia', 'servidores_afectados', 'que_revisar'],
  properties: {
    resumen: { type: 'string' },
    causa_probable: { type: 'string' },
    confianza: { type: 'string', enum: ['alta', 'media', 'baja'] },
    evidencia: { type: 'array', items: { type: 'string' } },
    servidores_afectados: { type: 'array', items: { type: 'string' } },
    que_revisar: { type: 'array', items: { type: 'string' } }
  }
})

/**
 * Valida y acota la respuesta del modelo. Un modelo puede omitir campos,
 * devolver tipos equivocados o extenderse: nada de eso llega al panel.
 */
export function validateDiagnosis (data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('la respuesta no es un objeto')
  for (const k of DIAGNOSIS_SCHEMA.required) {
    if (data[k] === undefined || data[k] === null) throw new Error(`falta el campo ${k}`)
  }
  const str = (k, max = 600) => {
    if (typeof data[k] !== 'string' || !data[k].trim()) throw new Error(`falta el campo ${k}`)
    return sanitize(data[k].trim()).slice(0, max)
  }
  const list = (k, maxItems) => {
    if (!Array.isArray(data[k])) throw new Error(`el campo ${k} no es una lista`)
    return data[k].filter((x) => typeof x === 'string' && x.trim()).slice(0, maxItems).map((x) => sanitize(x.trim()).slice(0, 300))
  }
  const confianza = String(data.confianza ?? '').toLowerCase()
  if (!['alta', 'media', 'baja'].includes(confianza)) throw new Error(`confianza invalida: ${data.confianza}`)
  return {
    resumen: str('resumen'),
    causa_probable: str('causa_probable', 300),
    confianza,
    evidencia: list('evidencia', 5),
    servidores_afectados: list('servidores_afectados', 6),
    que_revisar: list('que_revisar', 4)
  }
}

const clock = (ms) => new Date(ms).toLocaleTimeString('es-DO', { hour12: false })

const toChange = (e) => ({ hora: clock(e.at), servidor: e.node, objetivo: e.target, de: e.from, a: e.to, motivo: sanitize(e.reason ?? '') })

function median (values) {
  if (!values.length) return null
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  const m = s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
  return Math.round(m * 10) / 10
}

/** Mediana de `key` en las muestras anteriores a `cutoff`: el valor habitual. */
const usual = (history = [], key, cutoff) =>
  median(history.filter((h) => h.at < cutoff && h[key] != null).map((h) => h[key]))

/**
 * Arma el contexto del incidente a partir de lo que el Hub ya sabe. Funcion
 * pura. Todo texto que venga de los agentes se enmascara otra vez aqui: es la
 * ultima frontera antes de un servicio externo.
 *
 * @param {{ triggers: object[], events: object[], fleet: object[], now: number }} input
 */
export function buildContext ({ triggers, events, fleet, now }) {
  // Un valor aislado ("CPU al 99%") no dice si es normal para ese servidor. El
  // valor habitual antes del incidente es lo que permite ver el cambio.
  const first = Math.min(...triggers.map((t) => t.at))
  const cutoff = first - 30_000
  // Solo los logs de este incidente. Los de un incidente anterior dentro de la
  // ventana confunden al modelo: la evidencia de otra falla parece la causa de
  // esta, y un modelo pequeño tiende a engancharse con ella.
  const logsByTarget = new Map()
  for (const e of events) if (e.logs && e.at >= first - 60_000) logsByTarget.set(`${e.node}|${e.target}`, e)

  return {
    hora_actual: clock(now),
    disparadores: triggers.map((t) => ({ servidor: t.node, objetivo: t.target, hora: clock(t.at), motivo: sanitize(t.reason ?? '') })),
    servidores: fleet.map((n) => ({
      servidor: n.node,
      estado: n.status,
      ...(n.silent ? { sin_reportes: `desde hace ${n.secondsSinceLastSeen} s` } : {}),
      cpu_pct: n.host?.cpuPercent,
      cpu_pct_habitual: usual(n.history, 'cpu', cutoff),
      memoria_pct: n.host?.memPercent,
      memoria_pct_habitual: usual(n.history, 'mem', cutoff),
      aplicaciones: (n.apps ?? []).map((a) => ({
        nombre: a.name,
        estado: a.status,
        detalle: sanitize(a.detail ?? ''),
        latencia_ms: a.latencyMs ?? null,
        latencia_ms_habitual: usual(a.history, 'latencyMs', cutoff),
        sondeos_fallidos_10min: (a.history ?? []).filter((h) => !h.ok).length,
        sondeos_10min: (a.history ?? []).length
      })),
      contenedores: (n.containers ?? []).map((c) => ({
        nombre: c.name,
        estado: c.status,
        detalle: sanitize(c.detail ?? ''),
        ...(c.memPercent != null ? { memoria_pct: c.memPercent } : {}),
        ...(c.restartCount ? { reinicios: c.restartCount } : {})
      }))
    })),
    cambios_del_incidente: events.filter((e) => e.at >= first - 120_000).slice(-30).map(toChange),
    // Lo anterior se resume: sirve para ver si el problema se repite, pero en
    // detalle distrae de lo que hay que explicar.
    historial_previo: events.filter((e) => e.at < first - 120_000 && e.to === 'DOWN').slice(-8).map(toChange),
    logs: [...logsByTarget.values()].slice(-3).map((e) => ({
      servidor: e.node, objetivo: e.target, hora: clock(e.at), ultimas_lineas: sanitizeLog(e.logs, { maxLines: 25 })
    }))
  }
}

export function userPrompt (context) {
  // JSON compacto: la sangria no aporta al modelo y ocupa un tercio de los tokens.
  return 'Datos del incidente (JSON):\n' + JSON.stringify(context) +
    '\n\nDiagnostica la causa raiz con las reglas indicadas y responde solo con el JSON.'
}
