/**
 * Logica del Hub, independiente del transporte HTTP y de la base de datos.
 *
 * El almacenamiento es intercambiable (memoria para pruebas, PostgreSQL en
 * produccion) y no toma decisiones: toda regla vive aqui y se prueba una vez.
 */

import { hashToken } from './tokens.js'

export const AGENT_TARGET = 'agente'

/**
 * @param {{ store: object, staleFactor?: number, retentionMs?: number, now?: () => number,
 *   onEvents?: (events: object[]) => void }} opts
 */
export function createHubService ({ store, staleFactor = 3, retentionMs = 24 * 3600 * 1000, now = Date.now, onEvents = () => {} }) {
  return {
    /** @returns {Promise<{ node: string } | null>} */
    async authenticate (token) {
      if (!token) return null
      const agent = await store.getAgentByTokenHash(hashToken(token))
      if (!agent || agent.revokedAt) return null
      return { node: agent.node }
    },

    /**
     * Registra un reporte. Los reportes pueden llegar desordenados: al volver
     * la red, el agente reenvia su cola, y el ultimo en llegar puede ser de hace
     * una hora. Los eventos y las muestras se guardan siempre (son historia);
     * el estado actual del nodo solo se actualiza con un reporte mas reciente
     * que el que ya se tiene.
     */
    async ingest (report) {
      const receivedAt = now()
      const prev = await store.getNode(report.node)
      const events = report.events.map((e) => ({ node: report.node, ...e }))

      const isNewer = !prev || report.sentAt >= prev.lastReportAt
      const next = {
        node: report.node,
        lastSeen: receivedAt,
        lastReportAt: isNewer ? report.sentAt : prev.lastReportAt,
        intervalMs: isNewer ? report.intervalMs : prev.intervalMs,
        agentVersion: isNewer ? (report.agentVersion ?? null) : prev.agentVersion,
        host: isNewer ? report.host : prev.host,
        targets: isNewer ? report.targets : prev.targets,
        silent: false
      }

      // El nodo estaba en silencio y volvio a reportar: se cierra el incidente.
      if (prev?.silent) {
        events.push({
          node: report.node,
          target: AGENT_TARGET,
          from: 'DOWN',
          to: 'UP',
          at: receivedAt,
          reason: 'el agente volvio a reportar'
        })
      }

      await store.upsertNode(next)
      if (events.length) {
        await store.insertEvents(events)
        onEvents(events)
      }
      await store.insertSample({ node: report.node, at: report.sentAt, cpu: report.host.cpuPercent, mem: report.host.memPercent })
      const apps = report.targets.filter((t) => t.kind === 'http')
      if (apps.length) {
        await store.insertAppSamples(apps.map((t) => ({
          node: report.node,
          app: t.name,
          at: report.sentAt,
          latencyMs: t.latencyMs ?? null,
          // El exito de este sondeo, no el estado: DEGRADED puede venir de un
          // sondeo que ya respondio bien.
          ok: t.consecutiveFailures === 0
        })))
      }
      return { stale: !isNewer }
    },

    /**
     * Dead man's switch: un nodo que deja de reportar durante `staleFactor`
     * intervalos se declara caido. En un modelo push, el silencio es la unica
     * senal de que un servidor se apago, se colgo o perdio la red; sin esta
     * regla, un nodo muerto se veria "UP" para siempre con su ultimo reporte.
     *
     * Emite un evento por transicion, no uno por ciclo.
     */
    async sweep () {
      const t = now()
      const silenced = []
      for (const n of await store.listNodes()) {
        const limit = n.intervalMs * staleFactor
        if (!n.silent && t - n.lastSeen > limit) {
          await store.upsertNode({ ...n, silent: true })
          silenced.push(n.node)
          const ev = {
            node: n.node,
            target: AGENT_TARGET,
            from: 'UP',
            to: 'DOWN',
            at: t,
            reason: `sin reportes desde hace ${Math.ceil((t - n.lastSeen) / 1000)}s (limite ${Math.round(limit / 1000)}s)`
          }
          await store.insertEvents([ev])
          onEvents([ev])
        }
      }
      await store.pruneSamples(t - retentionMs)
      return { silenced }
    },

    /** Vista de la flota para el panel. */
    async fleet ({ historyMs = 10 * 60 * 1000 } = {}) {
      const t = now()
      const since = t - historyMs
      const [nodes, samples, appSamples] = await Promise.all([
        store.listNodes(), store.listSamples(since), store.listAppSamples(since)
      ])
      return nodes
        .map((n) => ({
          node: n.node,
          status: n.silent ? 'DOWN' : (n.targets.find((x) => x.kind === 'host')?.status ?? 'UNKNOWN'),
          silent: n.silent,
          lastSeen: n.lastSeen,
          secondsSinceLastSeen: Math.round((t - n.lastSeen) / 1000),
          intervalMs: n.intervalMs,
          agentVersion: n.agentVersion,
          host: n.host,
          apps: n.targets.filter((x) => x.kind === 'http').map((a) => ({
            ...a,
            history: appSamples
              .filter((s) => s.node === n.node && s.app === a.name)
              .map(({ at, latencyMs, ok }) => ({ at, latencyMs, ok }))
          })),
          containers: n.targets.filter((x) => x.kind === 'container'),
          history: samples.filter((s) => s.node === n.node).map(({ at, cpu, mem }) => ({ at, cpu, mem }))
        }))
        .sort((a, b) => a.node.localeCompare(b.node))
    },

    // La lista de eventos del panel no lleva los logs: son pesados y solo los
    // necesita el diagnostico.
    events: async (limit = 50) => (await store.listEvents(limit)).map(({ logs, ...e }) => ({ ...e, hasLogs: Boolean(logs) })),

    diagnoses: (limit = 10) => store.listDiagnoses(limit)
  }
}
