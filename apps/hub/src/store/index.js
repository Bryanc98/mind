import { createMemoryStore } from './memory.js'
import { createPostgresStore } from './postgres.js'
import { migrate } from '../migrate.js'

/** Crea el almacenamiento configurado y, si es PostgreSQL, aplica migraciones. */
export async function openStore (cfg, { logger } = {}) {
  if (cfg.store === 'memory') return createMemoryStore()
  const store = createPostgresStore({ connectionString: cfg.databaseUrl })
  await migrate(store.pool, { logger })
  return store
}
