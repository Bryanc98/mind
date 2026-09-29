/**
 * Bucle de ejecucion periodica con apagado ordenado.
 *
 * Tres propiedades que un demonio de larga duracion necesita:
 *
 * 1. Sin solapamiento. Se usa un `setTimeout` que se re-agenda cuando el tick
 *    TERMINA, no un `setInterval`. Con setInterval, un tick mas lento que el
 *    intervalo acumula ejecuciones en paralelo: sube la memoria, se agotan las
 *    conexiones y las metricas se duplican. Re-agendar al terminar hace que el
 *    solapamiento sea imposible por construccion en vez de un caso a detectar.
 *    El costo es que la cadencia se mide de fin a inicio, lo que resulta en un
 *    intervalo efectivo algo mayor al configurado; para telemetria es
 *    aceptable.
 *
 * 2. Tolerancia a fallos del tick. Una excepcion o un rechazo de promesa se
 *    captura y se registra, y el bucle continua. Un fallo al leer un objetivo
 *    no puede detener el monitoreo de los demas.
 *
 * 3. Apagado ordenado. `systemctl stop` y `docker stop` envian SIGTERM y
 *    esperan antes de recurrir a SIGKILL, que no se puede capturar. `stop()`
 *    cancela el temporizador y espera al tick en vuelo, de modo que no se
 *    interrumpe un envio a medias.
 */

/**
 * @param {{
 *   intervalMs: number,
 *   tick: () => Promise<void>|void,
 *   logger: { debug: Function, info: Function, warn: Function, error: Function }
 * }} opts
 * @returns {{ start: () => void, stop: () => Promise<void>, isRunning: () => boolean }}
 */
export function createLoop ({ intervalMs, tick, logger }) {
  let running = false
  let timer = null
  let inFlight = null

  async function run () {
    timer = null
    try {
      // El `await` es lo que convierte un rechazo de promesa en una excepcion
      // capturable; sin el, el rechazo escapa y termina el proceso.
      await tick()
    } catch (err) {
      logger.error('fallo en el tick', { err: err?.message ?? String(err), stack: err?.stack })
    }
    // Se re-agenda al terminar, no antes: el solapamiento es imposible por
    // construccion. No se llama a `timer.unref()`: el temporizador es lo que
    // mantiene vivo el proceso, y sin el Node saldria con codigo 0 tras el
    // primer tick, sin que el supervisor lo reinicie.
    if (running) timer = setTimeout(schedule, intervalMs)
  }

  function schedule () {
    inFlight = run().finally(() => { inFlight = null })
  }

  return {
    start () {
      if (running) return
      running = true
      logger.debug('bucle iniciado', { intervalMs })
      schedule()
    },

    async stop () {
      if (running) {
        running = false
        if (timer) clearTimeout(timer)
        timer = null
        logger.debug('bucle detenido')
      }
      if (inFlight) await inFlight
    },

    isRunning: () => running
  }
}
