/**
 * Google OAuth helpers for the Calendar integration.
 *
 * Connection lifecycle:
 *   1. Widget opens /api/integrations/google_calendar/oauth/start → this
 *      module signs a state token tying the redirect back to the agent +
 *      pending widget action, then builds Google's authorize URL.
 *   2. Google redirects to /api/integrations/google_calendar/oauth/callback
 *      with { code, state }. The callback verifies state, exchanges code,
 *      and persists encrypted access_token + refresh_token via
 *      registerProviderForAgent.
 *   3. On every proxied API call, the proxy invokes getValidGoogleToken,
 *      which refreshes the access_token in-place when it's within 60s of
 *      expiry. The refresh_token is long-lived (only revoked when the user
 *      removes app access from their Google account).
 *
 * State signing uses HMAC-SHA256 keyed off INTEGRATION_TOKEN_ENC_KEY so we
 * don't add another secret to the env list — the encryption key already
 * has to be configured for any of this to work.
 */
import {
  createHmac,
  timingSafeEqual as nodeTimingSafeEqual,
  randomUUID,
} from "node:crypto";
import { ObjectId } from "mongodb";
import { integrationsCol } from "@/lib/mongodb";
import { findWorkspaceIntegration } from "@/lib/integrations/store";
import { encryptToken, decryptToken } from "@/lib/integrations/tokens";
import { GOOGLE_CALENDAR_PROVIDER } from "@/lib/integrations/providers/google";

const REFRESH_LEEWAY_SECONDS = 60;
const STATE_TTL_SECONDS = 600; // OAuth dance shouldn't take more than 10 min.

function getEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `${name} is not set. Configure Google OAuth credentials in your env.`,
    );
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

function getAppBaseUrl(): string {
  const url =
    process.env.APP_BASE_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null) ??
    "http://localhost:3000";
  return url.replace(/\/$/, "");
}

export function getRedirectUri(): string {
  return `${getAppBaseUrl()}/api/integrations/google_calendar/oauth/callback`;
}

// --- State token (HMAC-signed JSON) ----------------------------------------

export type OAuthState = {
  agent_id: string;
  action_id: string;
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

// --- Authorize URL ---------------------------------------------------------

export function buildAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: getEnv("GOOGLE_OAUTH_CLIENT_ID"),
    redirect_uri: getRedirectUri(),
    response_type: "code",
    scope: GOOGLE_CALENDAR_PROVIDER.oauth.scopes.join(" "),
    access_type: "offline", // ask for a refresh_token
    prompt: "consent", // force the consent screen so we ALWAYS get a refresh_token
    include_granted_scopes: "true",
    state,
  });
  return `${GOOGLE_CALENDAR_PROVIDER.oauth.authorize_url}?${params.toString()}`;
}

// --- Token exchange + refresh ---------------------------------------------

export type GoogleTokens = {
  access_token: string;
  refresh_token: string | null;
  expires_in: number;
  token_type: string;
  scope: string;
  id_token?: string;
};

type GoogleTokenError = {
  error: string;
  error_description?: string;
};

async function postToTokenEndpoint(
  params: Record<string, string>,
): Promise<GoogleTokens> {
  const res = await fetch(GOOGLE_CALENDAR_PROVIDER.oauth.token_url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try {
      const json = JSON.parse(text) as GoogleTokenError;
      detail = `${json.error}${json.error_description ? `: ${json.error_description}` : ""}`;
    } catch {
      // non-JSON error body — pass raw text through
    }
    throw new Error(`Google token endpoint ${res.status}: ${detail}`);
  }
  return JSON.parse(text) as GoogleTokens;
}

export async function exchangeCodeForTokens(code: string): Promise<GoogleTokens> {
  return postToTokenEndpoint({
    code,
    client_id: getEnv("GOOGLE_OAUTH_CLIENT_ID"),
    client_secret: getEnv("GOOGLE_OAUTH_CLIENT_SECRET"),
    redirect_uri: getRedirectUri(),
    grant_type: "authorization_code",
  });
}

export async function refreshAccessToken(
  refreshToken: string,
): Promise<GoogleTokens> {
  // Refresh responses don't include a new refresh_token — the caller must
  // preserve the original one in storage.
  return postToTokenEndpoint({
    client_id: getEnv("GOOGLE_OAUTH_CLIENT_ID"),
    client_secret: getEnv("GOOGLE_OAUTH_CLIENT_SECRET"),
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
}

// --- Email lookup (for display only) --------------------------------------

/**
 * Decode the `email` claim from a Google id_token without verifying its
 * signature. id_tokens come directly from Google's token endpoint over TLS
 * during the code-exchange step we just initiated — we trust the response
 * for display purposes only. Returns null if the token is missing or
 * malformed.
 */
export function emailFromIdToken(idToken: string | undefined): string | null {
  if (!idToken) return null;
  const parts = idToken.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(base64UrlDecode(parts[1]).toString("utf8")) as {
      email?: unknown;
    };
    return typeof payload.email === "string" ? payload.email : null;
  } catch {
    return null;
  }
}

// --- Stored credentials -----------------------------------------------------

export type StoredGoogleCredentials = {
  access_token: string; // encrypted
  refresh_token: string; // encrypted
  expires_at: number; // unix ms — unencrypted timestamp
  scope: string;
  token_type: string;
  email: string | null;
};

export function buildCredentialsFromTokens(
  tokens: GoogleTokens,
  fallbackRefreshToken?: string,
): StoredGoogleCredentials {
  const refresh = tokens.refresh_token ?? fallbackRefreshToken;
  if (!refresh) {
    throw new Error(
      "Google did not return a refresh_token. Re-authorize with prompt=consent.",
    );
  }
  return {
    access_token: encryptToken(tokens.access_token),
    refresh_token: encryptToken(refresh),
    expires_at: Date.now() + tokens.expires_in * 1000,
    scope: tokens.scope,
    token_type: tokens.token_type,
    email: emailFromIdToken(tokens.id_token),
  };
}

/**
 * Return a valid Google access token for the agent's connected integration,
 * refreshing it in-place when it's within REFRESH_LEEWAY_SECONDS of expiry.
 * Throws if the integration doesn't exist or the refresh fails. Used by the
 * proxy route in place of the default `decrypt access_token` path.
 */
export async function getValidGoogleToken(
  // Argument kept for back-compat with existing call sites; integrations
  // are now workspace-shared so we look up by provider alone.
  _agentMongoId?: string,
): Promise<string> {
  const doc = await findWorkspaceIntegration("google_calendar");
  if (!doc) {
    throw new Error("Google Calendar is not connected in this workspace.");
  }
  const creds = doc.credentials as Partial<StoredGoogleCredentials>;
  if (
    typeof creds.access_token !== "string" ||
    typeof creds.refresh_token !== "string" ||
    typeof creds.expires_at !== "number"
  ) {
    throw new Error("Google Calendar credentials are malformed.");
  }

  const nowMs = Date.now();
  if (creds.expires_at - nowMs > REFRESH_LEEWAY_SECONDS * 1000) {
    return decryptToken(creds.access_token);
  }

  // Refresh.
  const refreshToken = decryptToken(creds.refresh_token);
  const refreshed = await refreshAccessToken(refreshToken);
  const next: StoredGoogleCredentials = {
    access_token: encryptToken(refreshed.access_token),
    refresh_token: creds.refresh_token, // Google only re-issues access_token
    expires_at: Date.now() + refreshed.expires_in * 1000,
    scope: refreshed.scope || creds.scope || "",
    token_type: refreshed.token_type || creds.token_type || "Bearer",
    email: creds.email ?? null,
  };
  await (await integrationsCol()).updateOne(
    { _id: doc._id },
    {
      $set: {
        credentials: next,
        updated_at: new Date(),
      },
    },
  );
  return refreshed.access_token;
}
