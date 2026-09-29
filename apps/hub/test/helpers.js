import { SCHEMA_VERSION } from '@mind/protocol'

export const TOKEN = 'x'.repeat(43)

export function report (overrides = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    node: 'web-01',
    agentVersion: '0.1.0',
    sentAt: 1_000,
    intervalMs: 1_000,
    host: { cpuPercent: 10, memPercent: 50, memUsedBytes: 5, memTotalBytes: 10, loadAvg1m: 0.1, uptimeSec: 9, platform: 'linux', scope: 'host' },
    targets: [
      { id: 'host', kind: 'host', name: 'web-01', status: 'UP', since: 1_000, consecutiveFailures: 0, detail: null },
      { id: 'container:api', kind: 'container', name: 'api', status: 'UP', since: 1_000, consecutiveFailures: 0, detail: 'en ejecucion' },
      { id: 'http:portal', kind: 'http', name: 'portal', status: 'UP', since: 1_000, consecutiveFailures: 0, detail: 'HTTP 200 en 35 ms', latencyMs: 35, httpStatus: 200 }
    ],
    events: [],
    ...overrides
  }
}

/** Reloj controlable para probar el paso del tiempo sin esperar. */
export function fakeClock (start = 10_000) {
  let t = start
  const now = () => t
  now.advance = (ms) => { t += ms }
  return now
}
