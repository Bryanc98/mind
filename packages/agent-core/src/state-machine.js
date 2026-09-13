/**
 * Maquina de estados de salud de un objetivo monitoreado.
 *
 * Bajar de estado exige evidencia acumulada (N chequeos fallidos consecutivos);
 * recuperarse a UP ocurre con un solo chequeo exitoso. La asimetria es
 * deliberada y responde a que los costos son asimetricos: un falso "esta
 * caido" cuesta una llamada nocturna y credibilidad, mientras que un falso
 * "ya subio" se corrige en el siguiente ciclo sin consecuencias. Alertar al
 * primer fallo produce falsas alarmas por pausas de GC, reinicios de nginx o
 * hiccups de red, y un canal con falsas alarmas termina silenciado.
 *
 * Las transiciones son puras: no leen el reloj ni el entorno, no escriben
 * logs y no notifican. Reciben el estado anterior y un resultado de chequeo,
 * y devuelven un estado nuevo. Los efectos viven en el llamador, lo que
 * permite que la misma logica de decision corra identica en modo standalone
 * y en modo hub.
 */

export const STATES = Object.freeze({
  UNKNOWN: 'UNKNOWN', // aun no hay ninguna medicion
  UP: 'UP',
  DEGRADED: 'DEGRADED', // hay fallos, todavia no suficientes para declarar caida
  DOWN: 'DOWN'
})

/**
 * Estado de partida de un objetivo recien registrado. Arranca en UNKNOWN
 * porque asumir salud sin haber medido produce alertas falsas de caida en el
 * primer chequeo fallido tras el arranque.
 *
 * @returns {{ status: string, consecutiveFailures: number, since: number|null, changed: boolean }}
 */
export function initialState () {
  // TODO: implementar
  throw new Error('initialState: sin implementar')
}

/**
 * Calcula el estado siguiente a partir del anterior y un resultado de chequeo.
 *
 * `since` es el instante en que se entro al estado actual, no la ultima
 * medicion: permite reportar la duracion del incidente y sirve de base para
 * el cooldown de notificaciones. `changed` es lo que dispara la alerta, de
 * modo que un objetivo caido genera un aviso y no uno por ciclo.
 *
 * @param {{ status: string, consecutiveFailures: number, since: number|null }} prev
 * @param {{ ok: boolean, at: number }} check resultado del chequeo (at = epoch ms)
 * @param {{ failuresToDegrade: number, failuresToDown: number }} cfg
 * @returns {{ status: string, consecutiveFailures: number, since: number|null, changed: boolean }}
 */
export function nextState (prev, check, cfg) {
  // TODO: implementar. No mutar `prev`: devolver siempre un objeto nuevo.
  throw new Error('nextState: sin implementar')
}
