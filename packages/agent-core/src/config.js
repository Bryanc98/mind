/**
 * Carga y validacion de la configuracion del agente desde variables de entorno.
 *
 * La configuracion se valida una sola vez al arrancar. Si algo esta mal, el
 * proceso termina de inmediato con codigo 78 (EX_CONFIG) y un mensaje que
 * enumera todos los problemas encontrados, no solo el primero: un operador
 * con tres variables mal debe verlas las tres en un arranque.
 *
 * Un agente de monitoreo mal configurado es peor que ninguno, porque reporta
 * salud sin haber medido nada. Por eso ningun valor critico tiene un default
 * implicito y ninguna variable invalida se ignora en silencio.
 */

export class ConfigError extends Error {
  /** @param {string[]} problems */
  constructor(problems) {
    super(`configuracion invalida:\n  - ${problems.join("\n  - ")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

const LOG_LEVELS = ["debug", "info", "warn", "error"];

/**
 * @param {Record<string, string|undefined>} env
 * @returns {Readonly<{
 *   nodeName: string, intervalMs: number, logLevel: string,
 *   cpuWarn: number, memWarn: number,
 *   failuresToDegrade: number, failuresToDown: number,
 *   hubUrl: string|null, serverToken: string|null, mode: 'standalone'|'hub',
 *   dockerHost: string|null, dockerLabel: string|null, bufferDir: string,
 *   bufferMax: number, httpTargets: {name: string, url: string}[],
 *   httpTimeoutMs: number, httpSlowMs: number
 * }>}
 */
export function loadConfig(env = process.env) {
  const problems = [];

  const raw = (key) => {
    const value = env[key];
    if (value === undefined || value === null) return undefined;
    const trimmed = String(value).trim();
    return trimmed === "" ? undefined : trimmed;
  };

  const readNumber = (key, fallback, { min, max, integer = false } = {}) => {
    const value = raw(key);
    if (value === undefined) return fallback;

    const n = Number(value);
    if (Number.isNaN(n)) {
      problems.push(`${key}="${value}" no es un numero`);
      return fallback;
    }
    if (integer && !Number.isInteger(n)) {
      problems.push(`${key}=${n} debe ser un entero`);
      return fallback;
    }
    if (min !== undefined && n < min) {
      problems.push(`${key}=${n} debe ser >= ${min}`);
      return fallback;
    }
    if (max !== undefined && n > max) {
      problems.push(`${key}=${n} debe ser <= ${max}`);
      return fallback;
    }
    return n;
  };

  const readEnum = (key, fallback, allowed) => {
    const value = raw(key);
    if (value === undefined) return fallback;
    if (!allowed.includes(value)) {
      problems.push(`${key}="${value}" debe ser uno de: ${allowed.join(", ")}`);
      return fallback;
    }
    return value;
  };

  const readUrl = (key) => {
    const value = raw(key);
    if (value === undefined) return null;

    let url;
    try {
      url = new URL(value);
    } catch {
      problems.push(`${key}="${value}" no es una URL valida`);
      return null;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      problems.push(`${key}="${value}" debe usar http o https`);
      return null;
    }
    return value;
  };

  // Mismo formato que DOCKER_HOST: unix:///ruta/al/socket o tcp://host:puerto.
  const readDockerHost = (key) => {
    const value = raw(key);
    if (value === undefined) return null;
    if (!/^unix:\/\/\/.+/.test(value) && !/^tcp:\/\/[^/]+:\d+\/?$/.test(value)) {
      problems.push(`${key}="${value}" debe tener la forma unix:///ruta o tcp://host:puerto`);
      return null;
    }
    return value;
  };

  // Aplicaciones a sondear: nombre=url,nombre=url. Cada una tiene su propia
  // maquina de estados, igual que un contenedor.
  const readHttpTargets = (key) => {
    const value = raw(key);
    if (value === undefined) return [];
    const targets = [];
    const seen = new Set();
    for (const part of value.split(",").map((s) => s.trim()).filter(Boolean)) {
      const i = part.indexOf("=");
      const name = i > 0 ? part.slice(0, i).trim() : "";
      const url = i > 0 ? part.slice(i + 1).trim() : "";
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
        problems.push(`${key}: "${part}" debe tener la forma nombre=url`);
        continue;
      }
      let parsed;
      try { parsed = new URL(url); } catch {}
      if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
        problems.push(`${key}: ${name}="${url}" no es una URL http/https`);
        continue;
      }
      if (parsed.username || parsed.password) {
        // Una credencial en la URL terminaria en los logs y en el Hub.
        problems.push(`${key}: ${name} no puede llevar usuario ni contrasena en la URL`);
        continue;
      }
      if (seen.has(name)) {
        problems.push(`${key}: el nombre ${name} esta repetido`);
        continue;
      }
      seen.add(name);
      targets.push(Object.freeze({ name, url }));
    }
    return targets;
  };

  const nodeName = raw("MIND_NODE_NAME");
  if (!nodeName) problems.push("MIND_NODE_NAME es obligatorio");

  const intervalMs = readNumber("MIND_INTERVAL_MS", 15000, {
    min: 1000,
    integer: true,
  });
  const cpuWarn = readNumber("MIND_CPU_WARN", 85, { min: 0, max: 100 });
  const memWarn = readNumber("MIND_MEM_WARN", 90, { min: 0, max: 100 });
  const failuresToDegrade = readNumber("MIND_FAILURES_TO_DEGRADE", 2, {
    min: 1,
    integer: true,
  });
  const failuresToDown = readNumber("MIND_FAILURES_TO_DOWN", 4, {
    min: 1,
    integer: true,
  });
  const logLevel = readEnum("MIND_LOG_LEVEL", "info", LOG_LEVELS);
  const hubUrl = readUrl("MIND_HUB_URL");
  const serverToken = raw("MIND_SERVER_TOKEN") ?? null;
  const dockerHost = readDockerHost("MIND_DOCKER_HOST");
  const dockerLabel = raw("MIND_DOCKER_LABEL") ?? null;
  const bufferDir = raw("MIND_BUFFER_DIR") ?? "./data";
  const bufferMax = readNumber("MIND_BUFFER_MAX", 5000, { min: 1, integer: true });
  const httpTargets = readHttpTargets("MIND_HTTP_TARGETS");
  const httpTimeoutMs = readNumber("MIND_HTTP_TIMEOUT_MS", 5000, { min: 100, integer: true });
  const httpSlowMs = readNumber("MIND_HTTP_SLOW_MS", 2000, { min: 1, integer: true });
  if (httpSlowMs >= httpTimeoutMs) {
    problems.push(
      `MIND_HTTP_SLOW_MS (${httpSlowMs}) debe ser menor que MIND_HTTP_TIMEOUT_MS (${httpTimeoutMs}), ` +
      `o una respuesta lenta se reportaria como timeout`
    );
  }

  // Un agente en modo hub sin credencial fallaria en cada envio con 401 y
  // llenaria el buffer sin que nadie lo note. Se detecta al arrancar.
  if (hubUrl && !serverToken) {
    problems.push("MIND_SERVER_TOKEN es obligatorio cuando MIND_HUB_URL esta definida");
  }
  if (serverToken && serverToken.length < 32) {
    problems.push("MIND_SERVER_TOKEN es demasiado corto (minimo 32 caracteres)");
  }

  if (failuresToDown <= failuresToDegrade) {
    problems.push(
      `MIND_FAILURES_TO_DOWN (${failuresToDown}) debe ser mayor que ` +
      `MIND_FAILURES_TO_DEGRADE (${failuresToDegrade}), o DEGRADED seria inalcanzable`
    )
  }
  
  if (problems.length > 0) throw new ConfigError(problems);

  return Object.freeze({
    nodeName,
    intervalMs,
    logLevel,
    cpuWarn,
    memWarn,
    failuresToDegrade,
    failuresToDown,
    hubUrl,
    serverToken,
    dockerHost,
    dockerLabel,
    bufferDir,
    bufferMax,
    httpTargets: Object.freeze(httpTargets),
    httpTimeoutMs,
    httpSlowMs,
    mode: hubUrl ? "hub" : "standalone",
  });
}
