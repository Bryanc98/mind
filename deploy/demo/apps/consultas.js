/**
 * Aplicacion de consultas instalada directamente en el servidor, sin
 * contenedor propio: solo se puede observar por su URL, igual que un sitio en
 * IIS. Cada consulta hace trabajo de CPU real; con mucho trafico concurrente
 * las peticiones hacen cola y la latencia sube.
 */
import http from 'node:http'
import { pbkdf2Sync } from 'node:crypto'

const ITERATIONS = Number(process.env.ITERATIONS ?? 60000)
const PORT = Number(process.env.PORT ?? 8081)

http.createServer((req, res) => {
  if (req.url === '/healthz') { res.end('ok'); return }
  pbkdf2Sync('consulta', 'sal', ITERATIONS, 32, 'sha256')
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ resultados: 7 }))
}).listen(PORT)
