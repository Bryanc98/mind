/**
 * Proveedor de IA intercambiable para el diagnostico de causa raiz.
 *
 * Dos implementaciones detras de la misma interfaz:
 *   - ollama: modelo local. Ningun dato sale de la red de la organizacion; es
 *     la opcion para entornos cuya politica de datos no permite enviar logs a
 *     un servicio externo.
 *   - gemini: servicio de Google, mejor calidad, requiere salida a internet.
 *
 * Cambiar de proveedor es cambiar una variable de entorno. La respuesta del
 * modelo nunca se usa sin validarla: un modelo puede devolver JSON invalido o
 * campos inventados, y eso debe terminar como error visible, no en el panel.
 */

export const DEFAULT_MODELS = Object.freeze({
  ollama: 'qwen2.5:7b',
  gemini: 'gemini-3.8-flash'
})

/**
 * @param {{
 *   provider: 'ollama'|'gemini', model?: string, ollamaUrl?: string,
 *   geminiApiKey?: string, timeoutMs?: number, fetch?: typeof fetch
 * }} opts
 * @returns {{ name: string, model: string,
 *   generate: (req: { system: string, user: string, schema: object }) => Promise<{ data: object, latencyMs: number }> }}
 */
export function createProvider ({
  provider, model, ollamaUrl = 'http://127.0.0.1:11434', geminiApiKey, timeoutMs = 60000,
  fetch = globalThis.fetch, numCtx = 8192, retries = 2, retryDelayMs = 1500, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
}) {
  const m = model ?? DEFAULT_MODELS[provider]

  // Los servicios de IA devuelven 503 o 429 cuando hay alta demanda, con
  // frecuencia y por segundos. Se reintenta con espera creciente; cualquier
  // otro error (clave invalida, modelo inexistente) falla de inmediato.
  const TRANSIENT = new Set([429, 500, 502, 503, 504])

  async function call (url, init) {
    const t0 = performance.now()
    for (let attempt = 0; ; attempt++) {
      let res
      try {
        res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
      } catch (err) {
        const why = err.name === 'TimeoutError' ? `sin respuesta en ${timeoutMs} ms` : (err.cause?.code ?? err.message)
        throw new Error(`${provider}: ${why}`)
      }
      const body = await res.text()
      if (res.ok) return { json: JSON.parse(body), latencyMs: Math.round(performance.now() - t0) }
      if (!TRANSIENT.has(res.status) || attempt >= retries) {
        throw new Error(`${provider}: HTTP ${res.status}: ${body.slice(0, 300)}`)
      }
      await sleep(retryDelayMs * 2 ** attempt)
    }
  }

  if (provider === 'ollama') {
    return {
      name: 'ollama',
      model: m,
      async generate ({ system, user, schema }) {
        const { json, latencyMs } = await call(new URL('/api/chat', ollamaUrl), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: m,
            stream: false,
            // Ollama restringe la salida al esquema JSON durante la generacion.
            format: schema,
            // La ventana por defecto de Ollama es corta y trunca en silencio
            // el inicio del prompt: el modelo perderia las reglas y parte de
            // los datos, y responderia con seguridad sobre lo que le quedo.
            options: { temperature: 0.2, num_ctx: numCtx },
            messages: [{ role: 'system', content: system }, { role: 'user', content: user }]
          })
        })
        return { data: parseJson(json.message?.content), latencyMs }
      }
    }
  }

  if (provider === 'gemini') {
    if (!geminiApiKey) throw new Error('gemini: falta la clave de API')
    return {
      name: 'gemini',
      model: m,
      async generate ({ system, user, schema }) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent`
        const { json, latencyMs } = await call(url, {
          method: 'POST',
          // La clave va en un encabezado, no en la URL: las URLs terminan en logs.
          headers: { 'content-type': 'application/json', 'x-goog-api-key': geminiApiKey },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: 'user', parts: [{ text: user }] }],
            generationConfig: { temperature: 0.2, responseMimeType: 'application/json', responseJsonSchema: schema }
          })
        })
        const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('')
        return { data: parseJson(text), latencyMs }
      }
    }
  }

  throw new Error(`proveedor de IA desconocido: ${provider}`)
}

function parseJson (text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('el modelo devolvio una respuesta vacia')
  // Algunos modelos envuelven el JSON en un bloque de codigo aunque se les pida
  // JSON puro.
  const clean = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  try {
    return JSON.parse(clean)
  } catch {
    throw new Error(`el modelo no devolvio JSON valido: ${clean.slice(0, 200)}`)
  }
}

/**
 * Cadena de proveedores: si uno falla despues de sus reintentos, prueba el
 * siguiente. Un servicio de IA saturado es frecuente y dura minutos; con un
 * respaldo (otro modelo del mismo servicio, o un modelo local) el diagnostico
 * sigue llegando. El resultado dice que proveedor respondio de verdad.
 *
 * @param {ReturnType<typeof createProvider>[]} providers en orden de preferencia
 */
export function createChain (providers) {
  if (!providers.length) throw new Error('la cadena de proveedores esta vacia')
  return {
    name: providers[0].name,
    model: providers[0].model,
    chain: providers.map((p) => `${p.name}:${p.model}`),
    async generate (req) {
      const failures = []
      for (const p of providers) {
        try {
          const r = await p.generate(req)
          return { ...r, provider: p.name, model: p.model, failures }
        } catch (err) {
          failures.push(`${p.name}:${p.model}: ${err.message.slice(0, 160)}`)
        }
      }
      throw new Error(`todos los proveedores fallaron: ${failures.join(' | ')}`)
    }
  }
}

/**
 * Lee una lista "proveedor[:modelo],proveedor[:modelo]".
 * El modelo puede contener ':' (qwen2.5:7b): solo el primero separa.
 */
export function parseProviderList (spec) {
  return String(spec ?? '').split(',').map((s) => s.trim()).filter(Boolean).map((item) => {
    const i = item.indexOf(':')
    return i < 0 ? { provider: item, model: undefined } : { provider: item.slice(0, i), model: item.slice(i + 1) || undefined }
  })
}
