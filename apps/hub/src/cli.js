#!/usr/bin/env node
/**
 * Administracion de agentes.
 *
 *   mind-hub agent add <nodo> [--token <token>]   emite un token (se muestra una sola vez)
 *   mind-hub agent revoke <nodo>                  revoca el token activo del nodo
 *   mind-hub agent list                           lista agentes y su estado
 *   mind-hub migrate                              aplica migraciones pendientes
 */
import process from 'node:process'
import { loadHubConfig } from './config.js'
import { openStore } from './store/index.js'
import { generateToken, hashToken } from './tokens.js'

const NODE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

const [cmd, sub, ...rest] = process.argv.slice(2)
const cfg = loadHubConfig(process.env)
const store = await openStore(cfg)

try {
  if (cmd === 'migrate') {
    process.stdout.write('migraciones al dia\n')
  } else if (cmd === 'agent' && sub === 'add') {
    const node = rest[0]
    if (!node || !NODE_NAME.test(node)) throw new Error('uso: agent add <nodo> [--token <token>]')
    const i = rest.indexOf('--token')
    const token = i >= 0 ? rest[i + 1] : generateToken()
    if (!token || token.length < 32) throw new Error('el token debe tener al menos 32 caracteres')
    await store.createAgent({ node, tokenHash: hashToken(token) })
    process.stderr.write(`agente registrado para ${node}. Guarda el token: no se puede volver a mostrar.\n`)
    process.stdout.write(token + '\n')
  } else if (cmd === 'agent' && sub === 'revoke') {
    const n = await store.revokeAgent(rest[0])
    process.stdout.write(n ? `token de ${rest[0]} revocado\n` : `no hay token activo para ${rest[0]}\n`)
    if (!n) process.exitCode = 1
  } else if (cmd === 'agent' && sub === 'list') {
    for (const a of await store.listAgents()) {
      process.stdout.write(`${a.node}\t${a.revokedAt ? 'revocado' : 'activo'}\t${new Date(a.createdAt).toISOString()}\n`)
    }
  } else {
    process.stderr.write('comandos: agent add|revoke|list, migrate\n')
    process.exitCode = 64
  }
} catch (err) {
  process.stderr.write(err.message + '\n')
  process.exitCode = 1
} finally {
  await store.close()
}
