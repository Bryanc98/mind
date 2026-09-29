import { describe, test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDiskQueue, createHubClient } from '../src/index.js'

const silent = { debug () {}, info () {}, warn () {}, error () {} }

let dir
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mind-queue-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** fetch falso: responde segun `plan` (un status o 'net' para error de red). */
function fakeFetch (plan) {
  const calls = []
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) })
    const next = plan.length > 1 ? plan.shift() : plan[0]
    if (next === 'net') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
    return new Response(null, { status: next })
  }
  fn.calls = calls
  return fn
}

describe('createDiskQueue', () => {
  test('persiste entre reinicios del proceso', () => {
    const q1 = createDiskQueue({ dir, max: 10 })
    q1.push({ n: 1 })
    q1.push({ n: 2 })
    const q2 = createDiskQueue({ dir, max: 10 })
    assert.deepEqual(q2.peek(10), [{ n: 1 }, { n: 2 }])
  })

  test('acotada: descarta los mas antiguos', () => {
    const q = createDiskQueue({ dir, max: 3 })
    for (let n = 1; n <= 5; n++) q.push({ n })
    assert.deepEqual(q.peek(10).map((i) => i.n), [3, 4, 5])
    assert.equal(q.takeDropped(), 2)
    assert.equal(q.takeDropped(), 0, 'la cuenta se reinicia al leerla')
  })

  test('una linea truncada por un corte no invalida el resto', () => {
    const q = createDiskQueue({ dir, max: 10 })
    q.push({ n: 1 })
    appendFileSync(join(dir, 'queue.ndjson'), '{"n":2, "trunca')
    assert.deepEqual(createDiskQueue({ dir, max: 10 }).peek(10), [{ n: 1 }])
  })

  test('shift reescribe el archivo', () => {
    const q = createDiskQueue({ dir, max: 10 })
    q.push({ n: 1 })
    q.push({ n: 2 })
    q.shift(1)
    assert.equal(readFileSync(join(dir, 'queue.ndjson'), 'utf8'), '{"n":2}\n')
  })
})

describe('createHubClient', () => {
  const opts = (fetch) => ({ url: 'https://hub.example.com', token: 't'.repeat(40), queue: createDiskQueue({ dir, max: 100 }), logger: silent, fetch })

  test('envia con el token como Bearer al endpoint versionado', async () => {
    const fetch = fakeFetch([202])
    const client = createHubClient(opts(fetch))
    assert.deepEqual(await client.send({ n: 1 }), { sent: 1, pending: 0 })
    assert.equal(fetch.calls[0].url, 'https://hub.example.com/api/v1/reports')
    assert.equal(fetch.calls[0].init.headers.authorization, `Bearer ${'t'.repeat(40)}`)
  })

  test('Hub caido: encola y reenvia en orden al volver', async () => {
    const fetch = fakeFetch(['net', 503, 202])
    const client = createHubClient(opts(fetch))
    assert.deepEqual(await client.send({ n: 1 }), { sent: 0, pending: 1 })
    assert.deepEqual(await client.send({ n: 2 }), { sent: 0, pending: 2 })
    assert.deepEqual(await client.send({ n: 3 }), { sent: 3, pending: 0 })
    const order = fetch.calls.slice(2).map((c) => c.body.n)
    assert.deepEqual(order, [1, 2, 3], 'un reporte nuevo nunca adelanta a uno viejo')
  })

  test('un rechazo definitivo (401) no se encola', async () => {
    // Reintentar un token revocado llenaria la cola para siempre.
    const fetch = fakeFetch([401])
    const client = createHubClient(opts(fetch))
    assert.deepEqual(await client.send({ n: 1 }), { sent: 0, pending: 0 })
  })

  test('429 se trata como transitorio', async () => {
    const fetch = fakeFetch([429])
    const client = createHubClient(opts(fetch))
    assert.deepEqual(await client.send({ n: 1 }), { sent: 0, pending: 1 })
  })
})
