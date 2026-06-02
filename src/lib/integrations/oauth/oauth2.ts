/**
 * Generic OAuth2 core — the provider-agnostic engine behind the per-provider
 * `auth.ts` files (Salesforce, Dynamics 365, Outlook, …).
 *
 * It generalizes the flow first written for Google Calendar
 * (`src/lib/integrations/google/auth.ts`):
 *
 *   1. /oauth/start signs an HMAC state token (agent + pending widget action,
 *      optionally the user-supplied instance/org URL) and builds the
 *      authorize URL.
 *   2. The provider redirects to /oauth/callback with { code, state }. The
 *      callback verifies state, exchanges the code, and persists encrypted
 *      access + refresh tokens (plus the per-tenant `instance_url` when the
 *      provider has one) via registerProviderForAgent.
 *   3. On every proxied API call, the proxy calls getValidOAuthToken, which
 *      refreshes the access_token in-place when it's within REFRESH_LEEWAY of
 *      expiry. The refresh_token is preserved across refreshes.
 *
 * Variation points between providers are captured by `OAuth2ProviderConfig`:
 *   - static vs instance-derived endpoints/scopes (Dynamics needs the org URL
 *     baked into both the token scope and the API base);
 *   - whether the token response carries a per-tenant base URL (Salesforce's
 *     `instance_url`);
 *   - whether the user must supply that URL up front (Dynamics).
 *
 * State signing reuses INTEGRATION_TOKEN_ENC_KEY so we don't add another env
 * secret — the encryption key already has to be set for credential storage.
 */
import {
  createHmac,
  timingSafeEqual as nodeTimingSafeEqual,
  randomUUID,
} from "node:crypto";
import { integrationsCol } from "@/lib/mongodb";
import { findWorkspaceIntegration } from "@/lib/integrations/store";
import { encryptToken, decryptToken } from "@/lib/integrations/tokens";

const REFRESH_LEEWAY_SECONDS = 60;
const STATE_TTL_SECONDS = 600; // The OAuth dance shouldn't take >10 min.
const DEFAULT_EXPIRES_IN_SECONDS = 3600; // Fallback when a provider omits expires_in.

// ── Config ──────────────────────────────────────────────────────────────────

/** Connect-time context: the instance/org URL the user supplied (Dynamics). */
export type OAuthInstanceContext = { instanceUrl?: string };

export type OAuth2Endpoints = {
  authorizeUrl: string;
  tokenUrl: string;
};

export type OAuth2ProviderConfig = {
  /** Matches the IntegrationProvider.id and the /api/integrations/<id>/ route segment. */
  providerId: string;
  /** Env var names for the OAuth client credentials (read lazily at request time). */
  clientIdEnv: string;
  clientSecretEnv: string;
  /**
   * Authorize + token endpoints. A function when they depend on the connect-
   * time instance/org URL or a tenant (Microsoft `{tenant}` interpolation is
   * typically done inside the function from env).
   */
  endpoints: OAuth2Endpoints | ((ctx: OAuthInstanceContext) => OAuth2Endpoints);
  /**
   * Requested scopes. A function when the scope is instance-derived — e.g.
   * Dynamics needs `${instanceUrl}/.default`.
   */
  scopes: string[] | ((ctx: OAuthInstanceContext) => string[]);
  /**
   * Extra authorize-query params, e.g. { access_type: "offline",
   * prompt: "consent" } for Google, or { response_mode: "query" } for MS.
   */
  authorizeParams?: Record<string, string>;
  /**
   * Token-response field that carries the provider's per-tenant API base URL
   * (Salesforce → "instance_url"). When set, the value is stored on the
   * integration and the proxy uses it as the upstream base.
   */
  instanceUrlFromToken?: string;
  /**
   * True when the user must supply their instance/org URL at connect time
   * (Dynamics). The start handler requires it; it's signed into the state and
   * stored as `instance_url`.
   */
  requiresInstanceUrlAtConnect?: boolean;
  /** Fallback access-token TTL when the provider omits expires_in (Salesforce). */
  defaultExpiresInSeconds?: number;
};

function resolveEndpoints(
  cfg: OAuth2ProviderConfig,
  ctx: OAuthInstanceContext,
): OAuth2Endpoints {
  return typeof cfg.endpoints === "function" ? cfg.endpoints(ctx) : cfg.endpoints;
}

function resolveScopes(
  cfg: OAuth2ProviderConfig,
  ctx: OAuthInstanceContext,
): string[] {
  return typeof cfg.scopes === "function" ? cfg.scopes(ctx) : cfg.scopes;
}

// ── Env + base URL ────────────────────────────────────────────────────────

function getEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`${name} is not set. Configure OAuth credentials in your env.`);
  }
  return v;
}

function getStateKey(): Buffer {
  const raw = process.env.INTEGRATION_TOKEN_ENC_KEY;
  if (!raw) {
    throw new Error(
      "INTEGRATION_TOKEN_ENC_KEY is not set; required to sign OAuth state.",
    );
  }
  return Buffer.from(raw, "hex");
}

export function getAppBaseUrl(): string {
  const url =
    process.env.APP_BASE_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null) ??
    "http://localhost:3000";
  return url.replace(/\/$/, "");
}

export function getRedirectUri(providerId: string): string {
  return `${getAppBaseUrl()}/api/integrations/${providerId}/oauth/callback`;
}

// ── State token (HMAC-signed JSON) ──────────────────────────────────────────

export type OAuthState = {
  agent_id: string;
  action_id: string;
  /** Per-tenant instance/org URL when the provider requires it (Dynamics). */
  instance_url?: string;
  nonce: string;
  exp: number;
};

function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UrlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

export function signOAuthState(
  payload: Omit<OAuthState, "nonce" | "exp">,
): string {
  const full: OAuthState = {
    ...payload,
    nonce: randomUUID(),
    exp: Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS,
  };
  const body = base64UrlEncode(Buffer.from(JSON.stringify(full), "utf8"));
  const sig = base64UrlEncode(
    createHmac("sha256", getStateKey()).update(body).digest(),
  );
  return `${body}.${sig}`;
}

export function verifyOAuthState(token: string): OAuthState | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = base64UrlEncode(
    createHmac("sha256", getStateKey()).update(body).digest(),
  );
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !nodeTimingSafeEqual(a, b)) return null;
  let parsed: OAuthState;
  try {
    parsed = JSON.parse(base64UrlDecode(body).toString("utf8")) as OAuthState;
  } catch {
    return null;
  }
  if (typeof parsed.exp !== "number" || parsed.exp < Date.now() / 1000) {
    return null;
  }
  return parsed;
}

// ── Authorize URL ───────────────────────────────────────────────────────────

export function buildAuthorizeUrl(
  cfg: OAuth2ProviderConfig,
  opts: { state: string; instanceUrl?: string },
): string {
  const ctx: OAuthInstanceContext = { instanceUrl: opts.instanceUrl };
  const { authorizeUrl } = resolveEndpoints(cfg, ctx);
  const params = new URLSearchParams({
    client_id: getEnv(cfg.clientIdEnv),
    redirect_uri: getRedirectUri(cfg.providerId),
    response_type: "code",
    scope: resolveScopes(cfg, ctx).join(" "),
    state: opts.state,
    ...(cfg.authorizeParams ?? {}),
  });
  return `${authorizeUrl}?${params.toString()}`;
}

// ── Token exchange + refresh ──────────────────────────────────────────────

export type OAuth2Tokens = {
  access_token: string;
  refresh_token?: string | null;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  id_token?: string;
  /** Provider-specific per-tenant base (Salesforce). */
  instance_url?: string;
  [key: string]: unknown;
};

type OAuth2TokenError = {
  error?: string;
  error_description?: string;
};

async function postToTokenEndpoint(
  tokenUrl: string,
  params: Record<string, string>,
): Promise<OAuth2Tokens> {
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try {
      const json = JSON.parse(text) as OAuth2TokenError;
      detail = `${json.error ?? "error"}${json.error_description ? `: ${json.error_description}` : ""}`;
    } catch {
      // non-JSON error body — pass raw text through
    }
    throw new Error(`OAuth token endpoint ${res.status}: ${detail}`);
  }
  return JSON.parse(text) as OAuth2Tokens;
}

export async function exchangeCodeForTokens(
  cfg: OAuth2ProviderConfig,
  opts: { code: string; instanceUrl?: string },
): Promise<OAuth2Tokens> {
  const { tokenUrl } = resolveEndpoints(cfg, { instanceUrl: opts.instanceUrl });
  return postToTokenEndpoint(tokenUrl, {
    code: opts.code,
    client_id: getEnv(cfg.clientIdEnv),
    client_secret: getEnv(cfg.clientSecretEnv),
    redirect_uri: getRedirectUri(cfg.providerId),
    grant_type: "authorization_code",
  });
}

export async function refreshAccessToken(
  cfg: OAuth2ProviderConfig,
  opts: { refreshToken: string; instanceUrl?: string },
): Promise<OAuth2Tokens> {
  const ctx: OAuthInstanceContext = { instanceUrl: opts.instanceUrl };
  const { tokenUrl } = resolveEndpoints(cfg, ctx);
  // Some providers (Microsoft) require `scope` on refresh; harmless elsewhere.
  return postToTokenEndpoint(tokenUrl, {
    client_id: getEnv(cfg.clientIdEnv),
    client_secret: getEnv(cfg.clientSecretEnv),
    refresh_token: opts.refreshToken,
    grant_type: "refresh_token",
    scope: resolveScopes(cfg, ctx).join(" "),
  });
}

// ── Email (display only) ───────────────────────────────────────────────────

/**
 * Decode the email claim from an id_token without verifying its signature.
 * id_tokens come directly from the provider's token endpoint over TLS during
 * the exchange we just initiated — trusted for display only. Microsoft uses
 * `preferred_username`; Google uses `email`. Returns null if absent/malformed.
 */
export function emailFromIdToken(idToken: string | undefined): string | null {
  if (!idToken) return null;
  const parts = idToken.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(base64UrlDecode(parts[1]).toString("utf8")) as {
      email?: unknown;
      preferred_username?: unknown;
    };
    if (typeof payload.email === "string") return payload.email;
    if (typeof payload.preferred_username === "string")
      return payload.preferred_username;
    return null;
  } catch {
    return null;
  }
}

// ── Stored credentials ──────────────────────────────────────────────────────

export type StoredOAuthCredentials = {
  access_token: string; // encrypted
  refresh_token: string; // encrypted
  expires_at: number; // unix ms — unencrypted timestamp
  scope: string;
  token_type: string;
  email: string | null;
  /** Per-tenant API base (Salesforce instance_url / Dynamics org URL). */
  instance_url?: string;
};

export function buildOAuthCredentials(
  cfg: OAuth2ProviderConfig,
  tokens: OAuth2Tokens,
  opts: { fallbackRefreshToken?: string; instanceUrl?: string } = {},
): StoredOAuthCredentials {
  const refresh = tokens.refresh_token ?? opts.fallbackRefreshToken;
  if (!refresh) {
    throw new Error(
      `${cfg.providerId} did not return a refresh_token. Re-authorize and ensure offline access is requested.`,
    );
  }
  const expiresIn =
    tokens.expires_in ?? cfg.defaultExpiresInSeconds ?? DEFAULT_EXPIRES_IN_SECONDS;
  // Prefer the URL the token response carries; else the user-supplied one.
  const tokenInstanceUrl = cfg.instanceUrlFromToken
    ? (tokens[cfg.instanceUrlFromToken] as string | undefined)
    : undefined;
  const instanceUrl = tokenInstanceUrl ?? opts.instanceUrl;
  return {
    access_token: encryptToken(tokens.access_token),
    refresh_token: encryptToken(refresh),
    expires_at: Date.now() + expiresIn * 1000,
    scope: tokens.scope ?? "",
    token_type: tokens.token_type ?? "Bearer",
    email: emailFromIdToken(tokens.id_token),
    ...(instanceUrl ? { instance_url: instanceUrl.replace(/\/$/, "") } : {}),
  };
}

/**
 * Return a valid access token for the workspace's connected integration,
 * refreshing it in-place when within REFRESH_LEEWAY of expiry. Throws if the
 * integration doesn't exist or the refresh fails. Used by the proxy's token
 * resolver. Mirrors getValidGoogleToken but is config-driven.
 */
export async function getValidOAuthToken(
  cfg: OAuth2ProviderConfig,
): Promise<string> {
  const doc = await findWorkspaceIntegration(cfg.providerId);
  if (!doc) {
    throw new Error(`${cfg.providerId} is not connected in this workspace.`);
  }
  const creds = doc.credentials as Partial<StoredOAuthCredentials>;
  if (
    typeof creds.access_token !== "string" ||
    typeof creds.refresh_token !== "string" ||
    typeof creds.expires_at !== "number"
  ) {
    throw new Error(`${cfg.providerId} credentials are malformed.`);
  }

  const nowMs = Date.now();
  if (creds.expires_at - nowMs > REFRESH_LEEWAY_SECONDS * 1000) {
    return decryptToken(creds.access_token);
  }

  const refreshToken = decryptToken(creds.refresh_token);
  const refreshed = await refreshAccessToken(cfg, {
    refreshToken,
    instanceUrl: creds.instance_url,
  });
  const expiresIn =
    refreshed.expires_in ?? cfg.defaultExpiresInSeconds ?? DEFAULT_EXPIRES_IN_SECONDS;
  const next: StoredOAuthCredentials = {
    // Most providers re-issue only the access_token on refresh; preserve the
    // stored refresh_token unless a new one came back (Microsoft rotates it).
    access_token: encryptToken(refreshed.access_token),
    refresh_token: refreshed.refresh_token
      ? encryptToken(refreshed.refresh_token)
      : creds.refresh_token,
    expires_at: Date.now() + expiresIn * 1000,
    scope: refreshed.scope || creds.scope || "",
    token_type: refreshed.token_type || creds.token_type || "Bearer",
    email: creds.email ?? null,
    ...(creds.instance_url ? { instance_url: creds.instance_url } : {}),
  };
  await (await integrationsCol()).updateOne(
    { _id: doc._id },
    { $set: { credentials: next, updated_at: new Date() } },
  );
  return refreshed.access_token;
}
