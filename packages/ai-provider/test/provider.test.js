import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createProvider, createChain, parseProviderList, DEFAULT_MODELS } from '../src/index.js'

const schema = { type: 'object', properties: { ok: { type: 'boolean' } } }

function fakeFetch (respond) {
  const calls = []
  const fn = async (url, init) => {
    calls.push({ url: String(url), init, body: JSON.parse(init.body) })
    const { status = 200, body } = respond(calls.length)
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
  }
  fn.calls = calls
  return fn
}

describe('ollama', () => {
  test('envia system, user y el esquema como formato; parsea la respuesta', async () => {
    const fetch = fakeFetch(() => ({ body: { message: { content: '{"ok":true}' } } }))
    const p = createProvider({ provider: 'ollama', ollamaUrl: 'http://ia.example.com:11434', fetch })
    const r = await p.generate({ system: 'S', user: 'U', schema })
    assert.deepEqual(r.data, { ok: true })
    assert.equal(p.model, DEFAULT_MODELS.ollama)
    const c = fetch.calls[0]
    assert.equal(c.url, 'http://ia.example.com:11434/api/chat')
    assert.deepEqual(c.body.format, schema)
    assert.equal(c.body.stream, false)
    assert.equal(c.body.options.num_ctx, 8192, 'ventana explicita: la de defecto trunca el prompt')
    assert.deepEqual(c.body.messages.map((x) => x.role), ['system', 'user'])
  })

  test('JSON envuelto en un bloque de codigo tambien se acepta', async () => {
    const fetch = fakeFetch(() => ({ body: { message: { content: '```json\n{"ok":false}\n```' } } }))
    const r = await createProvider({ provider: 'ollama', fetch }).generate({ system: '', user: '', schema })
    assert.deepEqual(r.data, { ok: false })
  })

  test('texto que no es JSON -> error explicito', async () => {
    const fetch = fakeFetch(() => ({ body: { message: { content: 'Creo que el servidor...' } } }))
    await assert.rejects(createProvider({ provider: 'ollama', fetch }).generate({ system: '', user: '', schema }), /no devolvio JSON valido/)
  })
})

describe('gemini', () => {
  test('la clave va en un encabezado, nunca en la URL', async () => {
    const fetch = fakeFetch(() => ({ body: { candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] } }))
    const p = createProvider({ provider: 'gemini', geminiApiKey: 'clave-de-prueba', fetch })
    const r = await p.generate({ system: 'S', user: 'U', schema })
    assert.deepEqual(r.data, { ok: true })
    const c = fetch.calls[0]
    assert.ok(!c.url.includes('clave-de-prueba'))
    assert.equal(c.init.headers['x-goog-api-key'], 'clave-de-prueba')
    assert.equal(c.body.generationConfig.responseMimeType, 'application/json')
    assert.equal(c.body.systemInstruction.parts[0].text, 'S')
  })

  test('sin clave no arranca', () => {
    assert.throws(() => createProvider({ provider: 'gemini' }), /falta la clave/)
  })

  test('error transitorio persistente -> reintenta y luego falla con el codigo', async () => {
    const fetch = fakeFetch(() => ({ status: 429, body: 'quota exceeded' }))
    await assert.rejects(
      createProvider({ provider: 'gemini', geminiApiKey: 'k', fetch, sleep: async () => {} }).generate({ system: '', user: '', schema }),
      /gemini: HTTP 429: quota exceeded/
    )
    assert.equal(fetch.calls.length, 3, 'un intento y dos reintentos')
  })

  test('503 por alta demanda y luego exito -> responde', async () => {
    const ok = { candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] }
    const fetch = fakeFetch((n) => (n === 1 ? { status: 503, body: 'high demand' } : { body: ok }))
    const r = await createProvider({ provider: 'gemini', geminiApiKey: 'k', fetch, sleep: async () => {} })
      .generate({ system: '', user: '', schema })
    assert.deepEqual(r.data, { ok: true })
  })

  test('error no transitorio (404) -> falla sin reintentar', async () => {
    const fetch = fakeFetch(() => ({ status: 404, body: 'model not found' }))
    await assert.rejects(createProvider({ provider: 'gemini', geminiApiKey: 'k', fetch, sleep: async () => {} })
      .generate({ system: '', user: '', schema }), /HTTP 404/)
    assert.equal(fetch.calls.length, 1)
  })
})

test('proveedor desconocido', () => {
  assert.throws(() => createProvider({ provider: 'otro' }), /desconocido/)
})

describe('cadena de respaldo', () => {
  const ok = (name, model) => ({ name, model, generate: async () => ({ data: { ok: name }, latencyMs: 5 }) })
  const bad = (name, model) => ({ name, model, generate: async () => { throw new Error('HTTP 503 saturado') } })

  test('si el principal falla, responde el siguiente y lo dice', async () => {
    const chain = createChain([bad('gemini', 'g-pro'), ok('ollama', 'q')])
    const r = await chain.generate({})
    assert.equal(r.provider, 'ollama')
    assert.equal(r.model, 'q')
    assert.equal(r.failures.length, 1)
    assert.match(r.failures[0], /gemini:g-pro: HTTP 503/)
  })

  test('si todos fallan, un solo error con cada motivo', async () => {
    await assert.rejects(createChain([bad('a', '1'), bad('b', '2')]).generate({}), /todos los proveedores fallaron: a:1: .* \| b:2: /)
  })

  test('parseProviderList respeta los dos puntos del modelo', () => {
    assert.deepEqual(parseProviderList('gemini:gemini-3.1-flash-lite, ollama:qwen2.5:7b ,ollama'), [
      { provider: 'gemini', model: 'gemini-3.1-flash-lite' },
      { provider: 'ollama', model: 'qwen2.5:7b' },
      { provider: 'ollama', model: undefined }
    ])
  })
})
