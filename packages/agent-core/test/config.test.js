import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig, ConfigError } from '../src/config.js'

// loadConfig recibe `env` como parametro en vez de leer la global, lo que
// permite probar cualquier combinacion sin tocar el entorno del proceso.
const min = { MIND_NODE_NAME: 'srv-web-01' }

describe('loadConfig - camino feliz', () => {
  test('aplica todos los defaults con solo la variable obligatoria', () => {
    const cfg = loadConfig(min)
    assert.equal(cfg.nodeName, 'srv-web-01')
    assert.equal(cfg.intervalMs, 15000)
    assert.equal(cfg.logLevel, 'info')
    assert.equal(cfg.cpuWarn, 85)
    assert.equal(cfg.memWarn, 90)
    assert.equal(cfg.failuresToDegrade, 2)
    assert.equal(cfg.failuresToDown, 4)
    assert.equal(cfg.hubUrl, null)
    assert.equal(cfg.mode, 'standalone')
  })

  test('convierte los strings del entorno a numeros de verdad', () => {
    const cfg = loadConfig({ ...min, MIND_INTERVAL_MS: '30000', MIND_CPU_WARN: '70.5' })
    assert.equal(typeof cfg.intervalMs, 'number')
    assert.equal(cfg.intervalMs, 30000)
    assert.equal(cfg.cpuWarn, 70.5)
  })

  test('devuelve el objeto congelado', () => {
    const cfg = loadConfig(min)
    assert.ok(Object.isFrozen(cfg), 'la config debe venir con Object.freeze')
  })
})

describe('loadConfig - modo de operacion', () => {
  test('sin MIND_HUB_URL el modo es standalone', () => {
    assert.equal(loadConfig(min).mode, 'standalone')
  })

  test('con MIND_HUB_URL el modo es hub', () => {
    const cfg = loadConfig({ ...min, MIND_HUB_URL: 'https://hub.example.com' })
    assert.equal(cfg.mode, 'hub')
    assert.equal(cfg.hubUrl, 'https://hub.example.com')
  })

  test('rechaza una MIND_HUB_URL que no es URL http/https', () => {
    assert.throws(() => loadConfig({ ...min, MIND_HUB_URL: 'no-es-una-url' }), ConfigError)
    assert.throws(() => loadConfig({ ...min, MIND_HUB_URL: 'ftp://legacy.example.net' }), ConfigError)
  })
})

describe('loadConfig - validacion', () => {
  test('exige MIND_NODE_NAME', () => {
    assert.throws(() => loadConfig({}), ConfigError)
  })

  test('trata una variable vacia como ausente', () => {
    // Una variable declarada sin valor es facil de introducir por accidente
    // en un Dockerfile o una unit de systemd.
    assert.throws(() => loadConfig({ MIND_NODE_NAME: '' }), ConfigError)
  })

  test('rechaza un intervalo no numerico', () => {
    // Number('abc') devuelve NaN sin lanzar, y el NaN se propaga en silencio.
    assert.throws(() => loadConfig({ ...min, MIND_INTERVAL_MS: 'abc' }), ConfigError)
  })

  test('rechaza un intervalo por debajo del minimo de 1000ms', () => {
    assert.throws(() => loadConfig({ ...min, MIND_INTERVAL_MS: '500' }), ConfigError)
  })

  test('rechaza un intervalo no entero', () => {
    assert.throws(() => loadConfig({ ...min, MIND_INTERVAL_MS: '15.5' }), ConfigError)
  })

  test('rechaza un nivel de log desconocido', () => {
    assert.throws(() => loadConfig({ ...min, MIND_LOG_LEVEL: 'verbose' }), ConfigError)
  })

  test('rechaza umbrales fuera del rango 0..100', () => {
    assert.throws(() => loadConfig({ ...min, MIND_CPU_WARN: '150' }), ConfigError)
    assert.throws(() => loadConfig({ ...min, MIND_MEM_WARN: '-1' }), ConfigError)
  })

  test('exige que failuresToDown sea mayor que failuresToDegrade', () => {
    // Con umbrales iguales, DEGRADED es inalcanzable y se pierde la senal
    // temprana previa a la caida.
    assert.throws(
      () => loadConfig({ ...min, MIND_FAILURES_TO_DEGRADE: '4', MIND_FAILURES_TO_DOWN: '4' }),
      ConfigError
    )
    assert.throws(
      () => loadConfig({ ...min, MIND_FAILURES_TO_DEGRADE: '5', MIND_FAILURES_TO_DOWN: '2' }),
      ConfigError
    )
  })

  test('reporta TODOS los problemas de una vez, no solo el primero', () => {
    // Permite corregir toda la configuracion en un reinicio en lugar de
    // descubrir los problemas de a uno.
    try {
      loadConfig({ MIND_INTERVAL_MS: 'abc', MIND_LOG_LEVEL: 'verbose', MIND_CPU_WARN: '900' })
      assert.fail('deberia haber lanzado ConfigError')
    } catch (err) {
      assert.ok(err instanceof ConfigError)
      assert.ok(Array.isArray(err.problems), 'ConfigError debe exponer .problems')
      assert.ok(
        err.problems.length >= 4,
        `esperaba al menos 4 problemas (nombre, intervalo, nivel, cpu), llegaron ${err.problems.length}`
      )
    }
  })
})
