import { NextResponse, type NextRequest } from "next/server";

/**
 * Single-user prototype hardening. Not real auth — prevents random discovery
 * of a preview URL from burning ElevenLabs / Anthropic quota.
 */
export function requireSharedSecret(req: NextRequest): NextResponse | null {
  const expected = process.env.APP_SHARED_SECRET;
  if (!expected) return null; // dev fallback when not configured

  const header = req.headers.get("x-app-secret");
  if (header && timingSafeEqual(header, expected)) return null;

  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}
