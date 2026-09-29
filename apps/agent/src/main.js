#!/usr/bin/env node
/**
 * Punto de entrada del M.I.N.D. Agent.
 *
 * Este archivo es el cableado del agente: no calcula ni decide nada por si
 * mismo, delega en los modulos. Toda la logica vive en funciones puras y
 * testeables, y los efectos (reloj, stdout, senales del sistema, red) se
 * concentran aqui. Ese reparto es lo que permite probar la mayor parte del
 * proyecto sin levantar infraestructura.
 */

import process from 'node:process'
import { loadConfig, ConfigError, createLogger, createLoop, initialState, nextState } from '@mind/agent-core'
import { sampleOs } from '@mind/collectors-os'
import { createDockerClient, collectContainers, detectRestart } from '@mind/collectors-docker'
import { collectHttp } from '@mind/collectors-http'
import { buildReport } from '@mind/protocol'
import { createDiskQueue, createHubClient } from '@mind/hub-client'
import pkg from '../package.json' with { type: 'json' }
import { pruneContainers } from './targets.js'

// ---------------------------------------------------------------------------
// 1. Configuracion. Si algo esta mal, morimos AQUI, antes de hacer nada.
// ---------------------------------------------------------------------------
let cfg
try {
  cfg = loadConfig(process.env)
} catch (err) {
  if (err instanceof ConfigError) {
    // 78 = EX_CONFIG en sysexits.h. Permite distinguir en el journal una
    // configuracion invalida de una caida del proceso.
    process.stderr.write(err.message + '\n')
    process.exit(78)
  }
  throw err
}

const log = createLogger({ level: cfg.logLevel, base: { node: cfg.nodeName } })

// ---------------------------------------------------------------------------
// 2. Estado en memoria: una maquina de estados por objetivo. El host es un
//    objetivo mas; cada contenedor tiene la suya, independiente de las demas.
// ---------------------------------------------------------------------------
const HOST_ID = 'host'
const targets = new Map([[HOST_ID, { kind: 'host', name: cfg.nodeName, health: initialState(), detail: null }]])

const docker = cfg.dockerHost ? createDockerClient(cfg.dockerHost) : null

// En modo hub, los reportes que no se pueden entregar esperan en disco.
const hub = cfg.mode === 'hub'
  ? createHubClient({
    url: cfg.hubUrl,
    token: cfg.serverToken,
    queue: createDiskQueue({ dir: cfg.bufferDir, max: cfg.bufferMax }),
    logger: log,
    // Un Hub inalcanzable no debe estirar el tick mucho mas alla del intervalo.
    timeoutMs: Math.min(5000, cfg.intervalMs)
  })
  : null

/** Aplica un resultado de chequeo a un objetivo y devuelve el evento, si lo hay. */
function evaluate (id, target, ok, detail, now, extra = {}) {
  const prev = target.health
  target.health = nextState(prev, { ok, at: now }, cfg)
  target.detail = detail
  Object.assign(target, extra)
  if (!target.health.changed) return null

  const tras = prev.since ? `${Math.round((now - prev.since) / 1000)}s` : 'desde el arranque'
  log.warn('cambio de estado', { objetivo: id, de: prev.status, a: target.health.status, tras, motivo: detail })
  return { target: id, from: prev.status, to: target.health.status, at: now, reason: detail }
}

// ---------------------------------------------------------------------------
// 3. El tick: una muestra, una decision.
// ---------------------------------------------------------------------------
async function tick () {
  const sample = await sampleOs({ sampleMs: 200 })
  const now = Date.now()
  const events = []

  // La salud del nodo se evalua contra sus umbrales de recursos.
  const breaches = []
  if (sample.cpuPercent >= cfg.cpuWarn) breaches.push(`cpu ${sample.cpuPercent}% >= ${cfg.cpuWarn}%`)
  if (sample.memory.usedPercent >= cfg.memWarn) breaches.push(`mem ${sample.memory.usedPercent}% >= ${cfg.memWarn}%`)
  const hostEvent = evaluate(
    HOST_ID,
    targets.get(HOST_ID),
    breaches.length === 0,
    breaches.length ? breaches.join('; ') : 'todos los umbrales dentro de rango',
    now
  )
  if (hostEvent) events.push(hostEvent)

  // Aplicaciones por HTTP: la senal mas cercana a lo que ve el usuario, y la
  // misma para una app en contenedor, en IIS o en cualquier otro servidor web.
  // Los sondeos corren en paralelo con la muestra de contenedores.
  const httpChecks = cfg.httpTargets.length
    ? collectHttp(cfg.httpTargets, { timeoutMs: cfg.httpTimeoutMs, slowMs: cfg.httpSlowMs })
    : Promise.resolve([])

  // Contenedores. Un fallo al consultar Docker no afecta al chequeo del host:
  // se registra y los contenedores conservan su ultimo estado conocido.
  if (docker) {
    try {
      const nowSec = Math.floor(now / 1000)
      const checks = await collectContainers(docker, {
        label: cfg.dockerLabel,
        // Eventos desde el ciclo anterior, con margen para no perder ninguno.
        since: nowSec - Math.ceil((2 * cfg.intervalMs) / 1000),
        until: nowSec
      })
      const seen = new Set()
      for (const raw of checks) {
        const id = `container:${raw.name}`
        seen.add(id)
        if (!targets.has(id)) targets.set(id, { kind: 'container', name: raw.name, health: initialState(), detail: null })
        const target = targets.get(id)
        const c = detectRestart(target, raw, {
          now,
          recentMs: 3 * cfg.intervalMs,
          loopWindowMs: Math.max(60_000, 10 * cfg.intervalMs)
        })
        const ev = evaluate(id, target, c.ok, c.detail, now, {
          restartCount: c.restartCount, restarts: c.restarts, memPercent: c.memPercent, memBytes: c.memBytes
        })
        if (ev) events.push(ev)
      }
      // Un contenedor eliminado deja de ser objetivo; no es una caida.
      pruneContainers(targets, seen)
    } catch (err) {
      log.error('no se pudo consultar Docker', { err: err.message })
    }
  }

  for (const c of await httpChecks) {
    const id = `http:${c.name}`
    if (!targets.has(id)) targets.set(id, { kind: 'http', name: c.name, health: initialState(), detail: null })
    const ev = evaluate(id, targets.get(id), c.ok, c.detail, now, { latencyMs: c.latencyMs, httpStatus: c.httpStatus })
    if (ev) events.push(ev)
  }

  const host = targets.get(HOST_ID).health
  log.info('muestra', {
    status: host.status,
    cpu: sample.cpuPercent,
    mem: sample.memory.usedPercent,
    scope: sample.scope,
    loadAvg1m: Number(sample.loadAvg1m.toFixed(2)),
    fallos: host.consecutiveFailures,
    aplicaciones: cfg.httpTargets.length,
    contenedores: [...targets.values()].filter((t) => t.kind === 'container').length
  })

  // Modo hub: el agente solo recolecta y envia. La alerta y el diagnostico
  // viven en el Hub (ADR 0003).
  if (hub) {
    const report = buildReport({
      node: cfg.nodeName,
      agentVersion: pkg.version,
      intervalMs: cfg.intervalMs,
      now,
      sample,
      targets: [...targets].map(([id, t]) => ({
        id,
        kind: t.kind,
        name: t.name,
        status: t.health.status,
        since: t.health.since,
        consecutiveFailures: t.health.consecutiveFailures,
        detail: t.detail,
        ...(t.kind === 'http' ? { latencyMs: t.latencyMs, httpStatus: t.httpStatus } : {}),
        ...(t.kind === 'container' ? { memPercent: t.memPercent, memBytes: t.memBytes, restartCount: t.restartCount } : {})
      })),
      events
    })
    await hub.send(report)
  }
}

// ---------------------------------------------------------------------------
// 4. El bucle.
// ---------------------------------------------------------------------------
const loop = createLoop({ intervalMs: cfg.intervalMs, tick, logger: log })

// ---------------------------------------------------------------------------
// 5. Apagado ordenado: termina el tick en vuelo antes de salir, de modo que
//    SIGTERM no interrumpa un envio a medias.
// ---------------------------------------------------------------------------
let shuttingDown = false
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    // Una segunda senal fuerza la salida inmediata, segun la convencion
    // habitual para operadores.
    if (shuttingDown) {
      log.warn('segunda senal recibida, salida forzada', { signal })
      process.exit(130)
    }
    shuttingDown = true
    log.info('senal recibida, apagando ordenadamente', { signal })
    loop.stop().then(() => {
      log.info('agente detenido')
      process.exit(0)
    })
  })
}

// Red de seguridad: si algo escapo al manejo de errores del bucle, se registra
// con contexto y se termina para que el supervisor reinicie en estado limpio.
// Un agente en un estado inconsistente es peor que uno detenido: la detencion
// la detecta el dead man's switch del Hub, la inconsistencia no.
process.on('uncaughtException', (err) => {
  log.error('excepcion no capturada', { err: err.message, stack: err.stack })
  process.exit(1)
})
process.on('unhandledRejection', (reason) => {
  log.error('promesa rechazada sin manejar', { reason: String(reason) })
  process.exit(1)
})

log.info('agente iniciado', {
  version: pkg.version,
  modo: cfg.mode,
  docker: cfg.dockerHost ? 'activo' : 'inactivo',
  aplicaciones: cfg.httpTargets.map((t) => t.name),
  intervalMs: cfg.intervalMs,
  umbrales: { cpu: cfg.cpuWarn, mem: cfg.memWarn },
  pid: process.pid
})
loop.start()
