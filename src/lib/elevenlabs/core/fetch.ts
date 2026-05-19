import { BASE_URL } from "./constants";
import { apiKey } from "./apiKey";
import { log, logTrunc } from "./logger";
import { ElevenLabsError, extractErrorMessage } from "./errors";

export async function elFetch(
  path: string,
  init: RequestInit & { section: string },
): Promise<Response> {
  const { section, ...rest } = init;
  const headers = new Headers(rest.headers);
  headers.set("xi-api-key", apiKey());
  if (!headers.has("accept")) headers.set("accept", "application/json");

  const method = rest.method ?? "GET";
  // Snapshot the outgoing body so we can attach it to error logs. We always
  // log a truncated copy on non-2xx so the engineer can immediately see
  // exactly what shape we sent that the provider rejected — the #1 cause
  // of 422 debug-time loss.
  const reqBodyRaw = typeof rest.body === "string" ? rest.body : null;
  let reqBodyParsed: unknown = null;
  if (reqBodyRaw) {
    try {
      reqBodyParsed = JSON.parse(reqBodyRaw);
    } catch {
      reqBodyParsed = reqBodyRaw;
    }
  }

  let attempt = 0;
  const t0 = Date.now();
  while (true) {
    log.debug("request", {
      method,
      path,
      section,
      attempt,
      body: logTrunc(reqBodyParsed),
    });
    const res = await fetch(`${BASE_URL}${path}`, { ...rest, headers });
    if (res.status === 429 && attempt < 3) {
      const wait = 2 ** attempt * 500;
      log.warn("rate limited; backing off", { path, section, attempt, wait });
      await new Promise((r) => setTimeout(r, wait));
      attempt++;
      continue;
    }
    if (!res.ok) {
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = await res.text().catch(() => "");
      }
      const message = extractErrorMessage(body) ??
        `Voice provider ${section} request failed (${res.status})`;
      // Always include the raw upstream body + the body we sent. The
      // extracted message can be a generic fallback when the upstream
      // shape doesn't match `detail[]` — having the raw body is what
      // lets us diagnose those cases without re-running with more logs.
      log.error("response error", {
        method,
        path,
        section,
        status: res.status,
        ms: Date.now() - t0,
        message,
        upstream_body: logTrunc(body),
        request_body: logTrunc(reqBodyParsed),
      });
      throw new ElevenLabsError(res.status, section, message, body);
    }
    log.debug("response ok", {
      method,
      path,
      section,
      status: res.status,
      ms: Date.now() - t0,
    });
    return res;
  }
}
