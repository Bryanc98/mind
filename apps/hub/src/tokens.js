/**
 * Tokens de agente.
 *
 * El Hub guarda solo el SHA-256 del token, nunca el token en claro: una copia
 * de la base de datos no permite hacerse pasar por ningun agente. Se usa
 * SHA-256 y no bcrypt/argon2 porque el token son 32 bytes aleatorios, no una
 * contrasena elegida por una persona: no hay diccionario que atacar, y un hash
 * lento solo anadiria latencia a cada reporte.
 */

import { createHash, randomBytes } from 'node:crypto'

export const generateToken = () => randomBytes(32).toString('base64url')

export const hashToken = (token) => createHash('sha256').update(token, 'utf8').digest('hex')
