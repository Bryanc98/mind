/**
 * Registro de objetivos del agente: el host, cada aplicacion sondeada y cada
 * contenedor, cada uno con su propia maquina de estados.
 */

/**
 * Elimina los contenedores que ya no existen. Solo toca objetivos de tipo
 * contenedor: el host y las aplicaciones no dependen de lo que liste Docker,
 * y borrarlos reiniciaria su maquina de estados en cada ciclo.
 *
 * @param {Map<string, { kind: string }>} targets
 * @param {Set<string>} seenContainerIds ids de los contenedores vistos en este ciclo
 * @returns {string[]} ids eliminados
 */
export function pruneContainers (targets, seenContainerIds) {
  const removed = []
  for (const [id, t] of targets) {
    if (t.kind === 'container' && !seenContainerIds.has(id)) {
      targets.delete(id)
      removed.push(id)
    }
  }
  return removed
}
