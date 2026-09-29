/**
 * Configuracion del Hub desde el entorno. Mismo criterio que el agente:
 * se valida al arrancar y se reportan todos los problemas de una vez.
 */
import { ConfigError } from '@mind/agent-core'

export function loadHubConfig (env = process.env) {
  const problems = []
  const raw = (k) => (env[k] === undefined || String(env[k]).trim() === '' ? undefined : String(env[k]).trim())
  const int = (k, fallback, min, max) => {
    const v = raw(k)
    if (v === undefined) return fallback
    const n = Number(v)
    if (!Number.isInteger(n) || n < min || n > max) {
      problems.push(`${k}="${v}" debe ser un entero entre ${min} y ${max}`)
      return fallback
    }
    return n
  }

  const databaseUrl = raw('MIND_HUB_DATABASE_URL') ?? null
  const memory = raw('MIND_HUB_STORE') === 'memory'
  if (!databaseUrl && !memory) {
    problems.push('MIND_HUB_DATABASE_URL es obligatoria (o MIND_HUB_STORE=memory para pruebas)')
  }
  const logLevel = raw('MIND_HUB_LOG_LEVEL') ?? 'info'
  if (!['debug', 'info', 'warn', 'error'].includes(logLevel)) problems.push(`MIND_HUB_LOG_LEVEL="${logLevel}" no es valido`)

  const cfg = {
    databaseUrl,
    store: memory ? 'memory' : 'postgres',
    host: raw('MIND_HUB_HOST') ?? '0.0.0.0',
    port: int('MIND_HUB_PORT', 8080, 1, 65535),
    logLevel,
    staleFactor: int('MIND_HUB_STALE_FACTOR', 3, 2, 100),
    sweepMs: int('MIND_HUB_SWEEP_MS', 5000, 1000, 600000),
    rateLimitPerMin: int('MIND_HUB_RATE_LIMIT', 600, 1, 1000000)
  }
  if (problems.length) throw new ConfigError(problems)
  return Object.freeze(cfg)
}
