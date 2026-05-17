/**
 * Enqueue a new turn job and kick off background processing. Returns the job
 * id immediately so the client can subscribe to its event stream at
 * `/api/agents/[id]/turns/[jobId]/stream`. The work continues even if the
 * client refreshes — events are persisted to Mongo as they happen.
 */
import { NextResponse, type NextRequest } from "next/server";
import { ObjectId } from "mongodb";
import { after } from "next/server";
import { z } from "zod";
import { requireSharedSecret } from "@/lib/auth";
import { agentsCol } from "@/lib/mongodb";
import { enqueueTurnJob, processTurnJob } from "@/lib/turn-jobs/runner";
import { createLogger, newRequestId } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800;

const Body = z.object({ text: z.string().min(1).max(4_000) });

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const log = createLogger("api", {
    route: "POST /api/agents/[id]/chat",
    req_id: newRequestId(),
  });
  log.info("request");
  const guard = requireSharedSecret(req);
  if (guard) return guard;

  const { id } = await params;
  if (!ObjectId.isValid(id)) {
    log.warn("invalid agent id", { id });
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }
  const _id = new ObjectId(id);

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const agent = await (await agentsCol()).findOne({ _id });
  if (!agent) {
    log.warn("agent not found", { id });
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const jobId = await enqueueTurnJob(_id, parsed.data.text);
  log.info("enqueued", { job_id: jobId.toHexString(), agent_id: id });

  // Run the turn in the background. On Vercel this is `waitUntil`-backed and
  // continues after we send the response.
  after(async () => {
    try {
      await processTurnJob(jobId);
    } catch {
      // processTurnJob handles its own errors and persists status=failed.
    }
  });

  return NextResponse.json({ jobId: jobId.toHexString() });
}
