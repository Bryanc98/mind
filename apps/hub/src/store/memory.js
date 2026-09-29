/**
 * Almacenamiento en memoria. Implementa la misma interfaz que el de
 * PostgreSQL; se usa en las pruebas y para probar el Hub sin base de datos.
 */
export function createMemoryStore () {
  const agents = new Map()
  const nodes = new Map()
  const events = []
  let samples = []
  let appSamples = []
  let seq = 0

  return {
    async createAgent ({ node, tokenHash }) {
      if ([...agents.values()].some((a) => a.node === node && !a.revokedAt)) {
        throw new Error(`ya existe un agente activo para el nodo ${node}`)
      }
      agents.set(tokenHash, { node, tokenHash, createdAt: Date.now(), revokedAt: null })
    },
    async revokeAgent (node) {
      let n = 0
      for (const a of agents.values()) if (a.node === node && !a.revokedAt) { a.revokedAt = Date.now(); n++ }
      return n
    },
    listAgents: async () => [...agents.values()].map(({ node, createdAt, revokedAt }) => ({ node, createdAt, revokedAt })),
    getAgentByTokenHash: async (hash) => agents.get(hash) ?? null,
    getNode: async (node) => structuredClone(nodes.get(node) ?? null),
    async upsertNode (n) { nodes.set(n.node, structuredClone(n)) },
    listNodes: async () => [...nodes.values()].map((n) => structuredClone(n)),
    async insertEvents (evs) { for (const e of evs) events.push({ id: ++seq, ...e }) },
    listEvents: async (limit) => events.slice(-limit).reverse(),
    async insertSample (s) { samples.push(s) },
    listSamples: async (since) => samples.filter((s) => s.at >= since).sort((a, b) => a.at - b.at),
    async pruneSamples (before) {
      samples = samples.filter((s) => s.at >= before)
      appSamples = appSamples.filter((s) => s.at >= before)
    },
    async insertAppSamples (rows) { appSamples.push(...rows) },
    listAppSamples: async (since) => appSamples.filter((s) => s.at >= since).sort((a, b) => a.at - b.at),
    async close () {}
  }
}
