import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHubService, AGENT_TARGET } from '../src/service.js'
import { createMemoryStore } from '../src/store/memory.js'
import { hashToken } from '../src/tokens.js'
import { TOKEN, report, fakeClock } from './helpers.js'

function setup () {
  const store = createMemoryStore()
  const now = fakeClock()
  const service = createHubService({ store, staleFactor: 3, now })
  return { store, now, service }
}

describe('autenticacion', () => {
  test('token valido -> nodo; revocado o desconocido -> null', async () => {
    const { store, service } = setup()
    await store.createAgent({ node: 'web-01', tokenHash: hashToken(TOKEN) })
    assert.deepEqual(await service.authenticate(TOKEN), { node: 'web-01' })
    assert.equal(await service.authenticate('y'.repeat(43)), null)
    assert.equal(await service.authenticate(null), null)
    await store.revokeAgent('web-01')
    assert.equal(await service.authenticate(TOKEN), null, 'revocar corta el acceso de inmediato')
  })

  test('el almacenamiento nunca ve el token en claro', async () => {
    const { store } = setup()
    await store.createAgent({ node: 'web-01', tokenHash: hashToken(TOKEN) })
    const agents = JSON.stringify(await store.listAgents())
    assert.ok(!agents.includes(TOKEN))
  })
})

describe('ingesta', () => {
  test('guarda estado, eventos y muestra', async () => {
    const { service } = setup()
    await service.ingest(report({ events: [{ target: 'host', from: 'UNKNOWN', to: 'UP', at: 1000, reason: 'ok' }] }))
    const [node] = await service.fleet()
    assert.equal(node.status, 'UP')
    assert.equal(node.containers.length, 1)
    assert.equal(node.history.length, 1)
    assert.equal((await service.events()).length, 1)
  })

  test('las aplicaciones llegan con su historia de latencia', async () => {
    // El comportamiento de una aplicacion es una tendencia, no un valor: una
    // latencia que sube durante diez minutos avisa antes que el primer error.
    const { service } = setup()
    await service.ingest(report({ sentAt: 1_000 }))
    const slow = report({ sentAt: 2_000 })
    slow.targets[2] = { ...slow.targets[2], latencyMs: 2400, consecutiveFailures: 1, detail: 'lenta: 2400 ms' }
    await service.ingest(slow)
    const [node] = await service.fleet()
    assert.equal(node.apps.length, 1)
    assert.equal(node.containers.length, 1, 'las aplicaciones no se mezclan con los contenedores')
    assert.deepEqual(node.apps[0].history.map((h) => [h.latencyMs, h.ok]), [[35, true], [2400, false]])
  })

  test('un reporte atrasado de la cola no pisa el estado actual', async () => {
    // Al volver la red, el agente reenvia su cola: el ultimo reporte en
    // llegar puede ser el mas viejo.
    const { service } = setup()
    const down = report({ sentAt: 5_000 })
    down.targets[0] = { ...down.targets[0], status: 'DOWN' }
    await service.ingest(down)
    const r = await service.ingest(report({ sentAt: 2_000 }))
    assert.equal(r.stale, true)
    const [node] = await service.fleet()
    assert.equal(node.status, 'DOWN', 'el estado es el del reporte mas reciente, no el ultimo en llegar')
    assert.equal(node.history.length, 2, 'la muestra atrasada si entra en la historia')
  })
})

describe("dead man's switch", () => {
  test('silencio mayor a staleFactor intervalos -> DOWN, con un solo evento', async () => {
    const { service, now } = setup()
    await service.ingest(report())

    now.advance(2_500) // 2.5 intervalos: aun dentro del margen
    assert.deepEqual((await service.sweep()).silenced, [])

    now.advance(1_000) // 3.5 intervalos
    assert.deepEqual((await service.sweep()).silenced, ['web-01'])
    const [node] = await service.fleet()
    assert.equal(node.status, 'DOWN')
    assert.equal(node.silent, true)

    now.advance(10_000)
    assert.deepEqual((await service.sweep()).silenced, [], 'un nodo en silencio genera una alerta, no una por barrido')
    const evs = (await service.events()).filter((e) => e.target === AGENT_TARGET)
    assert.equal(evs.length, 1)
    assert.match(evs[0].reason, /sin reportes/)
  })

  test('el nodo vuelve a reportar -> se cierra el incidente', async () => {
    const { service, now } = setup()
    await service.ingest(report())
    now.advance(5_000)
    await service.sweep()
    await service.ingest(report({ sentAt: 6_000 }))
    const [node] = await service.fleet()
    assert.equal(node.silent, false)
    assert.equal(node.status, 'UP')
    const [last] = await service.events()
    assert.deepEqual([last.target, last.from, last.to], [AGENT_TARGET, 'DOWN', 'UP'])
  })

  test('retencion: el barrido elimina muestras viejas', async () => {
    const store = createMemoryStore()
    const now = fakeClock(100_000)
    const service = createHubService({ store, retentionMs: 50_000, now })
    await service.ingest(report({ sentAt: 10_000 }))
    await service.ingest(report({ sentAt: 90_000 }))
    await service.sweep()
    assert.equal((await store.listSamples(0)).length, 1)
  })
})
