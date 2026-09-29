/**
 * API de tramites. Depende de una base de datos que vive en OTRO servidor
 * (db-01): si ese servidor cae, esta API sigue corriendo pero responde 503.
 * Ademas tiene una tasa baja de errores intermitentes, como cualquier
 * aplicacion real, que no deberian generar alertas.
 *
 * La dependencia se comprueba abriendo una conexion TCP al puerto de la base
 * de datos en cada peticion: sin driver ni dependencias, pero la falla es real.
 */
import http from 'node:http'
import net from 'node:net'

const DB_HOST = process.env.DB_HOST ?? 'db-tramites'
const DB_PORT = Number(process.env.DB_PORT ?? 5432)
const ERROR_RATE = Number(process.env.ERROR_RATE ?? 0.04)

function dbReachable () {
  return new Promise((resolve) => {
    const s = net.connect({ host: DB_HOST, port: DB_PORT, timeout: 400 })
    const done = (ok) => { s.destroy(); resolve(ok) }
    s.once('connect', () => done(true))
    s.once('timeout', () => done(false))
    s.once('error', () => done(false))
  })
}

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

http.createServer(async (req, res) => {
  if (req.url === '/healthz') return json(res, 200, { ok: true })
  if (!(await dbReachable())) return json(res, 503, { error: 'base de datos no disponible' })
  if (Math.random() < ERROR_RATE) return json(res, 500, { error: 'error intermitente' })
  setTimeout(() => json(res, 200, { tramites: 42 }), 15 + Math.random() * 45)
}).listen(3000)
