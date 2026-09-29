/**
 * Generador de trafico de la demostracion.
 *
 *   node trafico.js                           trafico de fondo hacia $TARGETS
 *   node trafico.js rafaga <url> <conc> <s>   <conc> peticiones concurrentes durante <s> segundos
 *   node trafico.js ritmo <url> <rps> <s>     <rps> peticiones por segundo durante <s> segundos
 */
const [mode, url, a, b] = process.argv.slice(2)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const hit = (u) => fetch(u, { signal: AbortSignal.timeout(10000) }).then((r) => r.body?.cancel(), () => {})

if (mode === 'rafaga') {
  const until = Date.now() + Number(b) * 1000
  const worker = async () => { while (Date.now() < until) await hit(url) }
  await Promise.all(Array.from({ length: Number(a) }, worker))
} else if (mode === 'ritmo') {
  const until = Date.now() + Number(b) * 1000
  while (Date.now() < until) {
    hit(url)
    await sleep(1000 / Number(a))
  }
} else {
  const targets = (process.env.TARGETS ?? '').split(',').filter(Boolean)
  for (;;) {
    await Promise.all(targets.map(hit))
    await sleep(600)
  }
}
