/**
 * Aplicacion HTTP del Hub. Se construye sin escuchar en ningun puerto, de
 * modo que las pruebas la ejercitan con `inject` sin abrir sockets.
 */
import Fastify from 'fastify'
import rateLimit from '@fastify/rate-limit'
import fastifyStatic from '@fastify/static'
import { reportSchema, SUPPORTED_SCHEMA_VERSIONS } from '@mind/protocol'
import { publicDir, vueDir } from '@mind/dashboard'
import { hashToken } from './tokens.js'

/**
 * @param {{ service: ReturnType<import('./service.js').createHubService>,
 *   logLevel?: string, rateLimitPerMin?: number, logger?: boolean|object }} opts
 */
export async function buildApp ({ service, logLevel = 'info', rateLimitPerMin = 600, logger }) {
  const app = Fastify({
    // Mismo formato NDJSON que el agente: `ts` en ISO y el nivel como texto.
    logger: logger ?? {
      level: logLevel,
      base: { svc: 'hub' },
      timestamp: () => `,"ts":"${new Date().toISOString()}"`,
      formatters: { level: (label) => ({ level: label }) }
    },
    bodyLimit: 256 * 1024,
    // Los campos no declarados se descartan en lugar de rechazar el reporte:
    // un agente mas nuevo puede hablar con un Hub mas viejo (ADR 0007).
    ajv: { customOptions: { removeAdditional: true } },
    // El panel consulta cada 2 segundos: registrar cada peticion ahogaria lo
    // importante. Se registran solo las respuestas de error (hook abajo).
    disableRequestLogging: true
  })

  app.addHook('onResponse', async (req, reply) => {
    if (reply.statusCode >= 400) {
      req.log.warn({ method: req.method, url: req.url.split('?')[0], status: reply.statusCode, ip: req.ip }, 'peticion rechazada')
    }
  })

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-content-type-options', 'nosniff')
    reply.header('x-frame-options', 'DENY')
    reply.header('referrer-policy', 'no-referrer')
    // 'unsafe-eval' lo exige el compilador de plantillas de Vue en el
    // navegador. Desaparece cuando el panel tenga paso de compilacion y las
    // plantillas lleguen precompiladas.
    reply.header('content-security-policy',
      "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'")
  })

  await app.register(rateLimit, { global: false })

  // --- Ingesta -------------------------------------------------------------
  app.post('/api/v1/reports', {
    schema: { body: reportSchema },
    config: {
      // Limite por token, no por IP: varios agentes detras de un mismo NAT no
      // deben compartir cuota, y un agente defectuoso no debe agotar la de
      // los demas.
      rateLimit: {
        max: rateLimitPerMin,
        timeWindow: '1 minute',
        keyGenerator: (req) => {
          const token = bearer(req)
          return token ? `t:${hashToken(token).slice(0, 16)}` : `ip:${req.ip}`
        }
      }
    },
    // La autenticacion va antes de la validacion del cuerpo: una peticion sin
    // credencial no debe recibir detalles del esquema en la respuesta.
    onRequest: async (req, reply) => {
      const agent = await service.authenticate(bearer(req))
      if (!agent) return reply.code(401).send({ error: 'token invalido o revocado' })
      req.agent = agent
    }
  }, async (req, reply) => {
    const report = req.body
    if (!SUPPORTED_SCHEMA_VERSIONS.includes(report.schemaVersion)) {
      return reply.code(400).send({
        error: `schemaVersion ${report.schemaVersion} no soportada; se aceptan ${SUPPORTED_SCHEMA_VERSIONS.join(', ')}`
      })
    }
    // Cada token pertenece a un nodo. Un agente comprometido no puede
    // reportar en nombre de otro: la brecha queda contenida a su nodo.
    if (report.node !== req.agent.node) {
      req.log.warn({ tokenNode: req.agent.node, reportNode: report.node }, 'reporte a nombre de otro nodo')
      return reply.code(403).send({ error: 'el token no corresponde a este nodo' })
    }
    const r = await service.ingest(report)
    return reply.code(202).send({ accepted: true, stale: r.stale })
  })

  // --- Lectura para el panel ------------------------------------------------
  app.get('/api/v1/fleet', async () => ({ generatedAt: Date.now(), nodes: await service.fleet() }))

  app.get('/api/v1/events', {
    schema: { querystring: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 } } } }
  }, async (req) => ({ events: await service.events(Number(req.query.limit ?? 50)) }))

  app.get('/healthz', async () => ({ status: 'ok' }))

  // --- Panel ------------------------------------------------------------------
  await app.register(fastifyStatic, { root: publicDir, prefix: '/' })
  await app.register(fastifyStatic, { root: vueDir, prefix: '/vendor/vue/', decorateReply: false })

  return app
}

function bearer (req) {
  const h = req.headers.authorization
  if (typeof h !== 'string' || !h.startsWith('Bearer ')) return null
  return h.slice(7).trim() || null
}
