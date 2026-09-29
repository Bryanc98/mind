/**
 * Generador de reportes con una fuga de memoria real: cada reporte generado
 * se guarda en una cache que nunca se vacia. Con trafico sobre /generar la
 * memoria sube hasta el limite del contenedor, el kernel mata el proceso
 * (OOM, codigo 137) y Docker lo reinicia.
 */
import http from 'node:http'

const cache = []
const MB_PER_REPORT = Number(process.env.MB_PER_REPORT ?? 3)
const ts = () => new Date().toISOString()
const mb = (n) => Math.round(n / 1048576)

http.createServer((req, res) => {
  if (req.url === '/generar') {
    // Buffer.alloc escribe ceros: la memoria queda comprometida de verdad.
    cache.push(Buffer.alloc(MB_PER_REPORT * 1024 * 1024, 1))
    console.log(`${ts()} INFO reporte generado #${cache.length}; cache de reportes: ${cache.length * MB_PER_REPORT} MB en memoria, rss ${mb(process.memoryUsage().rss)} MB`)
    res.end(JSON.stringify({ generado: true, enCache: cache.length }))
    return
  }
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ ok: true }))
}).listen(3000, () => console.log(`${ts()} INFO reportes iniciado (pid ${process.pid}); cache de reportes sin limite de tamaño`))
