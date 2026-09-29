/**
 * Migraciones versionadas: archivos SQL numerados en `migrations/`, aplicados
 * en orden y una sola vez. Cada una corre en su propia transaccion, asi que
 * una migracion que falla no deja el esquema a medias.
 *
 * El advisory lock serializa el arranque de varias replicas del Hub: sin el,
 * dos instancias arrancando a la vez aplicarian la misma migracion dos veces.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const DIR = fileURLToPath(new URL('../migrations/', import.meta.url))
const LOCK_ID = 7_463_001

export async function migrate (pool, { logger } = {}) {
  const client = await pool.connect()
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID])
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`)
    const done = new Set((await client.query('SELECT version FROM schema_migrations')).rows.map((r) => r.version))
    const files = readdirSync(DIR).filter((f) => /^\d+_.+\.sql$/.test(f)).sort()

    for (const file of files) {
      if (done.has(file)) continue
      await client.query('BEGIN')
      try {
        await client.query(readFileSync(join(DIR, file), 'utf8'))
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file])
        await client.query('COMMIT')
        logger?.info('migracion aplicada', { version: file })
      } catch (err) {
        await client.query('ROLLBACK')
        throw new Error(`migracion ${file} fallo: ${err.message}`)
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {})
    client.release()
  }
}
