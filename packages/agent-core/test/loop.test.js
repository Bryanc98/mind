import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createLoop } from '../src/loop.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Logger de prueba que solo registra las llamadas recibidas. */
function spyLogger () {
  const calls = { debug: [], info: [], warn: [], error: [] }
  const push = (lvl) => (msg, fields) => calls[lvl].push({ msg, fields })
  return { calls, debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') }
}

describe('createLoop - arranque y cadencia', () => {
  test('ejecuta el primer tick de inmediato, sin esperar intervalMs', async () => {
    // Un agente que arranca y no reporta durante todo un intervalo es
    // indistinguible de uno averiado.
    let n = 0
    const loop = createLoop({ intervalMs: 5000, tick: () => { n++ }, logger: spyLogger() })
    loop.start()
    await sleep(30)
    assert.equal(n, 1, 'debe haber corrido exactamente 1 vez (el intervalo es de 5s)')
    await loop.stop()
  })

  test('repite periodicamente', async () => {
    let n = 0
    const loop = createLoop({ intervalMs: 20, tick: () => { n++ }, logger: spyLogger() })
    loop.start()
    await sleep(150)
    await loop.stop()
    // Cotas amplias a proposito: los timers de JS no son de tiempo real y
    // un margen estrecho produce fallos intermitentes en CI.
    assert.ok(n >= 4 && n <= 12, `esperaba entre 4 y 12 ticks, hubo ${n}`)
  })

  test('llamar start() dos veces no duplica el bucle', async () => {
    let n = 0
    const loop = createLoop({ intervalMs: 5000, tick: () => { n++ }, logger: spyLogger() })
    loop.start()
    loop.start()
    await sleep(30)
    assert.equal(n, 1, 'el segundo start() debe ser no-op')
    await loop.stop()
  })

  test('el intervalo se mide desde el FIN del tick anterior', async () => {
    // Consecuencia de re-agendar con setTimeout en lugar de setInterval: con
    // ticks de 40ms e intervalo de 20ms el ciclo real es de ~60ms. Con
    // setInterval habria ~12 ticks solapados en 240ms.
    let n = 0
    const loop = createLoop({
      intervalMs: 20,
      tick: async () => { n++; await sleep(40) },
      logger: spyLogger()
    })
    loop.start()
    await sleep(240)
    await loop.stop()
    assert.ok(n <= 6, `esperaba <= 6 ticks (sin solapamiento), hubo ${n}`)
    assert.ok(n >= 2, `esperaba al menos 2 ticks, hubo ${n}`)
  })

  test('isRunning() refleja el ciclo de vida', async () => {
    const loop = createLoop({ intervalMs: 5000, tick: () => {}, logger: spyLogger() })
    assert.equal(loop.isRunning(), false, 'antes de start()')
    loop.start()
    assert.equal(loop.isRunning(), true, 'despues de start()')
    await loop.stop()
    assert.equal(loop.isRunning(), false, 'despues de stop()')
  })
})

describe('createLoop - resiliencia', () => {
  test('una excepcion sincrona en el tick no detiene el bucle', async () => {
    // Un fallo al leer un objetivo no puede detener el monitoreo de los
    // demas.
    let n = 0
    const logger = spyLogger()
    const loop = createLoop({
      intervalMs: 15,
      tick: () => { n++; throw new Error('disco lleno') },
      logger
    })
    loop.start()
    await sleep(120)
    await loop.stop()
    assert.ok(n >= 3, `el bucle debe seguir tras el fallo; solo corrio ${n} veces`)
    assert.ok(logger.calls.error.length >= 3, 'cada fallo debe loguearse en nivel error')
  })

  test('una promesa rechazada en el tick tampoco detiene el bucle', async () => {
    // Un rechazo no manejado termina el proceso en Node moderno, y no lo
    // captura un try/catch si falta el await.
    let n = 0
    const logger = spyLogger()
    const loop = createLoop({
      intervalMs: 15,
      tick: async () => { n++; throw new Error('hub no responde') },
      logger
    })
    loop.start()
    await sleep(120)
    await loop.stop()
    assert.ok(n >= 3, `el bucle debe seguir tras el rechazo; solo corrio ${n} veces`)
    assert.ok(logger.calls.error.length >= 3, 'cada rechazo debe loguearse en nivel error')
  })
})

describe('createLoop - apagado ordenado', () => {
  test('stop() espera a que termine el tick en vuelo', async () => {
    // Evita que `systemctl stop` o `docker stop` interrumpan un envio a
    // medias y recurran a SIGKILL al agotarse su tiempo de espera.
    let terminado = false
    const loop = createLoop({
      intervalMs: 5000,
      tick: async () => { await sleep(60); terminado = true },
      logger: spyLogger()
    })
    loop.start()
    await sleep(15) // el tick esta a mitad de camino
    await loop.stop()
    assert.equal(terminado, true, 'stop() resolvio antes de que el tick terminara')
  })

  test('despues de stop() no se ejecuta ningun tick mas', async () => {
    let n = 0
    const loop = createLoop({ intervalMs: 15, tick: () => { n++ }, logger: spyLogger() })
    loop.start()
    await sleep(80)
    await loop.stop()
    const despuesDeParar = n
    await sleep(80)
    assert.equal(n, despuesDeParar, 'el timer pendiente no se cancelo')
  })

  test('stop() es idempotente', async () => {
    const loop = createLoop({ intervalMs: 15, tick: () => {}, logger: spyLogger() })
    loop.start()
    await sleep(20)
    await loop.stop()
    await loop.stop() // no debe lanzar ni quedarse colgado
    assert.equal(loop.isRunning(), false)
  })
})
