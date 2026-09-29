import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readCpuTimes, cpuUsagePercent, readMemory, sampleOs, readCgroup, cgroupCpuPercent } from '../src/index.js'

describe('cpuUsagePercent - la derivada', () => {
  // Las lecturas son sinteticas. Al ser una funcion pura se pueden probar
  // casos imposibles de provocar a mano: 100% de uso, deltas negativos,
  // intervalos de duracion cero.

  test('50% de uso', () => {
    // pasaron 200 unidades de tiempo, 100 en idle
    assert.equal(cpuUsagePercent({ idle: 0, total: 0 }, { idle: 100, total: 200 }), 50)
  })

  test('0% de uso: todo el tiempo transcurrido fue idle', () => {
    assert.equal(cpuUsagePercent({ idle: 0, total: 0 }, { idle: 200, total: 200 }), 0)
  })

  test('100% de uso: nada de idle', () => {
    assert.equal(cpuUsagePercent({ idle: 0, total: 0 }, { idle: 0, total: 200 }), 100)
  })

  test('usa los DELTAS, no los valores absolutos', () => {
    // Un servidor con mucho uptime tiene contadores enormes y mayormente
    // idle. Calcular 1 - idle/total sobre la lectura absoluta daria ~2% en
    // este caso, cuando el uso real del intervalo es 75%.
    const a = { idle: 9_800_000, total: 10_000_000 }
    const b = { idle: 9_800_100, total: 10_000_400 } // en el intervalo: 400 total, 100 idle
    assert.equal(cpuUsagePercent(a, b), 75)
  })

  test('delta total cero -> 0, nunca NaN', () => {
    // Dos lecturas identicas, o un intervalo mas corto que la resolucion del
    // reloj. Dividir por cero no lanza en JS: devuelve NaN o Infinity.
    const r = cpuUsagePercent({ idle: 100, total: 500 }, { idle: 100, total: 500 })
    assert.equal(r, 0)
    assert.ok(!Number.isNaN(r), 'no debe devolver NaN')
  })

  test('acota el resultado al rango 0..100', () => {
    // En VMs cuyo reloj salta (migracion en vivo, suspension del host) se
    // observan deltas incoherentes. Un -50% o un 150% en una grafica es peor
    // que un dato ausente, porque parece valido.
    assert.equal(cpuUsagePercent({ idle: 0, total: 0 }, { idle: 150, total: 100 }), 0)
    assert.equal(cpuUsagePercent({ idle: 0, total: 0 }, { idle: -50, total: 100 }), 100)
  })

  test('redondea a 2 decimales', () => {
    // 1 - 1/3 = 0.6666... -> 66.67
    assert.equal(cpuUsagePercent({ idle: 0, total: 0 }, { idle: 1, total: 3 }), 66.67)
  })

  test('es pura: no muta sus argumentos', () => {
    const a = Object.freeze({ idle: 0, total: 0 })
    const b = Object.freeze({ idle: 100, total: 200 })
    assert.equal(cpuUsagePercent(a, b), 50)
  })
})

describe('readCpuTimes - los contadores del kernel', () => {
  test('devuelve idle y total coherentes', () => {
    const t = readCpuTimes()
    assert.equal(typeof t.idle, 'number')
    assert.equal(typeof t.total, 'number')
    assert.ok(t.total > 0, 'total debe ser > 0')
    assert.ok(t.idle > 0, 'idle debe ser > 0 en cualquier maquina real')
    assert.ok(t.total > t.idle, 'total incluye a idle mas todo lo demas')
  })

  test('suma TODOS los campos de times, no solo idle+user', () => {
    // Omitir `sys` o `irq` subestima el uso precisamente bajo carga de E/S
    // alta, que es cuando `sys` crece.
    const cpus = os.cpus()
    const esperado = cpus.reduce(
      (acc, c) => acc + Object.values(c.times).reduce((s, v) => s + v, 0),
      0
    )
    const t = readCpuTimes()
    // Los contadores avanzan entre ambas lecturas, de ahi la tolerancia.
    // Omitir un campo produciria una diferencia mucho mayor.
    const desvio = Math.abs(t.total - esperado) / esperado
    assert.ok(desvio < 0.01, `total se desvia ${(desvio * 100).toFixed(2)}% de la suma completa de times`)
  })

  test('los contadores son monotonos crecientes', () => {
    const a = readCpuTimes()
    const b = readCpuTimes()
    assert.ok(b.total >= a.total, 'son acumulados desde el arranque: nunca bajan')
    assert.ok(b.idle >= a.idle)
  })
})

describe('readMemory', () => {
  test('devuelve la forma esperada y coherente', () => {
    const m = readMemory()
    assert.ok(m.totalBytes > 0)
    assert.ok(m.freeBytes >= 0)
    assert.equal(m.usedBytes, m.totalBytes - m.freeBytes)
    assert.ok(m.usedPercent >= 0 && m.usedPercent <= 100)
  })

  test('usedPercent redondeado a 2 decimales', () => {
    const { usedPercent } = readMemory()
    const decimales = String(usedPercent).split('.')[1] ?? ''
    assert.ok(decimales.length <= 2, `usedPercent tiene ${decimales.length} decimales: ${usedPercent}`)
  })
})

describe('sampleOs - integracion', () => {
  // Integra las tres funciones anteriores.
  test('produce una muestra completa del nodo', async () => {
    const s = await sampleOs({ sampleMs: 60 })
    assert.ok(s.cpuPercent >= 0 && s.cpuPercent <= 100, `cpuPercent fuera de rango: ${s.cpuPercent}`)
    assert.ok(!Number.isNaN(s.cpuPercent))
    assert.ok(s.memory.totalBytes > 0)
    assert.equal(typeof s.uptimeSec, 'number')
    assert.equal(typeof s.hostname, 'string')
    assert.ok(s.hostname.length > 0)
  })

  test('respeta el tiempo de muestreo', async () => {
    // Sin espera entre lecturas el delta seria cero y el uso saldria siempre
    // 0%: el tiempo transcurrido es lo que produce la senal.
    const t0 = Date.now()
    await sampleOs({ sampleMs: 100 })
    assert.ok(Date.now() - t0 >= 95, 'sampleOs debe esperar sampleMs entre lecturas')
  })
})

describe('cgroup v2 - limites del contenedor', () => {
  // Dentro de un contenedor, node:os ve la maquina anfitriona. Las pruebas usan
  // un directorio falso con la misma estructura que /sys/fs/cgroup.
  function fakeCgroup (files) {
    const dir = mkdtempSync(join(tmpdir(), 'mind-cg-'))
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content)
    return dir
  }

  test('sin archivos de cgroup devuelve null (VM o servidor fisico)', () => {
    const dir = fakeCgroup({})
    assert.equal(readCgroup(dir), null)
    rmSync(dir, { recursive: true })
  })

  test('sin limites devuelve null: las lecturas del host son las correctas', () => {
    const dir = fakeCgroup({ 'memory.max': 'max\n', 'cpu.max': 'max 100000\n' })
    assert.equal(readCgroup(dir), null)
    rmSync(dir, { recursive: true })
  })

  test('lee el limite de memoria y descuenta la cache inactiva', () => {
    const dir = fakeCgroup({
      'memory.max': '268435456\n',
      'memory.current': '200000000\n',
      'memory.stat': 'anon 150000000\ninactive_file 50000000\nactive_file 1\n',
      'cpu.max': '50000 100000\n',
      'cpu.stat': 'usage_usec 123456\nuser_usec 1\n'
    })
    const cg = readCgroup(dir)
    assert.equal(cg.memMaxBytes, 268435456)
    assert.equal(cg.memUsedBytes, 150000000, 'la cache de paginas no es memoria comprometida')
    assert.equal(cg.cpuLimitCores, 0.5)
    assert.equal(cg.cpuUsageUsec, 123456)
    rmSync(dir, { recursive: true })
  })

  test('la CPU se mide contra la cuota, no contra el host', () => {
    // Medio nucleo consumido con cuota de medio nucleo: 100%.
    assert.equal(cgroupCpuPercent(500_000, 1_000_000, 0.5), 100)
    assert.equal(cgroupCpuPercent(250_000, 1_000_000, 0.5), 50)
    assert.equal(cgroupCpuPercent(0, 0, 0.5), 0, 'intervalo cero no produce NaN')
    assert.equal(cgroupCpuPercent(900_000, 1_000_000, 0.5), 100, 'se acota a 100')
  })

  test('sampleOs usa el cgroup cuando hay limite de memoria', async () => {
    const dir = fakeCgroup({
      'memory.max': '1000\n',
      'memory.current': '900\n',
      'memory.stat': 'inactive_file 400\n'
    })
    const s = await sampleOs({ sampleMs: 10, cgroupRoot: dir })
    assert.equal(s.scope, 'cgroup')
    assert.equal(s.memory.totalBytes, 1000)
    assert.equal(s.memory.usedPercent, 50)
    rmSync(dir, { recursive: true })
  })
})
