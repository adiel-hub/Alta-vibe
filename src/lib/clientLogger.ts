/**
 * Browser-side logger. Mirrors lib/logger.ts but reads NEXT_PUBLIC_LOG_*
 * env vars at build time. Outputs to console.log with CSS styling.
 *
 *   NEXT_PUBLIC_LOG_LEVEL          trace|debug|info|warn|error|off  (default: info)
 *   NEXT_PUBLIC_LOG_CATEGORIES     comma list, "*", "!cat" exclusions (default: *)
 *
 * Categories used: sse-client, store, chat, widget, workflow, test-call, ui.
 */
"use client";

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "off";

const LEVEL_RANK: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  off: 99,
};

const LEVEL = (() => {
  const raw = (process.env.NEXT_PUBLIC_LOG_LEVEL ?? "info").toLowerCase();
  return (raw in LEVEL_RANK ? raw : "info") as LogLevel;
})();

const ALLOW: Set<string> | "*" = (() => {
  const raw = (process.env.NEXT_PUBLIC_LOG_CATEGORIES ?? "*").trim();
  if (raw === "*" || raw === "") return "*";
  const allow = new Set<string>();
  let hasStar = false;
  for (const tok of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (tok === "*") hasStar = true;
    else if (!tok.startsWith("!")) allow.add(tok);
  }
  return hasStar ? "*" : allow;
})();
const DENY: Set<string> = (() => {
  const raw = (process.env.NEXT_PUBLIC_LOG_CATEGORIES ?? "*").trim();
  const deny = new Set<string>();
  for (const tok of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (tok.startsWith("!")) deny.add(tok.slice(1));
  }
  return deny;
})();

function allowed(category: string, level: LogLevel): boolean {
  if (LEVEL_RANK[LEVEL] === LEVEL_RANK.off) return false;
  if (LEVEL_RANK[level] < LEVEL_RANK[LEVEL]) return false;
  const root = category.split(":")[0];
  if (DENY.has(category) || DENY.has(root)) return false;
  if (ALLOW === "*") return true;
  return ALLOW.has(category) || ALLOW.has(root);
}

const STYLE: Record<LogLevel, string> = {
  trace: "color: #888",
  debug: "color: #4ec9b0",
  info: "color: #6abf69",
  warn: "color: #d7ba7d",
  error: "color: #f48771",
  off: "",
};

function emit(
  category: string,
  level: LogLevel,
  msg: string,
  ctx?: Record<string, unknown>,
): void {
  if (!allowed(category, level)) return;
  const ts = new Date().toISOString().slice(11, 23);
  const prefix = `%c${ts} ${level.toUpperCase().padEnd(5)} [${category}]`;
  const args: unknown[] = [prefix, STYLE[level], msg];
  if (ctx && Object.keys(ctx).length > 0) args.push(ctx);
  if (level === "error") console.error(...args);
  else if (level === "warn") console.warn(...args);
  else console.log(...args);
}

export type Logger = {
  trace: (msg: string, ctx?: Record<string, unknown>) => void;
  debug: (msg: string, ctx?: Record<string, unknown>) => void;
  info: (msg: string, ctx?: Record<string, unknown>) => void;
  warn: (msg: string, ctx?: Record<string, unknown>) => void;
  error: (msg: string, ctx?: Record<string, unknown>) => void;
  child: (extra: Record<string, unknown>) => Logger;
};

export function createClientLogger(
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
    child: (extra) => createClientLogger(category, { ...(base ?? {}), ...extra }),
  };
}
