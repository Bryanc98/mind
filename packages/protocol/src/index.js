/**
 * Contrato del reporte de telemetria que el agente envia al Hub.
 *
 * Es superficie publica (ADR 0007): los cambios son aditivos dentro de una
 * misma `schemaVersion`, y el Hub acepta la version vigente y la anterior. El
 * esquema JSON es la fuente de verdad; el Hub lo usa para validar cada peticion
 * antes de que llegue a la logica de negocio.
 */

export const SCHEMA_VERSION = 1

/** Versiones que el Hub acepta: la vigente y la inmediatamente anterior. */
export const SUPPORTED_SCHEMA_VERSIONS = Object.freeze([SCHEMA_VERSION - 1, SCHEMA_VERSION].filter((v) => v >= 1))

const STATUS = ['UNKNOWN', 'UP', 'DEGRADED', 'DOWN']
const nullableNumber = { type: ['number', 'null'] }
const shortString = (max = 200) => ({ type: 'string', maxLength: max })

const target = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'kind', 'name', 'status', 'consecutiveFailures'],
  properties: {
    id: shortString(),
    kind: { enum: ['host', 'container', 'http'] },
    name: shortString(),
    status: { enum: STATUS },
    since: nullableNumber,
    consecutiveFailures: { type: 'integer', minimum: 0 },
    detail: { type: ['string', 'null'], maxLength: 500 },
    // Solo en objetivos http: el comportamiento de la aplicacion.
    latencyMs: nullableNumber,
    httpStatus: { type: ['integer', 'null'] },
    // Solo en contenedores.
    memPercent: nullableNumber,
    memBytes: nullableNumber,
    restartCount: { type: ['integer', 'null'], minimum: 0 }
  }
}

const event = {
  type: 'object',
  additionalProperties: false,
  required: ['target', 'from', 'to', 'at'],
  properties: {
    target: shortString(),
    from: { enum: STATUS },
    to: { enum: STATUS },
    at: { type: 'number' },
    reason: { type: ['string', 'null'], maxLength: 500 }
  }
}

export const reportSchema = Object.freeze({
  $id: 'mind/report',
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'node', 'sentAt', 'intervalMs', 'host', 'targets', 'events'],
  properties: {
    schemaVersion: { type: 'integer' },
    node: { type: 'string', minLength: 1, maxLength: 128 },
    agentVersion: shortString(32),
    sentAt: { type: 'number' },
    intervalMs: { type: 'integer', minimum: 1000 },
    host: {
      type: 'object',
      additionalProperties: false,
      required: ['cpuPercent', 'memPercent'],
      properties: {
        cpuPercent: { type: 'number', minimum: 0, maximum: 100 },
        memPercent: { type: 'number', minimum: 0, maximum: 100 },
        memUsedBytes: nullableNumber,
        memTotalBytes: nullableNumber,
        loadAvg1m: nullableNumber,
        uptimeSec: nullableNumber,
        platform: shortString(32),
        scope: { enum: ['host', 'cgroup'] }
      }
    },
    targets: { type: 'array', maxItems: 500, items: target },
    events: { type: 'array', maxItems: 500, items: event }
  }
})

/**
 * Arma un reporte a partir de la muestra y del estado de cada objetivo.
 * Funcion pura: el reloj entra como argumento.
 *
 * @param {{ node: string, agentVersion: string, intervalMs: number, now: number,
 *   sample: object, targets: object[], events: object[] }} input
 */
export function buildReport ({ node, agentVersion, intervalMs, now, sample, targets, events }) {
  return {
    schemaVersion: SCHEMA_VERSION,
    node,
    agentVersion,
    sentAt: now,
    intervalMs,
    host: {
      cpuPercent: sample.cpuPercent,
      memPercent: sample.memory.usedPercent,
      memUsedBytes: sample.memory.usedBytes,
      memTotalBytes: sample.memory.totalBytes,
      loadAvg1m: Number(sample.loadAvg1m.toFixed(2)),
      uptimeSec: sample.uptimeSec,
      platform: sample.platform,
      scope: sample.scope ?? 'host'
    },
    targets,
    events
  }
}
