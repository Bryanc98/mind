#!/usr/bin/env node
/**
 * Punto de entrada del M.I.N.D. Hub.
 */
import process from 'node:process'
import { ConfigError, createLoop, createLogger } from '@mind/agent-core'
import { loadHubConfig } from './config.js'
import { openStore } from './store/index.js'
import { createHubService } from './service.js'
import { buildApp } from './app.js'
import { createProvider, createChain } from '@mind/ai-provider'
import { createDiagnoser } from './diagnosis.js'

let cfg
try {
  cfg = loadHubConfig(process.env)
} catch (err) {
  if (err instanceof ConfigError) {
    process.stderr.write(err.message + '\n')
    process.exit(78)
  }
  throw err
}

const log = createLogger({ level: cfg.logLevel, base: { svc: 'hub' } })

const store = await openStore(cfg, { logger: log })
// El diagnostico por IA es opcional: sin proveedor, el Hub funciona igual.
let diagnoser = null
const service = createHubService({
  store,
  staleFactor: cfg.staleFactor,
  onEvents: (events) => diagnoser?.observe(events)
})
if (cfg.ai.provider !== 'none') {
  const make = (provider, model) => createProvider({
    provider,
    model: model ?? undefined,
    ollamaUrl: cfg.ai.ollamaUrl,
    geminiApiKey: cfg.ai.geminiApiKey,
    timeoutMs: cfg.ai.timeoutMs
  })
  const provider = createChain([
    make(cfg.ai.provider, cfg.ai.model),
    ...cfg.ai.fallbacks.map((f) => make(f.provider, f.model))
  ])
  diagnoser = createDiagnoser({
    store,
    provider,
    fleet: () => service.fleet(),
    logger: log,
    delayMs: cfg.ai.delayMs,
    cooldownMs: cfg.ai.cooldownMs,
    dailyLimit: cfg.ai.dailyLimit
  })
  log.info('diagnostico por IA activo', { cadena: provider.chain })
}
const app = await buildApp({ service, logLevel: cfg.logLevel, rateLimitPerMin: cfg.rateLimitPerMin })

// El mismo bucle del agente, reutilizado para el dead man's switch.
const sweeper = createLoop({
  intervalMs: cfg.sweepMs,
  logger: log,
  tick: async () => {
    const { silenced } = await service.sweep()
    for (const node of silenced) log.warn('nodo sin reportes, declarado caido', { nodo: node })
  }
})

let shuttingDown = false
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    if (shuttingDown) process.exit(130)
    shuttingDown = true
    log.info('senal recibida, apagando ordenadamente', { signal })
    await sweeper.stop()
    await diagnoser?.stop()
    await app.close() // deja de aceptar conexiones y espera las peticiones en curso
    await store.close()
    log.info('hub detenido')
    process.exit(0)
  })
}

await app.listen({ host: cfg.host, port: cfg.port })
log.info('hub iniciado', { almacenamiento: cfg.store, puerto: cfg.port, staleFactor: cfg.staleFactor })
sweeper.start()
