/**
 * Contrato del almacenamiento: la misma bateria corre contra memoria y contra
 * PostgreSQL. Si ambos pasan, el servicio se comporta igual sobre cualquiera.
 *
 * La parte de PostgreSQL corre solo si MIND_TEST_DATABASE_URL esta definida,
 * y usa un esquema temporal que se elimina al terminar.
 */
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { createMemoryStore } from '../src/store/memory.js'
import { createPostgresStore } from '../src/store/postgres.js'
import { migrate } from '../src/migrate.js'

const DB = process.env.MIND_TEST_DATABASE_URL

function contract (name, open) {
  describe(`almacenamiento: ${name}`, () => {
    let store
    before(async () => { store = await open() })
    after(async () => { await store.close() })

    test('un solo token activo por nodo', async () => {
      await store.createAgent({ node: 'n1', tokenHash: 'h1' })
      await assert.rejects(store.createAgent({ node: 'n1', tokenHash: 'h2' }), /ya existe/)
      assert.equal(await store.revokeAgent('n1'), 1)
      await store.createAgent({ node: 'n1', tokenHash: 'h2' }) // rotacion
      assert.equal((await store.getAgentByTokenHash('h1')).node, 'n1')
      assert.ok((await store.getAgentByTokenHash('h1')).revokedAt)
      assert.equal((await store.getAgentByTokenHash('h2')).revokedAt, null)
    })

    test('upsert y lectura de nodos conservan tipos', async () => {
      const n = { node: 'n1', lastSeen: 5, lastReportAt: 4, intervalMs: 1000, agentVersion: '0.1.0', host: { cpuPercent: 1 }, targets: [{ id: 'host' }], silent: false }
      await store.upsertNode(n)
      await store.upsertNode({ ...n, lastSeen: 6, silent: true })
      assert.deepEqual(await store.getNode('n1'), { ...n, lastSeen: 6, silent: true })
      assert.equal(await store.getNode('nadie'), null)
    })

    test('eventos: los mas recientes primero', async () => {
      await store.insertEvents([
        { node: 'n1', target: 'host', from: 'UP', to: 'DOWN', at: 1, reason: 'a' },
        { node: 'n1', target: 'host', from: 'DOWN', to: 'UP', at: 2, reason: null }
      ])
      const evs = await store.listEvents(10)
      assert.deepEqual(evs.map((e) => e.at), [2, 1])
    })

    test('muestras: filtro por instante y poda', async () => {
      await store.insertSample({ node: 'n1', at: 10, cpu: 1.5, mem: 2 })
      await store.insertSample({ node: 'n1', at: 20, cpu: 3, mem: 4 })
      assert.deepEqual((await store.listSamples(15)).map((s) => s.at), [20])
      await store.pruneSamples(15)
      assert.deepEqual((await store.listSamples(0)).map((s) => [s.at, s.cpu]), [[20, 3]])
    })

    test('muestras de aplicaciones: latencia nula si no hubo respuesta', async () => {
      await store.insertAppSamples([
        { node: 'n1', app: 'portal', at: 10, latencyMs: 35, ok: true },
        { node: 'n1', app: 'portal', at: 30, latencyMs: null, ok: false }
      ])
      assert.deepEqual((await store.listAppSamples(0)).map((s) => [s.at, s.latencyMs, s.ok]), [[10, 35, true], [30, null, false]])
      await store.pruneSamples(20)
      assert.deepEqual((await store.listAppSamples(0)).map((s) => s.at), [30])
    })
  })
}

contract('memoria', async () => createMemoryStore())

if (DB) {
  const schema = `test_${process.pid}`
  contract('postgresql', async () => {
    const admin = new pg.Client({ connectionString: DB })
    await admin.connect()
    await admin.query(`CREATE SCHEMA ${schema}`)
    await admin.end()
    const url = new URL(DB)
    url.searchParams.set('options', `-c search_path=${schema}`)
    const store = createPostgresStore({ connectionString: url.toString() })
    await migrate(store.pool)
    await migrate(store.pool) // idempotente
    const close = store.close
    store.close = async () => {
      await store.pool.query(`DROP SCHEMA ${schema} CASCADE`)
      await close()
    }
    return store
  })
}
