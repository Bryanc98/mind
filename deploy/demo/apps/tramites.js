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
// Credencial de ejemplo, solo de la demostracion. Aparece en los logs de error
// como en tantas aplicaciones reales: el agente debe enmascararla antes de que
// el log salga del servidor.
const DB_URL = `postgres://tramites:Tr4m1t3s-2026@${process.env.DB_HOST ?? 'db-tramites'}:${process.env.DB_PORT ?? 5432}/tramites`
const USERS = [['ana.perez@example.com', '001-1234567-8'], ['luis.gomez@example.com', '402-7654321-0']]
const ts = () => new Date().toISOString()
let served = 0

/** @returns {Promise<string|null>} null si la base responde; si no, el codigo del error */
function dbError () {
  return new Promise((resolve) => {
    const s = net.connect({ host: DB_HOST, port: DB_PORT, timeout: 400 })
    const done = (err) => { s.destroy(); resolve(err) }
    s.once('connect', () => done(null))
    s.once('timeout', () => done('ETIMEDOUT'))
    s.once('error', (e) => done(e.code ?? e.message))
  })
}

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

http.createServer(async (req, res) => {
  if (req.url === '/healthz') return json(res, 200, { ok: true })
  const [email, cedula] = USERS[served++ % USERS.length]
  const err = await dbError()
  if (err) {
    console.error(`${ts()} ERROR GET ${req.url} -> 503: no se pudo conectar a ${DB_URL} (${err}); solicitud de ${email}, cedula ${cedula}`)
    return json(res, 503, { error: 'base de datos no disponible' })
  }
  if (Math.random() < ERROR_RATE) {
    console.error(`${ts()} ERROR GET ${req.url} -> 500: TypeError: Cannot read properties of undefined (reading 'estado') en expediente ${4000 + (served % 900)}`)
    return json(res, 500, { error: 'error intermitente' })
  }
  if (served % 50 === 0) console.log(`${ts()} INFO ${served} solicitudes atendidas`)
  setTimeout(() => json(res, 200, { tramites: 42 }), 15 + Math.random() * 45)
}).listen(3000, () => console.log(`${ts()} INFO tramites escuchando en :3000, base de datos ${DB_HOST}:${DB_PORT}`))
