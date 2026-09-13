/**
 * Logger estructurado en NDJSON: una linea JSON por evento.
 *
 * Un mensaje de texto libre solo lo lee un humano. Una linea JSON la consulta
 * `jq`, la indexa un agregador y la parsea systemd-journald sin necesidad de
 * expresiones regulares. En operaciones, los logs son datos.
 *
 * Implementacion minima y sin dependencias, suficiente para el agente. El Hub
 * usa `pino`, que ofrece el mismo formato con mejor rendimiento.
 */

export const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 })

export function createLogger ({ level = 'info', base = {}, out = process.stdout } = {}) {
  const threshold = LEVELS[level]
  if (threshold === undefined) {
    throw new Error(`nivel de log invalido: ${level}`)
  }

  const emit = (levelName) => (msg, fields = {}) => {
    if (LEVELS[levelName] < threshold) return
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level: levelName,
      msg,
      ...base,
      ...fields
    })
    out.write(line + '\n')
  }

  return {
    debug: emit('debug'),
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
    child: (extra) => createLogger({ level, base: { ...base, ...extra }, out })
  }
}
