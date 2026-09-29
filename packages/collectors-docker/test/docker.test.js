import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { containerCheck, createDockerClient, collectContainers, parseDockerHost, detectRestart, memoryPercent, demuxLogs } from '../src/index.js'

const inspect = (state, extra = {}) => ({
  Id: 'abcdef0123456789',
  Name: '/web',
  Config: { Image: 'nginx:alpine' },
  RestartCount: 0,
  State: state,
  ...extra
})

describe('containerCheck - de inspect a resultado de chequeo', () => {
  test('en ejecucion sin healthcheck -> ok', () => {
    const c = containerCheck(inspect({ Status: 'running', Running: true }))
    assert.equal(c.ok, true)
    assert.equal(c.name, 'web', 'sin la barra inicial que agrega la API')
    assert.equal(c.id, 'abcdef012345')
    assert.equal(c.exitCode, null)
  })

  test('detenido -> fallo, con el codigo de salida en el detalle', () => {
    const c = containerCheck(inspect({ Status: 'exited', Running: false, ExitCode: 137 }))
    assert.equal(c.ok, false)
    assert.equal(c.exitCode, 137)
    assert.match(c.detail, /137/)
  })

  test('healthcheck unhealthy -> fallo aunque el proceso corra', () => {
    // El proceso vivo no significa servicio sano: un servidor web colgado
    // sigue "running".
    const c = containerCheck(inspect({
      Status: 'running',
      Running: true,
      Health: { Status: 'unhealthy', Log: [{ Output: 'curl: (7) connection refused\n' }] }
    }))
    assert.equal(c.ok, false)
    assert.match(c.detail, /connection refused/)
  })

  test('healthcheck starting -> no cuenta como fallo', () => {
    const c = containerCheck(inspect({ Status: 'running', Running: true, Health: { Status: 'starting' } }))
    assert.equal(c.ok, true)
  })

  test('en bucle de reinicios -> fallo', () => {
    const c = containerCheck(inspect({ Status: 'restarting', Running: true, Restarting: true }, { RestartCount: 9 }))
    assert.equal(c.ok, false)
    assert.match(c.detail, /reinicios: 9/)
  })
})

describe('detectRestart - caidas que Docker ya reparo', () => {
  const running = (restarts, extra = {}) => ({
    ...containerCheck(inspect({ Status: 'running', Running: true }, { RestartCount: restarts })),
    ...extra
  })
  const opts = (now) => ({ now, recentMs: 6000, loopWindowMs: 60000 })

  test('primer ciclo: sin contador previo no hay nada que comparar', () => {
    assert.equal(detectRestart({}, running(5), opts(0)).ok, true)
  })

  test('el contador subio -> fallo aunque ahora este corriendo', () => {
    // Docker lo reinicio en un segundo: ambas lecturas dicen "running".
    const c = detectRestart({ restartCount: 2 }, running(3, { lastExitCode: 1 }), opts(1000))
    assert.equal(c.ok, false)
    assert.match(c.detail, /se reinicio tras salir con codigo 1, hace 0s/)
  })

  test('muerto por memoria -> lo dice', () => {
    const c = detectRestart({ restartCount: 0 }, running(1, { oomKilled: true }), opts(0))
    assert.match(c.detail, /falta de memoria \(OOM, codigo 137\)/)
  })

  test('reinicio aislado: falla un rato y se recupera', () => {
    let prev = detectRestart({ restartCount: 0 }, running(1), opts(0))
    prev = { restartCount: 1, restarts: prev.restarts }
    assert.equal(detectRestart(prev, running(1), opts(4000)).ok, false, 'dentro de recentMs')
    assert.equal(detectRestart(prev, running(1), opts(7000)).ok, true, 'pasado recentMs, un solo reinicio no es un bucle')
  })

  test('bucle de reinicios: falla sostenida entre reinicios', () => {
    // Regresion: con solo una ventana corta, un contenedor que se cae cada 9 s
    // alternaba DEGRADED y UP sin llegar nunca a DOWN.
    const prev = { restartCount: 2, restarts: [{ at: 0, oom: true, exitCode: 137 }, { at: 9000, oom: false, exitCode: null }] }
    const c = detectRestart(prev, running(2, { oomKilled: true, lastExitCode: 137 }), opts(17000))
    assert.equal(c.ok, false)
    assert.equal(prev.restarts[1].oom, false, 'no muta el estado anterior')
    assert.match(c.detail, /bucle de reinicios: 2 en 60s; el ultimo por falta de memoria/)
    assert.equal(detectRestart(prev, running(2), opts(70000)).ok, true, 'un minuto sin reinicios: se da por sano')
  })

  test('causa desconocida: el texto no queda colgando', () => {
    const prev = { restartCount: 2, restarts: [{ at: 0, oom: false, exitCode: null }, { at: 9000, oom: false, exitCode: null }] }
    assert.equal(detectRestart(prev, running(2), opts(10000)).detail, 'bucle de reinicios: 2 en 60s')
  })
})

describe('memoryPercent', () => {
  test('descuenta la cache inactiva, como docker stats', () => {
    const s = { memory_stats: { usage: 60, limit: 100, stats: { inactive_file: 10 } } }
    assert.equal(memoryPercent(s), 50)
  })

  test('sin datos -> null, no NaN', () => {
    assert.equal(memoryPercent({ memory_stats: {} }), null)
    assert.equal(memoryPercent(null), null)
  })
})

describe('demuxLogs', () => {
  const frame = (stream, text) => {
    const payload = Buffer.from(text)
    const header = Buffer.alloc(8)
    header[0] = stream
    header.writeUInt32BE(payload.length, 4)
    return Buffer.concat([header, payload])
  }

  test('separa las tramas de stdout y stderr en orden', () => {
    const buf = Buffer.concat([frame(1, 'inicio\n'), frame(2, 'ERROR fallo\n'), frame(1, 'fin\n')])
    assert.equal(demuxLogs(buf), 'inicio\nERROR fallo\nfin\n')
  })

  test('texto plano (contenedor con TTY) pasa tal cual', () => {
    assert.equal(demuxLogs(Buffer.from('hola mundo\n')), 'hola mundo\n')
  })
})

describe('parseDockerHost', () => {
  test('unix y tcp', () => {
    assert.deepEqual(parseDockerHost('unix:///var/run/docker.sock'), { socketPath: '/var/run/docker.sock' })
    assert.deepEqual(parseDockerHost('tcp://socket-proxy:2375'), { host: 'socket-proxy', port: 2375 })
  })
})

describe('createDockerClient - contra una Engine API falsa', () => {
  // Servidor HTTP sobre un socket unix: el mismo transporte que usa Docker.
  let dir, server, requests
  const containers = {
    aaa: inspect({ Status: 'running', Running: true }, { Id: 'aaa', Name: '/api', HostConfig: { Memory: 120 } }),
    bbb: inspect({ Status: 'exited', Running: false, ExitCode: 1 }, { Id: 'bbb', Name: '/worker' })
  }

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mind-docker-'))
    requests = []
    server = http.createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`)
      if (req.url.startsWith('/containers/json')) {
        res.end(JSON.stringify([{ Id: 'bbb' }, { Id: 'aaa' }, { Id: 'gone' }]))
        return
      }
      if (req.url.startsWith('/events?')) {
        res.end(JSON.stringify({ Action: 'die', Actor: { ID: 'bbb', Attributes: { exitCode: '1' } } }) + '\n')
        return
      }
      if (/\/stats\?/.test(req.url)) {
        res.end(JSON.stringify({ memory_stats: { usage: 30, limit: 120, stats: { inactive_file: 6 } } }))
        return
      }
      const id = /^\/containers\/(\w+)\/json$/.exec(req.url)?.[1]
      if (containers[id]) { res.end(JSON.stringify(containers[id])); return }
      res.statusCode = 404
      res.end('{"message":"No such container"}')
    })
    await new Promise((resolve) => server.listen(join(dir, 'docker.sock'), resolve))
  })

  after(() => {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('lista, inspecciona y ordena; omite los que desaparecen entre medias', async () => {
    const client = createDockerClient(`unix://${join(dir, 'docker.sock')}`)
    const checks = await collectContainers(client, { label: 'mind.monitor=true', since: 1, until: 2 })
    assert.deepEqual(checks.map((c) => [c.name, c.ok, c.memPercent]), [['api', true, 20], ['worker', false, null]])
    assert.equal(checks[1].lastExitCode, 1, 'la causa de la muerte sale de los eventos')
    assert.equal(checks[0].memBytes, 24)
    assert.ok(requests[0].includes('filters='), 'el filtro por etiqueta se delega a la API')
  })

  test('solo hace peticiones GET', () => {
    assert.ok(requests.every((r) => r.startsWith('GET ')), requests.join(', '))
  })
})
