import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { createHubService } from '../src/service.js'
import { createMemoryStore } from '../src/store/memory.js'
import { hashToken } from '../src/tokens.js'
import { TOKEN, report } from './helpers.js'

const OTHER = 'z'.repeat(43)
let app

before(async () => {
  const store = createMemoryStore()
  await store.createAgent({ node: 'web-01', tokenHash: hashToken(TOKEN) })
  await store.createAgent({ node: 'db-01', tokenHash: hashToken(OTHER) })
  app = await buildApp({ service: createHubService({ store }), logger: false, rateLimitPerMin: 5 })
})
after(() => app.close())

const post = (body, token = TOKEN) => app.inject({
  method: 'POST',
  url: '/api/v1/reports',
  headers: token ? { authorization: `Bearer ${token}` } : {},
  payload: body
})

describe('POST /api/v1/reports', () => {
  test('sin token -> 401, sin revelar el esquema', async () => {
    const r = await post({ basura: true }, null)
    assert.equal(r.statusCode, 401)
    assert.ok(!r.body.includes('schemaVersion'))
  })

  test('reporte valido -> 202', async () => {
    const r = await post(report())
    assert.equal(r.statusCode, 202)
  })

  test('reporte a nombre de otro nodo -> 403', async () => {
    // Un token comprometido no puede suplantar a otro servidor.
    const r = await post(report(), OTHER)
    assert.equal(r.statusCode, 403)
  })

  test('schemaVersion no soportada -> 400 con las versiones aceptadas', async () => {
    const r = await post(report({ schemaVersion: 99 }))
    assert.equal(r.statusCode, 400)
    assert.match(r.json().error, /se aceptan 1/)
  })

  test('cuerpo invalido -> 400', async () => {
    const r = await post(report({ host: { cpuPercent: 'mucho', memPercent: 5 } }))
    assert.equal(r.statusCode, 400)
  })

  test('campos desconocidos se descartan, no se rechazan', async () => {
    // Un agente mas nuevo que el Hub no debe quedar fuera (ADR 0007).
    const r = await post({ ...report(), campoFuturo: 1 })
    assert.equal(r.statusCode, 202)
  })

  test('rate limit por token -> 429', async () => {
    let last
    for (let i = 0; i < 6; i++) last = await post(report(), OTHER)
    assert.equal(last.statusCode, 429)
  })
})

describe('lectura y panel', () => {
  test('GET /api/v1/fleet devuelve los nodos', async () => {
    const r = await app.inject('/api/v1/fleet')
    assert.equal(r.statusCode, 200)
    assert.equal(r.json().nodes[0].node, 'web-01')
  })

  test('GET /api/v1/events acepta limit por querystring', async () => {
    const r = await app.inject('/api/v1/events?limit=5')
    assert.equal(r.statusCode, 200)
    assert.ok(Array.isArray(r.json().events))
  })

  test('el panel se sirve con cabeceras de seguridad', async () => {
    const r = await app.inject('/')
    assert.equal(r.statusCode, 200)
    assert.match(r.headers['content-type'], /text\/html/)
    assert.match(r.headers['content-security-policy'], /frame-ancestors 'none'/)
    assert.equal(r.headers['x-content-type-options'], 'nosniff')
  })

  test('Vue se sirve localmente, sin CDN', async () => {
    const r = await app.inject('/vendor/vue/vue.esm-browser.prod.js')
    assert.equal(r.statusCode, 200)
  })

  test('no existe ningun endpoint que envie ordenes a los agentes', () => {
    // ADR 0002: la capacidad no existe en el codigo. Este test falla si alguien
    // anade una ruta de escritura distinta de la ingesta.
    const routes = app.printRoutes({ commonPrefix: false })
    const writes = routes.split('\n').filter((l) => /\((POST|PUT|PATCH|DELETE)/.test(l))
    assert.equal(writes.length, 1, routes)
    assert.match(writes[0], /reports/)
  })
})
