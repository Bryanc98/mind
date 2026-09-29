/**
 * Almacenamiento en PostgreSQL. Sin logica de negocio: traduce la interfaz
 * del servicio a SQL parametrizado.
 */
import pg from 'pg'

const toNode = (r) => r && {
  node: r.node,
  lastSeen: Number(r.last_seen),
  lastReportAt: Number(r.last_report_at),
  intervalMs: r.interval_ms,
  agentVersion: r.agent_version,
  host: r.host,
  targets: r.targets,
  silent: r.silent
}

const toEvent = (x) => ({
  id: Number(x.id),
  node: x.node,
  target: x.target,
  from: x.from_status,
  to: x.to_status,
  at: Number(x.at),
  reason: x.reason,
  ...(x.logs ? { logs: x.logs } : {})
})

export function createPostgresStore ({ connectionString }) {
  const pool = new pg.Pool({ connectionString, max: 10 })

  return {
    pool,
    async createAgent ({ node, tokenHash }) {
      try {
        await pool.query('INSERT INTO agents (node, token_hash) VALUES ($1, $2)', [node, tokenHash])
      } catch (err) {
        if (err.code === '23505') throw new Error(`ya existe un agente activo para el nodo ${node}`)
        throw err
      }
    },
    async revokeAgent (node) {
      const r = await pool.query('UPDATE agents SET revoked_at = now() WHERE node = $1 AND revoked_at IS NULL', [node])
      return r.rowCount
    },
    async listAgents () {
      const r = await pool.query('SELECT node, created_at, revoked_at FROM agents ORDER BY node, created_at')
      return r.rows.map((x) => ({ node: x.node, createdAt: x.created_at, revokedAt: x.revoked_at }))
    },
    async getAgentByTokenHash (hash) {
      const r = await pool.query('SELECT node, revoked_at FROM agents WHERE token_hash = $1', [hash])
      return r.rows[0] ? { node: r.rows[0].node, revokedAt: r.rows[0].revoked_at } : null
    },
    async getNode (node) {
      const r = await pool.query('SELECT * FROM nodes WHERE node = $1', [node])
      return toNode(r.rows[0]) ?? null
    },
    async upsertNode (n) {
      await pool.query(
        `INSERT INTO nodes (node, last_seen, last_report_at, interval_ms, agent_version, host, targets, silent)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (node) DO UPDATE SET
           last_seen = EXCLUDED.last_seen, last_report_at = EXCLUDED.last_report_at,
           interval_ms = EXCLUDED.interval_ms, agent_version = EXCLUDED.agent_version,
           host = EXCLUDED.host, targets = EXCLUDED.targets, silent = EXCLUDED.silent`,
        [n.node, n.lastSeen, n.lastReportAt, n.intervalMs, n.agentVersion, JSON.stringify(n.host), JSON.stringify(n.targets), n.silent]
      )
    },
    async listNodes () {
      const r = await pool.query('SELECT * FROM nodes ORDER BY node')
      return r.rows.map(toNode)
    },
    async insertEvents (evs) {
      for (const e of evs) {
        await pool.query(
          'INSERT INTO events (node, target, from_status, to_status, at, reason, logs) VALUES ($1, $2, $3, $4, $5, $6, $7)',
          [e.node, e.target, e.from, e.to, e.at, e.reason ?? null, e.logs ?? null]
        )
      }
    },
    async listEvents (limit) {
      const r = await pool.query('SELECT * FROM events ORDER BY at DESC, id DESC LIMIT $1', [limit])
      return r.rows.map(toEvent)
    },
    async listEventsSince (since) {
      const r = await pool.query('SELECT * FROM events WHERE at >= $1 ORDER BY at, id', [since])
      return r.rows.map(toEvent)
    },
    async createDiagnosis (d) {
      const r = await pool.query(
        `INSERT INTO diagnoses (created_at, status, provider, model, prompt_version, triggers)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [d.createdAt, d.status, d.provider, d.model, d.promptVersion, JSON.stringify(d.triggers)]
      )
      return Number(r.rows[0].id)
    },
    async updateDiagnosis (id, d) {
      // Actualizacion parcial: solo los campos presentes en `d`.
      const cols = { status: 'status', result: 'result', error: 'error', latencyMs: 'latency_ms', context: 'context', provider: 'provider', model: 'model' }
      const sets = []
      const values = [id]
      for (const [k, col] of Object.entries(cols)) {
        if (!(k in d)) continue
        const v = d[k]
        values.push((k === 'result' || k === 'context') && v != null ? JSON.stringify(v) : (v ?? null))
        sets.push(`${col} = $${values.length}`)
      }
      if (sets.length) await pool.query(`UPDATE diagnoses SET ${sets.join(', ')} WHERE id = $1`, values)
    },
    async listDiagnoses (limit) {
      const r = await pool.query('SELECT * FROM diagnoses ORDER BY created_at DESC, id DESC LIMIT $1', [limit])
      return r.rows.map((x) => ({
        id: Number(x.id),
        createdAt: Number(x.created_at),
        status: x.status,
        provider: x.provider,
        model: x.model,
        promptVersion: x.prompt_version,
        triggers: x.triggers,
        result: x.result,
        error: x.error,
        latencyMs: x.latency_ms,
        context: x.context
      }))
    },
    async countDiagnosesSince (since) {
      const r = await pool.query('SELECT count(*)::int AS n FROM diagnoses WHERE created_at >= $1', [since])
      return r.rows[0].n
    },
    async insertSample (s) {
      await pool.query('INSERT INTO samples (node, at, cpu, mem) VALUES ($1, $2, $3, $4)', [s.node, s.at, s.cpu, s.mem])
    },
    async listSamples (since) {
      const r = await pool.query('SELECT node, at, cpu, mem FROM samples WHERE at >= $1 ORDER BY at', [since])
      return r.rows.map((x) => ({ node: x.node, at: Number(x.at), cpu: x.cpu, mem: x.mem }))
    },
    async pruneSamples (before) {
      await pool.query('DELETE FROM samples WHERE at < $1', [before])
      await pool.query('DELETE FROM app_samples WHERE at < $1', [before])
    },
    async insertAppSamples (rows) {
      for (const r of rows) {
        await pool.query(
          'INSERT INTO app_samples (node, app, at, latency_ms, ok) VALUES ($1, $2, $3, $4, $5)',
          [r.node, r.app, r.at, r.latencyMs, r.ok]
        )
      }
    },
    async listAppSamples (since) {
      const r = await pool.query('SELECT node, app, at, latency_ms, ok FROM app_samples WHERE at >= $1 ORDER BY at', [since])
      return r.rows.map((x) => ({ node: x.node, app: x.app, at: Number(x.at), latencyMs: x.latency_ms, ok: x.ok }))
    },
    close: () => pool.end()
  }
}
