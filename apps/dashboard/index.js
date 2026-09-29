/**
 * Panel de la flota. Archivos estaticos que sirve el propio Hub: no hay
 * servidor aparte ni paso de compilacion.
 */
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'

const require = createRequire(import.meta.url)

export const publicDir = fileURLToPath(new URL('./public/', import.meta.url))
export const vueDir = dirname(require.resolve('vue/dist/vue.esm-browser.prod.js'))
