/**
 * Generador de reportes con una fuga de memoria real: cada reporte generado
 * se guarda en una cache que nunca se vacia. Con trafico sobre /generar la
 * memoria sube hasta el limite del contenedor, el kernel mata el proceso
 * (OOM, codigo 137) y Docker lo reinicia.
 */
import http from 'node:http'

const cache = []
const MB_PER_REPORT = Number(process.env.MB_PER_REPORT ?? 3)

http.createServer((req, res) => {
  if (req.url === '/generar') {
    // Buffer.alloc escribe ceros: la memoria queda comprometida de verdad.
    cache.push(Buffer.alloc(MB_PER_REPORT * 1024 * 1024, 1))
    res.end(JSON.stringify({ generado: true, enCache: cache.length }))
    return
  }
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ ok: true }))
}).listen(3000)
