/**
 * Pruebas de referencia del diagnostico por IA, contra un modelo real.
 *
 * Cada archivo de test/incidentes/ es el contexto que el Hub envio al
 * proveedor en un incidente real del entorno de demostracion, con su causa
 * conocida. Un cambio de prompt o de modelo se valida aqui antes de adoptarlo:
 * lo que se mide es si el diagnostico apunta a la causa correcta, no si el
 * texto coincide.
 *
 * No corre por defecto: llama a un modelo, tarda y puede costar.
 *   MIND_TEST_AI_PROVIDER=ollama [MIND_TEST_AI_MODEL=qwen2.5:7b] pnpm test:ia
 *   MIND_TEST_AI_PROVIDER=gemini MIND_AI_GEMINI_API_KEY=... pnpm test:ia
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createProvider } from '@mind/ai-provider'
import { SYSTEM_PROMPT, DIAGNOSIS_SCHEMA, validateDiagnosis, userPrompt } from '../src/prompt.js'

const PROVIDER = process.env.MIND_TEST_AI_PROVIDER

const load = (name) => JSON.parse(readFileSync(new URL(`./incidentes/${name}.json`, import.meta.url), 'utf8'))

const CASES = [
  {
    name: 'cascada-db',
    what: 'db-01 se apaga; tramites en web-01 responde 503 por perder su base de datos',
    check (d) {
      assert.equal(d.servidores_afectados[0], 'db-01', 'la causa esta en db-01, el primero de la lista')
      assert.match(d.causa_probable, /db-01|base de datos|db-tramites/i)
      assert.doesNotMatch(d.causa_probable, /memoria|OOM|CPU/i, 'no mezcla otros incidentes')
    }
  },
  {
    name: 'fuga-memoria',
    what: 'reportes agota su memoria, muere por OOM y entra en bucle de reinicios',
    check (d) {
      assert.equal(d.servidores_afectados[0], 'web-01')
      assert.match(d.causa_probable, /memoria|OOM/i)
      assert.match(`${d.resumen} ${d.causa_probable}`, /reportes/i)
      assert.doesNotMatch(d.causa_probable, /db-01|base de datos|agente/i)
    }
  },
  {
    name: 'carga-cpu',
    what: 'trafico concurrente satura la CPU de app-01 y consultas se vuelve lenta',
    check (d) {
      assert.equal(d.servidores_afectados[0], 'app-01')
      assert.match(d.causa_probable, /CPU|carga|concurren|tr[aá]fico|peticiones|solicitudes|demanda/i)
      assert.doesNotMatch(d.causa_probable, /reportes|OOM|db-01/i, 'no mezcla otros incidentes')
      // Sin tasa de peticiones, carga y proceso defectuoso son indistinguibles:
      // afirmarlo con confianza alta seria inventar.
      assert.notEqual(d.confianza, 'alta', 'la evidencia no distingue entre causas posibles')
    }
  }
]

describe(`diagnostico de referencia (${PROVIDER ?? 'omitido: defina MIND_TEST_AI_PROVIDER'})`, { skip: !PROVIDER }, () => {
  const provider = PROVIDER && createProvider({
    provider: PROVIDER,
    model: process.env.MIND_TEST_AI_MODEL,
    ollamaUrl: process.env.MIND_AI_OLLAMA_URL,
    geminiApiKey: process.env.MIND_AI_GEMINI_API_KEY,
    timeoutMs: 180_000
  })

  for (const c of CASES) {
    test(`${c.name}: ${c.what}`, { timeout: 400_000 }, async (t) => {
      const { context } = load(c.name)
      const { data, latencyMs } = await provider.generate({ system: SYSTEM_PROMPT, user: userPrompt(context), schema: DIAGNOSIS_SCHEMA })
      const d = validateDiagnosis(data)
      t.diagnostic(`${provider.model} · ${latencyMs} ms · confianza ${d.confianza}`)
      t.diagnostic(`causa: ${d.causa_probable}`)
      t.diagnostic(`servidores: ${d.servidores_afectados.join(', ')}`)
      c.check(d)
    })
  }
})
