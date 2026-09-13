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
 *   hubUrl: string|null, mode: 'standalone'|'hub'
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
    mode: hubUrl ? "hub" : "standalone",
  });
}
