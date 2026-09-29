/**
 * Colector de metricas del sistema operativo. Sin dependencias: solo `node:os`.
 *
 * El uso de CPU no es un valor que el kernel exponga, es una derivada. Lo que
 * hay son contadores acumulados desde el arranque (tiempo en modo usuario, en
 * sistema, en idle...), monotonos crecientes. El uso instantaneo requiere dos
 * lecturas separadas en el tiempo:
 *
 *   uso% = (1 - delta_idle / delta_total) * 100
 *
 * Calcularlo sobre una sola lectura absoluta devuelve el promedio historico
 * desde el encendido, no el uso actual: un servidor con 200 dias de uptime al
 * 100% reportaria un valor cercano a cero. El mismo principio aplica a bytes
 * de red, IOPS de disco y peticiones servidas: casi toda metrica de
 * infraestructura es un contador.
 */

import os from 'node:os'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Suma los contadores de tiempo de CPU de todos los nucleos.
 * @returns {{ idle: number, total: number }} milisegundos acumulados
 */
export function readCpuTimes () {
  let idle = 0
  let total = 0
  for (const { times } of os.cpus()) {
    idle += times.idle
    // Todos los campos: omitir `sys` o `irq` subestima el uso bajo carga de E/S.
    for (const v of Object.values(times)) total += v
  }
  return { idle, total }
}

/**
 * Uso de CPU entre dos lecturas. Funcion pura: no consulta el sistema.
 * @param {{ idle: number, total: number }} a lectura anterior
 * @param {{ idle: number, total: number }} b lectura posterior
 * @returns {number} porcentaje 0..100 redondeado a 2 decimales
 */
export function cpuUsagePercent (a, b) {
  const dTotal = b.total - a.total
  if (dTotal <= 0) return 0
  const dIdle = b.idle - a.idle
  // Se acota a 0..100: en VMs cuyo reloj salta se observan deltas incoherentes.
  const pct = Math.min(100, Math.max(0, (1 - dIdle / dTotal) * 100))
  return round2(pct)
}

/**
 * Memoria del sistema. Lectura instantanea, sin derivada.
 *
 * Nota para despliegue en contenedor: `os.totalmem()` reporta la RAM del host,
 * no el limite del cgroup, por lo que un contenedor con `--memory` acotado
 * nunca alcanzaria el umbral. El limite real esta en /sys/fs/cgroup/memory.max.
 *
 * @returns {{ totalBytes: number, freeBytes: number, usedBytes: number, usedPercent: number }}
 */
export function readMemory () {
  const totalBytes = os.totalmem()
  const freeBytes = os.freemem()
  const usedBytes = totalBytes - freeBytes
  return {
    totalBytes,
    freeBytes,
    usedBytes,
    usedPercent: totalBytes > 0 ? round2((usedBytes / totalBytes) * 100) : 0
  }
}

const round2 = (n) => Math.round(n * 100) / 100

/**
 * Limites y contadores del cgroup v2 del proceso, si existen.
 *
 * Dentro de un contenedor, `node:os` reporta la maquina anfitriona: la RAM y
 * los nucleos del host, no los del contenedor. Un contenedor limitado a 256 MB
 * que esta a punto de ser eliminado por el OOM killer se veria "al 20%". Cuando
 * hay un limite de cgroup, ese limite es la verdad operativa.
 *
 * Devuelve null si no hay cgroup v2 o si no hay ningun limite: en ese caso las
 * lecturas del host son las correctas (una VM o un servidor fisico).
 *
 * @param {string} [root] directorio del cgroup, parametrizable para pruebas
 * @returns {null | { memMaxBytes: number|null, memUsedBytes: number|null,
 *   cpuLimitCores: number|null, cpuUsageUsec: number|null }}
 */
export function readCgroup (root = '/sys/fs/cgroup') {
  const read = (file) => {
    try { return readFileSync(join(root, file), 'utf8').trim() } catch { return null }
  }

  const memMax = read('memory.max')
  const cpuMax = read('cpu.max')
  if (memMax === null && cpuMax === null) return null

  let memMaxBytes = null
  let memUsedBytes = null
  if (memMax && memMax !== 'max') {
    memMaxBytes = Number(memMax)
    const current = Number(read('memory.current'))
    // memory.current incluye la cache de paginas, que el kernel libera bajo
    // presion. Restar inactive_file es el mismo criterio que usa `docker stats`.
    const inactive = Number(/^inactive_file (\d+)$/m.exec(read('memory.stat') ?? '')?.[1] ?? 0)
    if (Number.isFinite(current)) memUsedBytes = Math.max(0, current - inactive)
  }

  let cpuLimitCores = null
  if (cpuMax) {
    const [quota, period] = cpuMax.split(/\s+/)
    if (quota !== 'max' && Number(period) > 0) cpuLimitCores = Number(quota) / Number(period)
  }
  const usage = /^usage_usec (\d+)$/m.exec(read('cpu.stat') ?? '')?.[1]
  const cpuUsageUsec = usage === undefined ? null : Number(usage)

  if (memMaxBytes === null && cpuLimitCores === null) return null
  return { memMaxBytes, memUsedBytes, cpuLimitCores, cpuUsageUsec }
}

/**
 * Uso de CPU de un cgroup limitado, como porcentaje de su cuota. Funcion pura.
 * Un contenedor con `cpus: 0.5` que consume medio nucleo esta al 100%, aunque
 * el host tenga 16 nucleos ociosos.
 *
 * @param {number} usageDeltaUsec tiempo de CPU consumido en el intervalo
 * @param {number} wallDeltaUsec tiempo real transcurrido
 * @param {number} limitCores cuota en nucleos (quota / period)
 */
export function cgroupCpuPercent (usageDeltaUsec, wallDeltaUsec, limitCores) {
  if (!(wallDeltaUsec > 0) || !(limitCores > 0)) return 0
  const pct = (usageDeltaUsec / (wallDeltaUsec * limitCores)) * 100
  return round2(Math.min(100, Math.max(0, pct)))
}

/**
 * Toma una muestra completa del sistema operativo. Espera `sampleMs` entre las
 * dos lecturas de CPU necesarias para calcular la derivada.
 *
 * @param {{ sampleMs?: number }} opts
 */
export async function sampleOs ({ sampleMs = 200, cgroupRoot } = {}) {
  const cgA = readCgroup(cgroupRoot)
  const t0 = process.hrtime.bigint()
  const a = readCpuTimes()
  await new Promise((resolve) => setTimeout(resolve, sampleMs))
  const b = readCpuTimes()
  const cgB = readCgroup(cgroupRoot)
  const wallUsec = Number((process.hrtime.bigint() - t0) / 1000n)

  let cpuPercent = cpuUsagePercent(a, b)
  let memory = readMemory()
  let scope = 'host'

  if (cgB?.cpuLimitCores && cgA?.cpuUsageUsec != null && cgB.cpuUsageUsec != null) {
    cpuPercent = cgroupCpuPercent(cgB.cpuUsageUsec - cgA.cpuUsageUsec, wallUsec, cgB.cpuLimitCores)
    scope = 'cgroup'
  }
  if (cgB?.memMaxBytes && cgB.memUsedBytes != null) {
    const totalBytes = cgB.memMaxBytes
    const usedBytes = Math.min(cgB.memUsedBytes, totalBytes)
    memory = {
      totalBytes,
      freeBytes: totalBytes - usedBytes,
      usedBytes,
      usedPercent: round2((usedBytes / totalBytes) * 100)
    }
    scope = 'cgroup'
  }

  return {
    cpuPercent,
    memory,
    scope,
    loadAvg1m: os.loadavg()[0],
    uptimeSec: Math.floor(os.uptime()),
    platform: process.platform,
    hostname: os.hostname()
  }
}
