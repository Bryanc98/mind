/**
 * Enmascarado de datos sensibles en texto libre (lineas de log).
 *
 * Se aplica en el agente, antes de que cualquier linea salga del nodo, y otra
 * vez en el Hub antes de enviar contexto a un proveedor de IA: dos capas, por
 * si una version vieja del agente no enmascara algo que la nueva si.
 *
 * Es deliberadamente conservador: enmascarar de mas cuesta un diagnostico algo
 * menos preciso; enmascarar de menos publica una contrasena en un servicio
 * externo. Cada regla deja un marcador que dice QUE se oculto, porque para el
 * diagnostico importa saber que habia una cadena de conexion, aunque no su
 * contenido.
 */

const RULES = [
  // Credenciales en URLs: esquema://usuario:clave@host
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, '$1****@'],
  // Cadenas de conexion estilo .NET / ODBC: Password=...; Pwd=...
  [/\b(password|pwd)\s*=\s*[^;\s"']+/gi, '$1=****'],
  // Pares clave=valor o clave: valor con nombres sensibles.
  [/\b((?:api[_-]?key|apikey|secret|client[_-]?secret|token|access[_-]?token|refresh[_-]?token|passwd|contrase(?:n|ñ)a|clave)["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi, '$1****'],
  // Encabezados de autorizacion.
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, '$1 ****'],
  // JWT: tres segmentos base64url, el primero empieza con eyJ.
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, '[jwt]'],
  // Claves privadas en bloque PEM.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[clave privada]'],
  // Correos electronicos.
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[correo]'],
  // Cedula dominicana: 000-0000000-0 (con o sin guiones, 11 digitos).
  [/\b\d{3}-?\d{7}-?\d\b/g, '[cedula]'],
  // RNC: 9 digitos, con o sin guiones (0-00-00000-0).
  [/\b\d-?\d{2}-?\d{5}-?\d\b/g, '[rnc]'],
  // Tarjetas: 13 a 19 digitos en grupos.
  [/\b(?:\d[ -]?){13,19}\b/g, '[tarjeta]']
]

/**
 * @param {string} text
 * @returns {string}
 */
export function sanitize (text) {
  let out = String(text ?? '')
  for (const [re, replacement] of RULES) out = out.replace(re, replacement)
  return out
}

/**
 * Enmascara y acota un bloque de lineas de log: las ultimas `maxLines`, cada
 * una de hasta `maxLineLength` caracteres. El truncado va despues del
 * enmascarado para no cortar un secreto por la mitad y dejar la mitad visible.
 *
 * @param {string} text
 * @param {{ maxLines?: number, maxLineLength?: number }} [opts]
 */
export function sanitizeLog (text, { maxLines = 20, maxLineLength = 240 } = {}) {
  return String(text ?? '')
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.trim() !== '')
    .slice(-maxLines)
    .map((l) => {
      const s = sanitize(l)
      return s.length > maxLineLength ? s.slice(0, maxLineLength - 1) + '…' : s
    })
    .join('\n')
}
