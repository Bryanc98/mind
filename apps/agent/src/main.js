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
// 2. Estado en memoria. Se persiste en un buffer en disco para sobrevivir a
//    un reinicio y a cortes de conectividad con el Hub.
// ---------------------------------------------------------------------------
let health = initialState()

// ---------------------------------------------------------------------------
// 3. El tick: una muestra, una decision.
// ---------------------------------------------------------------------------
async function tick () {
  const sample = await sampleOs({ sampleMs: 200 })

  // La salud del nodo se evalua contra sus umbrales de recursos. Los
  // colectores de contenedores y de HTTP se suman despues, cada objetivo con
  // su propia maquina de estados independiente.
  const breaches = []
  if (sample.cpuPercent >= cfg.cpuWarn) breaches.push(`cpu ${sample.cpuPercent}% >= ${cfg.cpuWarn}%`)
  if (sample.memory.usedPercent >= cfg.memWarn) breaches.push(`mem ${sample.memory.usedPercent}% >= ${cfg.memWarn}%`)

  const prev = health
  health = nextState(prev, { ok: breaches.length === 0, at: Date.now() }, cfg)

  log.info('muestra', {
    status: health.status,
    cpu: sample.cpuPercent,
    mem: sample.memory.usedPercent,
    loadAvg1m: Number(sample.loadAvg1m.toFixed(2)),
    fallos: health.consecutiveFailures
  })

  // Se notifica el cambio de estado, no cada medicion: un objetivo caido
  // genera un aviso, no uno por ciclo. Aqui entran el diagnostico por IA y el
  // envio de la alerta.
  if (health.changed) {
    const dur = prev.since ? `${Math.round((Date.now() - prev.since) / 1000)}s` : 'desde el arranque'
    log.warn('cambio de estado', {
      de: prev.status,
      a: health.status,
      tras: dur,
      motivo: breaches.length ? breaches.join('; ') : 'todos los umbrales dentro de rango'
    })
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
  modo: cfg.mode,
  intervalMs: cfg.intervalMs,
  umbrales: { cpu: cfg.cpuWarn, mem: cfg.memWarn },
  pid: process.pid
})
loop.start()
