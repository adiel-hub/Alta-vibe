import { NextResponse, type NextRequest } from "next/server";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { requireSharedSecret } from "@/lib/auth";
import { agentsCol } from "@/lib/mongodb";
import {
  initiateOutboundCall,
  ElevenLabsError,
} from "@/lib/elevenlabs/client";
import { enrichCallContext } from "@/lib/integrations/enrichment";
import { createLogger, newRequestId } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  to_number: z.string().regex(/^\+?[0-9 \-()]{6,20}$/),
  agent_phone_number_id: z.string().min(1),
  caller_email: z.string().email().optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const log = createLogger("outbound-call", {
    route: "POST /agents/[id]/outbound-call",
    req_id: newRequestId(),
  });
  const guard = requireSharedSecret(req);
  if (guard) return guard;

  const { id } = await params;
  if (!ObjectId.isValid(id)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const agent = await (await agentsCol()).findOne({ _id: new ObjectId(id) });
  if (!agent) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const dynamicVariables = await enrichCallContext({
    agentMongoId: id,
    to_number: parsed.data.to_number,
    caller_email: parsed.data.caller_email,
  });
  log.info("enrichment", {
    keys: Object.keys(dynamicVariables),
    has_name: Boolean(dynamicVariables.caller_name),
  });

  try {
    const result = await initiateOutboundCall({
      agentId: agent.elevenlabs_agent_id,
      agentPhoneNumberId: parsed.data.agent_phone_number_id,
      toNumber: parsed.data.to_number,
      dynamicVariables,
    });
    log.info("call initiated", { conversation_id: result.conversation_id });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof ElevenLabsError) {
      log.error("eleven error", { status: err.status, section: err.section });
      return NextResponse.json(
        { error: err.message, section: err.section },
        { status: err.status },
      );
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    log.error("unknown error", { message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
