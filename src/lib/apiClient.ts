/**
 * Browser-side wrapper that attaches the shared-secret header on every API call.
 * Not real auth; matches the server-side gate in lib/auth.ts.
 */
export function appFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  const secret = process.env.NEXT_PUBLIC_APP_SHARED_SECRET;
  if (secret) headers.set("x-app-secret", secret);
  return fetch(input, { ...init, headers });
}
