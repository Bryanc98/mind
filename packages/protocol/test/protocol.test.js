import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { SCHEMA_VERSION, SUPPORTED_SCHEMA_VERSIONS, buildReport, reportSchema } from '../src/index.js'

const sample = {
  cpuPercent: 12.5,
  memory: { usedPercent: 40, usedBytes: 400, totalBytes: 1000 },
  loadAvg1m: 0.1234,
  uptimeSec: 60,
  platform: 'linux',
  scope: 'cgroup'
}

describe('protocolo de telemetria', () => {
  test('todo reporte declara su version de esquema', () => {
    // Sin este campo, cambiar el payload exige actualizar toda la flota a la
    // vez (ADR 0007).
    const r = buildReport({ node: 'n1', agentVersion: '0.1.0', intervalMs: 15000, now: 1, sample, targets: [], events: [] })
    assert.equal(r.schemaVersion, SCHEMA_VERSION)
    assert.equal(r.sentAt, 1, 'el reloj entra como argumento')
    assert.equal(r.host.loadAvg1m, 0.12)
    assert.equal(r.host.scope, 'cgroup')
  })

  test('el Hub acepta la version vigente', () => {
    assert.ok(SUPPORTED_SCHEMA_VERSIONS.includes(SCHEMA_VERSION))
  })

  test('las claves del reporte coinciden con el esquema', () => {
    // El Hub descarta en silencio los campos que el esquema no declara, lo
    // que permite que un agente mas nuevo hable con un Hub mas viejo. El
    // costo es que un campo olvidado aqui se perderia sin error visible.
    const r = buildReport({ node: 'n1', agentVersion: '0.1.0', intervalMs: 15000, now: 1, sample, targets: [], events: [] })
    assert.deepEqual(Object.keys(r).sort(), Object.keys(reportSchema.properties).sort())
    assert.deepEqual(Object.keys(r.host).sort(), Object.keys(reportSchema.properties.host.properties).sort())
  })
})
