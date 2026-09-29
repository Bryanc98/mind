import { createApp } from '/vendor/vue/vue.esm-browser.prod.js'

const POLL_MS = 2000
const LABELS = { UP: 'Operativo', DEGRADED: 'Degradado', DOWN: 'Caído', UNKNOWN: 'Sin datos' }
const PLURAL = { UP: 'operativos', DEGRADED: 'degradados', DOWN: 'caídos', UNKNOWN: 'sin datos' }
const ORDER = { DOWN: 0, DEGRADED: 1, UNKNOWN: 2, UP: 3 }

createApp({
  data: () => ({ nodes: [], events: [], diagnoses: [], connected: true, updatedAt: null }),

  computed: {
    summary () {
      const counts = {}
      for (const n of this.nodes) counts[n.status] = (counts[n.status] ?? 0) + 1
      return Object.entries(counts)
        .sort(([a], [b]) => ORDER[a] - ORDER[b])
        .map(([status, count]) => ({ status, count }))
    },
    servicesFailing () {
      return this.nodes.reduce((acc, n) => acc + this.failing(n), 0)
    }
  },

  methods: {
    async refresh () {
      try {
        const [fleet, events, diagnoses] = await Promise.all([
          fetch('/api/v1/fleet').then(ok),
          fetch('/api/v1/events?limit=40').then(ok),
          fetch('/api/v1/diagnoses?limit=3').then(ok)
        ])
        this.diagnoses = diagnoses.diagnoses
        // Los nodos con problemas primero: es lo que hay que ver al abrir el panel.
        this.nodes = fleet.nodes.sort((a, b) =>
          ORDER[a.status] - ORDER[b.status] || this.failing(b) - this.failing(a) || a.node.localeCompare(b.node))
        this.events = events.events
        this.updatedAt = fleet.generatedAt
        this.connected = true
      } catch {
        this.connected = false
      }
    },
    label: (s) => LABELS[s] ?? s,
    providerLabel: (d) => `${d.provider === 'ollama' ? 'Ollama (local)' : d.provider === 'gemini' ? 'Gemini' : d.provider} · ${d.model}`,
    plural: (s, n) => (n === 1 ? (LABELS[s] ?? s) : (PLURAL[s] ?? s)).toLowerCase(),
    // Aplicaciones y contenedores con problemas: lo que el host no muestra.
    failing: (n) => [...n.apps, ...n.containers].filter((c) => c.status === 'DOWN' || c.status === 'DEGRADED').length,
    worst: (n) => ([...n.apps, ...n.containers].some((c) => c.status === 'DOWN') ? 'DOWN' : 'DEGRADED'),
    memLabel (c) {
      if (c.memPercent != null) return `mem ${c.memPercent.toFixed(0)}%`
      if (c.memBytes != null) return `${Math.round(c.memBytes / 1048576)} MB`
      return ''
    },
    latencyLine (history) {
      const pts = history.filter((h) => h.latencyMs != null)
      if (pts.length < 2) return ''
      const t0 = history[0].at
      const span = history[history.length - 1].at - t0 || 1
      const max = Math.max(...pts.map((h) => h.latencyMs), 100)
      return pts.map((h) => `${((h.at - t0) / span) * 200},${23 - (h.latencyMs / max) * 21}`).join(' ')
    },
    latencyFailures (history) {
      if (history.length < 2) return []
      const t0 = history[0].at
      const span = history[history.length - 1].at - t0 || 1
      return history.filter((h) => !h.ok).map((h) => ((h.at - t0) / span) * 198)
    },
    level: (pct) => (pct >= 85 ? 'hot' : pct >= 70 ? 'warm' : 'ok'),
    clock: (ms) => (ms ? new Date(ms).toLocaleTimeString('es-DO', { hour12: false }) : '—'),
    ago (sec) {
      if (sec < 60) return `${sec}s`
      if (sec < 3600) return `${Math.floor(sec / 60)} min`
      return `${Math.floor(sec / 3600)} h`
    },
    spark (history, key) {
      if (history.length < 2) return ''
      const t0 = history[0].at
      const span = history[history.length - 1].at - t0 || 1
      return history.map((h) => `${((h.at - t0) / span) * 200},${40 - (h[key] / 100) * 38 - 1}`).join(' ')
    }
  },

  mounted () {
    this.refresh()
    setInterval(() => this.refresh(), POLL_MS)
  }
}).mount('#app')

function ok (res) {
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}
