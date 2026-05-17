/**
 * Widget resolution endpoint. Browser POSTs here when the user completes an
 * interactive widget (connects an integration, confirms, picks an option).
 *
 * On success:
 *   - Mark widget_actions row done
 *   - If kind=connect_integration: run the side-effect (register provider's
 *     runtime tools on the agent) using the stub credentials
 *   - Insert a synthetic SYSTEM chat message describing the resolution
 *   - Enqueue a new turn so the agent's loop continues with the result
 *     in its transcript.
 */
import { NextResponse, type NextRequest } from "next/server";
import { ObjectId } from "mongodb";
import { after } from "next/server";
import { z } from "zod";
import { requireSharedSecret } from "@/lib/auth";
import { agentsCol, widgetActionsCol } from "@/lib/mongodb";
import { enqueueTurnJob, processTurnJob } from "@/lib/turn-jobs/runner";
import { registerProviderForAgent } from "@/lib/integrations/registerProviderTools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  status: z.enum(["done", "cancelled", "failed"]).default("done"),
  result: z.unknown().optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; actionId: string }> },
) {
  const guard = requireSharedSecret(req);
  if (guard) return guard;

  const { id, actionId } = await params;
  if (!ObjectId.isValid(id) || !ObjectId.isValid(actionId)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }
  const agentId = new ObjectId(id);
  const _actionId = new ObjectId(actionId);

  const parsed = Body.safeParse(await req.json().catch(() => ({ status: "done" })));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const agent = await (await agentsCol()).findOne({ _id: agentId });
  if (!agent) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const widgets = await widgetActionsCol();
  const action = await widgets.findOne({ _id: _actionId, agent_id: agentId });
  if (!action) return NextResponse.json({ error: "Action not found" }, { status: 404 });
  if (action.status !== "pending") {
    return NextResponse.json({ error: "Action already resolved" }, { status: 409 });
  }

  let summary = "User cancelled the action.";
  let effectMessage: string | null = null;
  if (parsed.data.status === "done") {
    if (action.kind === "connect_integration") {
      const provider = (action.payload as { provider?: string }).provider;
      if (provider) {
        try {
          const { added_tools } = await registerProviderForAgent(
            id,
            provider,
            // Stub credentials — real OAuth would populate these via callback.
            { access_token: "stub_token_dev_only", connected_via: "stub" },
          );
          summary = `Connected ${provider}.`;
          effectMessage = `User connected ${provider}. ${added_tools} runtime tool${added_tools === 1 ? "" : "s"} are now available on the agent.`;
        } catch (err) {
          const message = err instanceof Error ? err.message : "register failed";
          summary = `Failed to connect ${provider}: ${message}`;
          effectMessage = `User attempted to connect ${provider} but registration failed: ${message}`;
        }
      }
    } else if (action.kind === "confirm") {
      summary = "User confirmed.";
      effectMessage = "User confirmed the requested action.";
    } else if (action.kind === "pick_option") {
      const choice = (parsed.data.result as { value?: string } | undefined)?.value;
      summary = `User picked: ${choice ?? "(unknown)"}.`;
      effectMessage = `User picked option: ${choice ?? "(unknown)"}.`;
    }
  } else {
    effectMessage = `User cancelled the widget action.`;
  }

  await widgets.updateOne(
    { _id: _actionId },
    {
      $set: {
        status: parsed.data.status,
        result: parsed.data.result ?? null,
        resolved_at: new Date(),
      },
    },
  );

  if (effectMessage) {
    const newJobId = await enqueueTurnJob(agentId, effectMessage, "system");
    after(async () => {
      try {
        await processTurnJob(newJobId);
      } catch {
        // job runner handles its own failures
      }
    });
    return NextResponse.json({
      status: parsed.data.status,
      summary,
      resumed_job_id: newJobId.toHexString(),
    });
  }

  return NextResponse.json({ status: parsed.data.status, summary });
}
