import { NextResponse, type NextRequest } from "next/server";
import { requireSharedSecret } from "@/lib/auth";
import { listVoices, ElevenLabsError } from "@/lib/elevenlabs/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const guard = requireSharedSecret(req);
  if (guard) return guard;
  try {
    const voices = await listVoices();
    return NextResponse.json({ voices });
  } catch (err) {
    if (err instanceof ElevenLabsError) {
      return NextResponse.json(
        { error: err.message },
        { status: err.status },
      );
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
