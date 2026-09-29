import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { httpCheck, probe, collectHttp } from '../src/index.js'

describe('httpCheck - de respuesta a resultado de chequeo', () => {
  const opts = { slowMs: 1000 }

  test('2xx rapido -> ok', () => {
    const c = httpCheck({ status: 200, latencyMs: 42.4 }, opts)
    assert.deepEqual(c, { ok: true, httpStatus: 200, latencyMs: 42, detail: 'HTTP 200 en 42 ms' })
  })

  test('3xx -> ok: una redireccion al login es una respuesta de la aplicacion', () => {
    assert.equal(httpCheck({ status: 302, latencyMs: 10 }, opts).ok, true)
  })

  test('5xx -> fallo, aunque responda rapido', () => {
    // El proceso vive y el contenedor puede estar "healthy": la aplicacion no.
    const c = httpCheck({ status: 500, latencyMs: 8 }, opts)
    assert.equal(c.ok, false)
    assert.equal(c.httpStatus, 500)
    assert.match(c.detail, /HTTP 500/)
  })

  test('4xx -> fallo: la URL de salud no deberia dar 404', () => {
    assert.equal(httpCheck({ status: 404, latencyMs: 8 }, opts).ok, false)
  })

  test('lenta -> fallo: para el usuario una pagina que no carga esta caida', () => {
    const c = httpCheck({ status: 200, latencyMs: 2500 }, opts)
    assert.equal(c.ok, false)
    assert.match(c.detail, /lenta: 2500 ms \(limite 1000 ms\)/)
  })

  test('sin respuesta -> fallo con el motivo', () => {
    const c = httpCheck({ error: 'ECONNREFUSED', latencyMs: 3 }, opts)
    assert.equal(c.ok, false)
    assert.equal(c.httpStatus, null)
    assert.match(c.detail, /ECONNREFUSED/)
  })
})

describe('probe - contra un servidor real', () => {
  let server, base, methods
  before(async () => {
    methods = []
    server = http.createServer((req, res) => {
      methods.push(req.method)
      if (req.url === '/lento') { setTimeout(() => res.end('ok'), 300); return }
      if (req.url === '/error') { res.statusCode = 500; res.end('boom'); return }
      if (req.url === '/redir') { res.statusCode = 302; res.setHeader('location', '/login'); res.end(); return }
      res.end('ok')
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${server.address().port}`
  })
  after(() => server.close())

  test('mide codigo y latencia', async () => {
    const r = await probe(`${base}/`, { timeoutMs: 2000 })
    assert.equal(r.status, 200)
    assert.ok(r.latencyMs >= 0 && r.latencyMs < 1000)
  })

  test('no sigue redirecciones', async () => {
    assert.equal((await probe(`${base}/redir`, { timeoutMs: 2000 })).status, 302)
  })

  test('respeta el timeout', async () => {
    const r = await probe(`${base}/lento`, { timeoutMs: 50 })
    assert.match(r.error, /timeout tras 50 ms/)
  })

  test('puerto cerrado -> error de conexion legible, no excepcion', async () => {
    // Se abre y se cierra un servidor para obtener un puerto libre de verdad.
    const tmp = http.createServer()
    await new Promise((resolve) => tmp.listen(0, '127.0.0.1', resolve))
    const port = tmp.address().port
    await new Promise((resolve) => tmp.close(resolve))
    const r = await probe(`http://127.0.0.1:${port}/`, { timeoutMs: 1000 })
    assert.equal(r.error, 'ECONNREFUSED')
  })

  test('collectHttp sondea en paralelo y conserva el orden', async () => {
    const t0 = Date.now()
    const checks = await collectHttp([
      { name: 'lento', url: `${base}/lento` },
      { name: 'roto', url: `${base}/error` },
      { name: 'sano', url: `${base}/` }
    ], { timeoutMs: 2000, slowMs: 1000 })
    assert.deepEqual(checks.map((c) => [c.name, c.ok]), [['lento', true], ['roto', false], ['sano', true]])
    assert.ok(Date.now() - t0 < 600, 'en paralelo: el total es el del mas lento, no la suma')
  })

  test('solo hace peticiones GET', () => {
    assert.ok(methods.every((m) => m === 'GET'), methods.join(','))
  })
})
