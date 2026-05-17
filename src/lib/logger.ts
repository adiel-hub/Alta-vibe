/**
 * Server-side structured logger. No deps; reads env at first use.
 *
 *   LOG_LEVEL          trace | debug | info | warn | error | off  (default: info)
 *   LOG_CATEGORIES     comma-separated allowlist, or "*" (default: *)
 *                      negative entries with "!" exclude:  "*,!sse"
 *   LOG_FORMAT         pretty | json   (default: pretty in dev, json in prod)
 *
 *   LOG_INCLUDE_TIMESTAMPS  true|false  (default: true)
 *   LOG_INCLUDE_LEVEL       true|false  (default: true)
 *   LOG_INCLUDE_CATEGORY    true|false  (default: true)
 *
 * Usage:
 *
 *   const log = createLogger("turn-job");
 *   log.info("enqueued", { jobId, agent_id });
 *   const t = log.child({ jobId });
 *   t.debug("claimed");
 *
 * `time(log, "op", fn)` wraps a promise and logs duration on resolve/reject.
 */
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "off";

const LEVEL_RANK: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  off: 99,
};

type Config = {
  level: LogLevel;
  allow: Set<string> | "*";
  deny: Set<string>;
  format: "pretty" | "json";
  includeTs: boolean;
  includeLevel: boolean;
  includeCategory: boolean;
};

let cachedConfig: Config | null = null;

function parseLevel(s: string | undefined): LogLevel {
  const v = (s ?? "info").toLowerCase();
  return (v in LEVEL_RANK ? v : "info") as LogLevel;
}

function getConfig(): Config {
  if (cachedConfig) return cachedConfig;
  const catsRaw = (process.env.LOG_CATEGORIES ?? "*").trim();
  let allow: Set<string> | "*" = "*";
  const deny = new Set<string>();
  if (catsRaw !== "*" && catsRaw.length > 0) {
    const allowList = new Set<string>();
    let hasStar = false;
    for (const token of catsRaw.split(",").map((s) => s.trim()).filter(Boolean)) {
      if (token === "*") {
        hasStar = true;
      } else if (token.startsWith("!")) {
        deny.add(token.slice(1));
      } else {
        allowList.add(token);
      }
    }
    allow = hasStar ? "*" : allowList;
  }
  const isProd = process.env.NODE_ENV === "production";
  const format =
    (process.env.LOG_FORMAT?.toLowerCase() === "json"
      ? "json"
      : process.env.LOG_FORMAT?.toLowerCase() === "pretty"
        ? "pretty"
        : isProd
          ? "json"
          : "pretty") as "json" | "pretty";

  cachedConfig = {
    level: parseLevel(process.env.LOG_LEVEL),
    allow,
    deny,
    format,
    includeTs: process.env.LOG_INCLUDE_TIMESTAMPS !== "false",
    includeLevel: process.env.LOG_INCLUDE_LEVEL !== "false",
    includeCategory: process.env.LOG_INCLUDE_CATEGORY !== "false",
  };
  return cachedConfig;
}

/** Re-read env. Useful in tests; in prod the config is read once and cached. */
export function resetLoggerConfig(): void {
  cachedConfig = null;
}

function categoryAllowed(category: string, cfg: Config): boolean {
  // `capability:voice` matches `capability` allow/deny too.
  const root = category.split(":")[0];
  if (cfg.deny.has(category) || cfg.deny.has(root)) return false;
  if (cfg.allow === "*") return true;
  return cfg.allow.has(category) || cfg.allow.has(root);
}

function shouldLog(category: string, level: LogLevel): boolean {
  const cfg = getConfig();
  if (LEVEL_RANK[cfg.level] === LEVEL_RANK.off) return false;
  if (LEVEL_RANK[level] < LEVEL_RANK[cfg.level]) return false;
  return categoryAllowed(category, cfg);
}

const COLORS: Record<LogLevel, string> = {
  trace: "\x1b[90m", // gray
  debug: "\x1b[36m", // cyan
  info: "\x1b[32m", // green
  warn: "\x1b[33m", // yellow
  error: "\x1b[31m", // red
  off: "",
};
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

function emit(
  category: string,
  level: LogLevel,
  msg: string,
  ctx?: Record<string, unknown>,
): void {
  if (!shouldLog(category, level)) return;
  const cfg = getConfig();
  const ts = new Date().toISOString();

  if (cfg.format === "json") {
    const payload: Record<string, unknown> = { msg };
    if (cfg.includeTs) payload.ts = ts;
    if (cfg.includeLevel) payload.level = level;
    if (cfg.includeCategory) payload.category = category;
    if (ctx) Object.assign(payload, ctx);
    process.stdout.write(JSON.stringify(payload) + "\n");
    return;
  }

  const parts: string[] = [];
  if (cfg.includeTs) parts.push(`${DIM}${ts}${RESET}`);
  if (cfg.includeLevel) parts.push(`${COLORS[level]}${level.toUpperCase().padEnd(5)}${RESET}`);
  if (cfg.includeCategory) parts.push(`${DIM}[${category}]${RESET}`);
  parts.push(msg);
  if (ctx && Object.keys(ctx).length > 0) {
    parts.push(`${DIM}${stringify(ctx)}${RESET}`);
  }
  process.stdout.write(parts.join(" ") + "\n");
}

function stringify(ctx: Record<string, unknown>): string {
  try {
    return JSON.stringify(ctx);
  } catch {
    return "[unserialisable]";
  }
}

export type Logger = {
  trace: (msg: string, ctx?: Record<string, unknown>) => void;
  debug: (msg: string, ctx?: Record<string, unknown>) => void;
  info: (msg: string, ctx?: Record<string, unknown>) => void;
  warn: (msg: string, ctx?: Record<string, unknown>) => void;
  error: (msg: string, ctx?: Record<string, unknown>) => void;
  child: (extra: Record<string, unknown>) => Logger;
};

export function createLogger(
  category: string,
  base?: Record<string, unknown>,
): Logger {
  const wrap = (level: LogLevel) => (msg: string, ctx?: Record<string, unknown>) =>
    emit(category, level, msg, { ...(base ?? {}), ...(ctx ?? {}) });
  return {
    trace: wrap("trace"),
    debug: wrap("debug"),
    info: wrap("info"),
    warn: wrap("warn"),
    error: wrap("error"),
    child: (extra) => createLogger(category, { ...(base ?? {}), ...extra }),
  };
}

/** Wrap a promise, log start + duration on resolve / error on reject. */
export async function time<T>(
  log: Logger,
  op: string,
  fn: () => Promise<T>,
  extra?: Record<string, unknown>,
): Promise<T> {
  const t0 = Date.now();
  log.debug(`${op}…`, extra);
  try {
    const result = await fn();
    log.info(`${op} ok`, { ...extra, ms: Date.now() - t0 });
    return result;
  } catch (err) {
    log.error(`${op} failed`, {
      ...extra,
      ms: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/** Generate a short request id for log correlation. */
export function newRequestId(): string {
  return Math.random().toString(36).slice(2, 10);
}
