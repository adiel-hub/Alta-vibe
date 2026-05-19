/** Cap a string so logs stay scannable. Set LOG_AGENT_FULL=1 to disable. */
const FULL_LOG_DUMP = process.env.LOG_AGENT_FULL === "1";
export function truncate(s: string, max = 400): string {
  if (FULL_LOG_DUMP) return s;
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…[+${s.length - max} chars]`;
}
export function summariseInput(input: unknown): string {
  if (input === undefined || input === null) return "";
  try {
    return truncate(JSON.stringify(input));
  } catch {
    return "[unserialisable input]";
  }
}
