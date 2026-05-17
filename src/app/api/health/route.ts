/**
 * Liveness + readiness probe. Returns 200 if the API is up and Mongo is
 * reachable. Used by Vercel observability and any external uptime monitor.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/lib/mongodb";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest) {
  const started = Date.now();
  try {
    const db = await getDb();
    await db.command({ ping: 1 });
    return NextResponse.json({
      status: "ok",
      mongo: "ok",
      latency_ms: Date.now() - started,
      version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "dev",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      {
        status: "degraded",
        mongo: "error",
        error: message,
      },
      { status: 503 },
    );
  }
}
