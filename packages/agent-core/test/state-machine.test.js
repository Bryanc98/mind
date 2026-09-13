import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { STATES, initialState, nextState } from '../src/state-machine.js'

const cfg = { failuresToDegrade: 2, failuresToDown: 4 }

const ok = (at) => ({ ok: true, at })
const bad = (at) => ({ ok: false, at })

describe('initialState', () => {
  test('arranca en UNKNOWN, no en UP', () => {
    // Asumir salud sin haber medido produce una falsa alerta de caida si el
    // primer chequeo falla. "Nunca arranco" y "se cayo" son incidentes
    // distintos, con causas distintas.
    const s = initialState()
    assert.equal(s.status, STATES.UNKNOWN)
    assert.equal(s.consecutiveFailures, 0)
    assert.equal(s.since, null)
    assert.equal(s.changed, false)
  })
})

describe('nextState - recuperacion', () => {
  test('UNKNOWN + exito -> UP y marca el cambio', () => {
    const s = nextState(initialState(), ok(1000), cfg)
    assert.equal(s.status, STATES.UP)
    assert.equal(s.consecutiveFailures, 0)
    assert.equal(s.changed, true)
    assert.equal(s.since, 1000)
  })

  test('UP + exito -> sigue UP sin marcar cambio y conserva `since`', () => {
    // Solo se notifica el cambio de estado: un servicio sano durante dias
    // genera cero alertas.
    const prev = { status: STATES.UP, consecutiveFailures: 0, since: 1000 }
    const s = nextState(prev, ok(9999), cfg)
    assert.equal(s.status, STATES.UP)
    assert.equal(s.changed, false)
    assert.equal(s.since, 1000, '`since` es cuando ENTRO al estado, no la ultima medicion')
  })

  test('DOWN + un solo exito -> UP inmediato (recuperacion optimista)', () => {
    // Asimetria intencional: bajar de estado exige evidencia acumulada,
    // recuperarse no. Un falso positivo de recuperacion se corrige en el
    // siguiente ciclo; un falso positivo de caida cuesta una alerta nocturna.
    const prev = { status: STATES.DOWN, consecutiveFailures: 7, since: 1000 }
    const s = nextState(prev, ok(5000), cfg)
    assert.equal(s.status, STATES.UP)
    assert.equal(s.consecutiveFailures, 0, 'el contador se reinicia al recuperarse')
    assert.equal(s.changed, true)
    assert.equal(s.since, 5000)
  })

  test('DEGRADED + exito -> UP', () => {
    const prev = { status: STATES.DEGRADED, consecutiveFailures: 2, since: 1000 }
    const s = nextState(prev, ok(5000), cfg)
    assert.equal(s.status, STATES.UP)
    assert.equal(s.changed, true)
  })
})

describe('nextState - deterioro', () => {
  test('UP + 1 fallo (umbral 2) -> sigue UP, pero ya cuenta', () => {
    // Un timeout aislado rara vez es una caida real: pausa de GC, reinicio
    // de un proxy, hiccup de red.
    const prev = { status: STATES.UP, consecutiveFailures: 0, since: 1000 }
    const s = nextState(prev, bad(2000), cfg)
    assert.equal(s.status, STATES.UP)
    assert.equal(s.consecutiveFailures, 1)
    assert.equal(s.changed, false)
    assert.equal(s.since, 1000)
  })

  test('UNKNOWN + 1 fallo (umbral 2) -> sigue UNKNOWN', () => {
    // Sin evidencia suficiente se conserva el estado anterior, cualquiera
    // que sea; no se asume UP por defecto.
    const s = nextState(initialState(), bad(2000), cfg)
    assert.equal(s.status, STATES.UNKNOWN)
    assert.equal(s.consecutiveFailures, 1)
  })

  test('progresion completa UP -> DEGRADED -> DOWN', () => {
    let s = { status: STATES.UP, consecutiveFailures: 0, since: 1000 }

    s = nextState(s, bad(2000), cfg) // fallo 1
    assert.equal(s.status, STATES.UP)

    s = nextState(s, bad(3000), cfg) // fallo 2 -> alcanza failuresToDegrade
    assert.equal(s.status, STATES.DEGRADED)
    assert.equal(s.changed, true)
    assert.equal(s.since, 3000)

    s = nextState(s, bad(4000), cfg) // fallo 3 -> aun no llega a DOWN
    assert.equal(s.status, STATES.DEGRADED)
    assert.equal(s.changed, false)
    assert.equal(s.since, 3000, 'seguir en DEGRADED no reinicia `since`')

    s = nextState(s, bad(5000), cfg) // fallo 4 -> alcanza failuresToDown
    assert.equal(s.status, STATES.DOWN)
    assert.equal(s.consecutiveFailures, 4)
    assert.equal(s.changed, true)
    assert.equal(s.since, 5000)
  })

  test('DOWN + mas fallos -> sigue DOWN sin re-notificar', () => {
    let s = { status: STATES.DOWN, consecutiveFailures: 4, since: 5000 }
    for (let i = 1; i <= 3; i++) {
      s = nextState(s, bad(5000 + i * 1000), cfg)
      assert.equal(s.status, STATES.DOWN)
      assert.equal(s.changed, false, 'un objetivo caido genera una alerta, no una por ciclo')
      assert.equal(s.since, 5000, 'se conserva el instante de la caida para poder decir "caido hace 12 min"')
    }
    assert.equal(s.consecutiveFailures, 7, 'el contador sigue subiendo aunque el estado no cambie')
  })

  test('con failuresToDegrade=1 se degrada al primer fallo', () => {
    const agresivo = { failuresToDegrade: 1, failuresToDown: 2 }
    const s = nextState({ status: STATES.UP, consecutiveFailures: 0, since: 1000 }, bad(2000), agresivo)
    assert.equal(s.status, STATES.DEGRADED)
    assert.equal(s.changed, true)
  })
})

describe('nextState - pureza', () => {
  test('no muta el estado anterior', () => {
    // Object.freeze hace que cualquier asignacion a `prev` lance, ya que los
    // modulos ESM corren siempre en modo estricto. El estado compartido y
    // mutado produce fallos irreproducibles en procesos de larga duracion.
    const prev = Object.freeze({ status: STATES.UP, consecutiveFailures: 0, since: 1000 })
    const s = nextState(prev, bad(2000), cfg)
    assert.notEqual(s, prev, 'debe devolver un objeto NUEVO')
    assert.equal(prev.consecutiveFailures, 0, 'el original queda intacto')
    assert.equal(s.consecutiveFailures, 1)
  })

  test('no lee el reloj ni el entorno: mismos argumentos, mismo resultado', () => {
    const prev = { status: STATES.UP, consecutiveFailures: 1, since: 1000 }
    const a = nextState(prev, bad(2000), cfg)
    const b = nextState(prev, bad(2000), cfg)
    assert.deepEqual(a, b)
  })
})
