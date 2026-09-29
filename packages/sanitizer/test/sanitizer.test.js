import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { sanitize, sanitizeLog } from '../src/index.js'

describe('sanitize - credenciales', () => {
  test('clave en una URL de conexion', () => {
    assert.equal(
      sanitize('ERROR no se pudo conectar a postgres://tramites:S3cr3t!@db-01:5432/tramites'),
      'ERROR no se pudo conectar a postgres://tramites:****@db-01:5432/tramites'
    )
  })

  test('cadena de conexion estilo .NET', () => {
    const s = sanitize('Server=sql01;Database=app;User Id=sa;Password=P@ssw0rd;Encrypt=true')
    assert.ok(!s.includes('P@ssw0rd'), s)
    assert.match(s, /Password=\*\*\*\*/)
    assert.match(s, /Server=sql01/, 'lo que no es secreto se conserva: sirve para el diagnostico')
  })

  test('pares clave=valor sensibles', () => {
    const s = sanitize('api_key=abc123xyz token: "t0k3n" secret=shh contraseña=hola')
    for (const secret of ['abc123xyz', 't0k3n', 'shh', 'hola']) assert.ok(!s.includes(secret), s)
  })

  test('encabezado Authorization y JWT', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJhLWZhbHNh'
    const s = sanitize(`Authorization: Bearer ${jwt}`)
    assert.ok(!s.includes('eyJzdWIi'), s)
    assert.equal(sanitize(`token suelto ${jwt} en el log`), 'token suelto [jwt] en el log')
  })

  test('clave privada PEM', () => {
    const s = sanitize('-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----')
    assert.equal(s, '[clave privada]')
  })
})

describe('sanitize - datos personales', () => {
  test('correo, cedula y RNC', () => {
    assert.equal(
      sanitize('usuario ana.perez@example.com cedula 001-1234567-8 empresa RNC 1-01-12345-6'),
      'usuario [correo] cedula [cedula] empresa RNC [rnc]'
    )
    assert.equal(sanitize('cedula sin guiones 00112345678'), 'cedula sin guiones [cedula]')
  })

  test('no toca lo que el diagnostico necesita', () => {
    const line = 'GET /api/tramites 503 12ms db-tramites:5432 ECONNREFUSED pid=42 heap=45MB'
    assert.equal(sanitize(line), line)
  })
})

describe('sanitizeLog', () => {
  test('ultimas N lineas, sin vacias, enmascaradas y acotadas', () => {
    const log = ['uno', '', 'dos password=x', 'tres', 'x'.repeat(500)].join('\n')
    const out = sanitizeLog(log, { maxLines: 3, maxLineLength: 50 }).split('\n')
    assert.equal(out.length, 3)
    assert.equal(out[0], 'dos password=****')
    assert.equal(out[2].length, 50)
  })

  test('el truncado no deja medio secreto a la vista', () => {
    const out = sanitizeLog('conectando postgres://u:SuperSecreta@db/x', { maxLineLength: 30 })
    assert.ok(!out.includes('Super'), out)
  })
})
