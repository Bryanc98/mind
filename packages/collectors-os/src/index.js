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

/**
 * Suma los contadores de tiempo de CPU de todos los nucleos.
 * @returns {{ idle: number, total: number }} milisegundos acumulados
 */
export function readCpuTimes () {
  // TODO: implementar. `total` suma todos los campos de `times`, no solo
  // idle y user: omitir `sys` o `irq` subestima el uso bajo carga de E/S.
  throw new Error('readCpuTimes: sin implementar')
}

/**
 * Uso de CPU entre dos lecturas. Funcion pura: no consulta el sistema.
 * @param {{ idle: number, total: number }} a lectura anterior
 * @param {{ idle: number, total: number }} b lectura posterior
 * @returns {number} porcentaje 0..100 redondeado a 2 decimales
 */
export function cpuUsagePercent (a, b) {
  // TODO: implementar. Delta total de cero devuelve 0, nunca NaN. El
  // resultado se acota a 0..100: en VMs cuyo reloj salta se observan deltas
  // incoherentes.
  throw new Error('cpuUsagePercent: sin implementar')
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
  // TODO: implementar
  throw new Error('readMemory: sin implementar')
}

/**
 * Toma una muestra completa del sistema operativo. Espera `sampleMs` entre las
 * dos lecturas de CPU necesarias para calcular la derivada.
 *
 * @param {{ sampleMs?: number }} opts
 */
export async function sampleOs ({ sampleMs = 200 } = {}) {
  const a = readCpuTimes()
  await new Promise((resolve) => setTimeout(resolve, sampleMs))
  const b = readCpuTimes()

  return {
    cpuPercent: cpuUsagePercent(a, b),
    memory: readMemory(),
    loadAvg1m: os.loadavg()[0],
    uptimeSec: Math.floor(os.uptime()),
    platform: process.platform,
    hostname: os.hostname()
  }
}
