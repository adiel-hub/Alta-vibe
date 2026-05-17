import { NextResponse, type NextRequest } from "next/server";
import { createLogger } from "./logger";

const log = createLogger("auth");

/**
 * Single-user prototype hardening. Not real auth — but in production we
 * REQUIRE APP_SHARED_SECRET to be set; without it every API route returns
 * 503 so a misconfigured deploy can't silently expose itself. In dev
 * (NODE_ENV !== "production") we allow unset for friction-free local work.
 */
export function requireSharedSecret(req: NextRequest): NextResponse | null {
  const expected = process.env.APP_SHARED_SECRET;
  const isProd = process.env.NODE_ENV === "production";

  if (!expected) {
    if (isProd) {
      log.error("missing APP_SHARED_SECRET in production", {
        path: req.nextUrl.pathname,
      });
      return NextResponse.json(
        { error: "APP_SHARED_SECRET is not configured on this deployment." },
        { status: 503 },
      );
    }
    log.trace("dev fallback (no secret configured)", { path: req.nextUrl.pathname });
    return null; // dev fallback
  }

  const header = req.headers.get("x-app-secret");
  if (header && timingSafeEqual(header, expected)) {
    log.trace("allow", { path: req.nextUrl.pathname });
    return null;
  }
  log.warn("deny", {
    path: req.nextUrl.pathname,
    has_header: header !== null,
    ip: req.headers.get("x-forwarded-for") ?? undefined,
  });
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
