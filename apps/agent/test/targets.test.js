import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { pruneContainers } from '../src/targets.js'

describe('pruneContainers', () => {
  test('un contenedor eliminado deja de ser objetivo', () => {
    const targets = new Map([
      ['container:api', { kind: 'container' }],
      ['container:viejo', { kind: 'container' }]
    ])
    assert.deepEqual(pruneContainers(targets, new Set(['container:api'])), ['container:viejo'])
    assert.deepEqual([...targets.keys()], ['container:api'])
  })

  test('no toca el host ni las aplicaciones', () => {
    // Regresion: borrar todo lo que no fuera el host reiniciaba la maquina de
    // estados de cada aplicacion en cada ciclo, y nunca llegaban a DOWN.
    const targets = new Map([
      ['host', { kind: 'host' }],
      ['http:portal', { kind: 'http' }],
      ['container:api', { kind: 'container' }]
    ])
    pruneContainers(targets, new Set())
    assert.deepEqual([...targets.keys()], ['host', 'http:portal'])
  })
})
