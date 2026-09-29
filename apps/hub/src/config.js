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

  const aiProvider = raw('MIND_AI_PROVIDER') ?? 'none'
  if (!['none', 'ollama', 'gemini'].includes(aiProvider)) {
    problems.push(`MIND_AI_PROVIDER="${aiProvider}" debe ser none, ollama o gemini`)
  }
  const geminiApiKey = raw('MIND_AI_GEMINI_API_KEY') ?? null
  // Respaldo: "proveedor[:modelo],..." que se prueban en orden si el principal falla.
  const fallbacks = []
  for (const item of (raw('MIND_AI_FALLBACKS') ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const i = item.indexOf(':')
    const provider = i < 0 ? item : item.slice(0, i)
    const model = i < 0 ? null : (item.slice(i + 1) || null)
    if (!['ollama', 'gemini'].includes(provider)) {
      problems.push(`MIND_AI_FALLBACKS: "${item}" debe empezar por ollama o gemini`)
      continue
    }
    fallbacks.push({ provider, model })
  }
  const usesGemini = aiProvider === 'gemini' || (aiProvider !== 'none' && fallbacks.some((f) => f.provider === 'gemini'))
  if (usesGemini && !geminiApiKey) {
    problems.push('MIND_AI_GEMINI_API_KEY es obligatoria cuando se usa gemini')
  }

  const cfg = {
    databaseUrl,
    store: memory ? 'memory' : 'postgres',
    host: raw('MIND_HUB_HOST') ?? '0.0.0.0',
    port: int('MIND_HUB_PORT', 8080, 1, 65535),
    logLevel,
    staleFactor: int('MIND_HUB_STALE_FACTOR', 3, 2, 100),
    sweepMs: int('MIND_HUB_SWEEP_MS', 5000, 1000, 600000),
    rateLimitPerMin: int('MIND_HUB_RATE_LIMIT', 600, 1, 1000000),
    ai: {
      provider: aiProvider,
      model: raw('MIND_AI_MODEL') ?? null,
      fallbacks,
      ollamaUrl: raw('MIND_AI_OLLAMA_URL') ?? 'http://127.0.0.1:11434',
      geminiApiKey,
      delayMs: int('MIND_AI_DELAY_MS', 5000, 0, 600000),
      cooldownMs: int('MIND_AI_COOLDOWN_MS', 600000, 0, 86400000),
      dailyLimit: int('MIND_AI_DAILY_LIMIT', 50, 0, 100000),
      timeoutMs: int('MIND_AI_TIMEOUT_MS', 90000, 1000, 600000)
    }
  }
  if (problems.length) throw new ConfigError(problems)
  return Object.freeze(cfg)
}
