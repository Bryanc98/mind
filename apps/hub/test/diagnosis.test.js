import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createDiagnoser } from '../src/diagnosis.js'
import { validateDiagnosis, buildContext, PROMPT_VERSION } from '../src/prompt.js'
import { createMemoryStore } from '../src/store/memory.js'
import { fakeClock } from './helpers.js'

const silent = { debug () {}, info () {}, warn () {}, error () {} }

const GOOD = {
  resumen: 'tramites responde 503 porque db-01 dejo de reportar.',
  causa_probable: 'db-01 caido',
  confianza: 'alta',
  evidencia: ['20:14:36 tramites HTTP 503', '20:14:37 db-01 sin reportes'],
  servidores_afectados: ['db-01', 'web-01'],
  que_revisar: ['Revisar db-01']
}

/** Proveedor falso que registra lo que recibe. */
function fakeProvider (respond = () => GOOD) {
  const calls = []
  return {
    name: 'falso',
    model: 'modelo-de-prueba',
    calls,
    async generate (req) {
      calls.push(req)
      return { data: respond(calls.length), latencyMs: 42 }
    }
  }
}

function setup (opts = {}) {
  const store = createMemoryStore()
  const provider = opts.provider ?? fakeProvider()
  const now = fakeClock(1_000_000)
  const diagnoser = createDiagnoser({
    store,
    provider,
    fleet: async () => opts.fleet ?? [],
    logger: silent,
    delayMs: 5000,
    cooldownMs: 60_000,
    dailyLimit: opts.dailyLimit ?? 50,
    now,
    // Temporizador controlado: el test dispara con flush().
    setTimer: () => 0,
    clearTimer: () => {}
  })
  return { store, provider, now, diagnoser }
}

const down = (node, target, at, reason = 'fallo') => ({ node, target, from: 'DEGRADED', to: 'DOWN', at, reason })

describe('disparo y agrupacion', () => {
  test('una falla en cascada produce UN diagnostico con todos sus disparadores', async () => {
    const { store, provider, diagnoser } = setup()
    diagnoser.observe([down('web-01', 'http:tramites', 999_000, 'HTTP 503')])
    diagnoser.observe([down('db-01', 'agente', 999_500, 'sin reportes')])
    await diagnoser.flush()
    const ds = await store.listDiagnoses(10)
    assert.equal(ds.length, 1)
    assert.deepEqual(ds[0].triggers.map((t) => t.node), ['web-01', 'db-01'])
    assert.equal(ds[0].status, 'listo')
    assert.equal(ds[0].promptVersion, PROMPT_VERSION)
    assert.equal(ds[0].latencyMs, 42)
    assert.equal(provider.calls.length, 1)
  })

  test('DEGRADED no dispara: solo las caidas', async () => {
    const { store, diagnoser } = setup()
    diagnoser.observe([{ node: 'n', target: 'host', from: 'UP', to: 'DEGRADED', at: 1 }])
    await diagnoser.flush()
    assert.equal((await store.listDiagnoses(10)).length, 0)
  })

  test('cooldown por servidor: un servidor que oscila no genera un diagnostico por oscilacion', async () => {
    const { store, now, diagnoser } = setup()
    diagnoser.observe([down('web-01', 'host', 1)])
    await diagnoser.flush()
    now.advance(30_000)
    diagnoser.observe([down('web-01', 'host', 2)])
    await diagnoser.flush()
    assert.equal((await store.listDiagnoses(10)).length, 1, 'dentro del cooldown')
    now.advance(31_000)
    diagnoser.observe([down('web-01', 'host', 3)])
    await diagnoser.flush()
    assert.equal((await store.listDiagnoses(10)).length, 2, 'pasado el cooldown')
  })

  test('techo diario: no se llama al proveedor pasado el limite', async () => {
    const { store, provider, diagnoser } = setup({ dailyLimit: 1 })
    diagnoser.observe([down('a', 'host', 1)])
    await diagnoser.flush()
    diagnoser.observe([down('b', 'host', 2)])
    await diagnoser.flush()
    assert.equal(provider.calls.length, 1)
    assert.equal((await store.listDiagnoses(10)).length, 1)
  })
})

describe('respuesta del modelo', () => {
  test('respuesta invalida -> diagnostico en error, no basura en el panel', async () => {
    const { store, diagnoser } = setup({ provider: fakeProvider(() => ({ resumen: 'algo' })) })
    diagnoser.observe([down('a', 'host', 1)])
    await diagnoser.flush()
    const [d] = await store.listDiagnoses(1)
    assert.equal(d.status, 'error')
    assert.equal(d.result, null)
    assert.match(d.error, /falta el campo causa_probable/)
  })

  test('con respaldo: se registra el proveedor que respondio de verdad', async () => {
    const provider = fakeProvider()
    const base = provider.generate
    provider.generate = async (req) => ({ ...(await base(req)), provider: 'ollama', model: 'qwen-local' })
    const { store, diagnoser } = setup({ provider })
    diagnoser.observe([down('a', 'host', 1)])
    await diagnoser.flush()
    const [d] = await store.listDiagnoses(1)
    assert.deepEqual([d.provider, d.model], ['ollama', 'qwen-local'])
  })

  test('proveedor caido -> error registrado, el Hub sigue', async () => {
    const provider = fakeProvider()
    provider.generate = async () => { throw new Error('ollama: ECONNREFUSED') }
    const { store, diagnoser } = setup({ provider })
    diagnoser.observe([down('a', 'host', 1)])
    await diagnoser.flush()
    assert.match((await store.listDiagnoses(1))[0].error, /ECONNREFUSED/)
  })

  test('validateDiagnosis acota listas, normaliza la confianza y enmascara', () => {
    const v = validateDiagnosis({
      ...GOOD,
      confianza: 'ALTA',
      evidencia: ['1', '2', '3', '4', '5', '6', 7],
      que_revisar: ['llamar a ana@example.com']
    })
    assert.equal(v.confianza, 'alta')
    assert.equal(v.evidencia.length, 5)
    assert.deepEqual(v.que_revisar, ['llamar a [correo]'])
    assert.throws(() => validateDiagnosis({ ...GOOD, confianza: 'total' }), /confianza invalida/)
    assert.throws(() => validateDiagnosis([]), /no es un objeto/)
  })
})

describe('contexto enviado al proveedor', () => {
  test('incluye todos los servidores y sus eventos, y ningun secreto', async () => {
    const fleet = [
      { node: 'db-01', status: 'DOWN', silent: true, secondsSinceLastSeen: 9, host: { cpuPercent: 1, memPercent: 17 }, apps: [], containers: [] },
      {
        node: 'web-01', status: 'UP', silent: false, host: { cpuPercent: 2, memPercent: 20 },
        apps: [{ name: 'tramites', status: 'DOWN', detail: 'HTTP 503 en 5 ms', latencyMs: 5 }],
        containers: [{ name: 'tramites', status: 'UP', detail: 'en ejecucion (healthy)', memPercent: null, restartCount: 0 }]
      }
    ]
    const { store, provider, diagnoser } = setup({ fleet })
    await store.insertEvents([{
      node: 'web-01', target: 'http:tramites', from: 'UP', to: 'DEGRADED', at: 998_000, reason: 'HTTP 503',
      // Un agente viejo que no enmascaraba: el Hub es la segunda barrera.
      logs: 'ERROR postgres://tramites:S3cr3t@db-tramites:5432 ECONNREFUSED usuario ana@example.com'
    }])
    diagnoser.observe([down('web-01', 'http:tramites', 999_000, 'HTTP 503')])
    await diagnoser.flush()

    const [saved] = await store.listDiagnoses(1)
    assert.ok(saved.context, 'se guarda lo que se envio, para auditoria')
    assert.ok(provider.calls[0].user.includes(JSON.stringify(saved.context)))

    const sent = provider.calls[0].user
    assert.match(sent, /db-01/)
    assert.match(sent, /sin_reportes/)
    assert.match(sent, /ECONNREFUSED/, 'el log llega: es la evidencia')
    assert.ok(!sent.includes('S3cr3t'), 'la clave no sale del Hub')
    assert.ok(!sent.includes('ana@example.com'), 'el correo no sale del Hub')
    assert.match(provider.calls[0].system, /Responde SOLO con un objeto JSON/)
    assert.ok(provider.calls[0].schema.required.includes('causa_probable'))
  })

  test('incluye el valor habitual para ver el cambio, no solo el valor actual', () => {
    const history = [
      { at: 0, cpu: 2, mem: 30, latencyMs: 15, ok: true },
      { at: 10_000, cpu: 4, mem: 30, latencyMs: 17, ok: true },
      { at: 95_000, cpu: 99, mem: 31, latencyMs: 1500, ok: false }
    ]
    const ctx = buildContext({
      triggers: [down('app-01', 'http:consultas', 100_000)],
      events: [],
      fleet: [{
        node: 'app-01', status: 'DOWN', host: { cpuPercent: 99, memPercent: 31 }, history,
        apps: [{ name: 'consultas', status: 'DOWN', detail: 'lenta', latencyMs: 1500, history }],
        containers: []
      }],
      now: 100_000
    })
    const [srv] = ctx.servidores
    assert.equal(srv.cpu_pct_habitual, 3, 'mediana de las muestras previas al incidente')
    assert.equal(srv.aplicaciones[0].latencia_ms_habitual, 16)
    assert.equal(srv.aplicaciones[0].sondeos_fallidos_10min, 1)
  })

  test('solo los logs del incidente, no los de uno anterior', () => {
    const ctx = buildContext({
      triggers: [down('app-01', 'http:consultas', 1_000_000)],
      events: [
        { node: 'web-01', target: 'container:reportes', from: 'UP', to: 'DOWN', at: 700_000, reason: 'OOM', logs: 'cache de reportes' },
        { node: 'app-01', target: 'http:consultas', from: 'UP', to: 'DEGRADED', at: 995_000, reason: 'lenta', logs: 'consulta lenta' }
      ],
      fleet: [],
      now: 1_000_000
    })
    assert.deepEqual(ctx.logs.map((l) => l.objetivo), ['http:consultas'])
    assert.deepEqual(ctx.cambios_del_incidente.map((c) => c.objetivo), ['http:consultas'])
    assert.deepEqual(ctx.historial_previo.map((c) => c.objetivo), ['container:reportes'], 'lo anterior queda resumido como historia')
  })

  test('buildContext es puro: mismos datos, mismo contexto', () => {
    const input = { triggers: [down('a', 'host', 1)], events: [], fleet: [], now: 5 }
    assert.deepEqual(buildContext(input), buildContext(input))
  })
})
