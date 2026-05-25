/**
 * Sequential outbound-call campaign runner. Drives the items in a
 * `call_campaigns` doc one at a time:
 *
 *   queued → claim → for each item:
 *     - mark item calling, emit `item_started`
 *     - call ElevenLabs initiateOutboundCall (returns immediately with
 *       conversation_id — we don't wait for the call to end here)
 *     - mark item done/failed, emit corresponding event
 *     - wait `INTER_CALL_DELAY_MS` so the agent isn't taking two calls
 *       on top of each other; honour cancellation between items
 *   → mark campaign completed/cancelled, emit `campaign_done`
 *
 * The runner is meant to be invoked from a route handler with
 * `after(() => runCampaign(id))`. It is idempotent across restarts in the
 * happy path because it claims by status transition (queued → running).
 */
import { ObjectId } from "mongodb";
import { agentsCol, callCampaignsCol } from "@/lib/mongodb";
import { initiateOutboundCall, ElevenLabsError } from "@/lib/elevenlabs/client";
import { enrichCallContext } from "@/lib/integrations/enrichment";
import { createLogger } from "@/lib/logger";
import type { CampaignEvent } from "@/types/agent";

const log = createLogger("campaign");

const INTER_CALL_DELAY_MS = 5_000;

async function appendEvent(
  campaignId: ObjectId,
  event: CampaignEvent["event"],
): Promise<void> {
  const campaigns = await callCampaignsCol();
  const cur = await campaigns.findOne(
    { _id: campaignId },
    { projection: { next_seq: 1 } },
  );
  if (!cur) return;
  const seq = cur.next_seq;
  await campaigns.updateOne(
    { _id: campaignId },
    {
      $push: {
        events: { seq, at: new Date(), event },
      },
      $set: { next_seq: seq + 1, last_event_at: new Date() },
    },
  );
}

async function isCancelled(campaignId: ObjectId): Promise<boolean> {
  const campaigns = await callCampaignsCol();
  const c = await campaigns.findOne(
    { _id: campaignId },
    { projection: { status: 1 } },
  );
  return c?.status === "cancelled";
}

export async function runCampaign(campaignId: ObjectId): Promise<void> {
  const campaigns = await callCampaignsCol();
  const claim = await campaigns.findOneAndUpdate(
    { _id: campaignId, status: "queued" },
    {
      $set: {
        status: "running",
        started_at: new Date(),
        last_event_at: new Date(),
      },
    },
    { returnDocument: "after" },
  );
  if (!claim) {
    log.debug("claim missed", { campaign: campaignId.toHexString() });
    return;
  }
  const campaign = claim;
  const clog = log.child({ campaign: campaignId.toHexString() });
  clog.info("started", {
    items: campaign.items.length,
    audience: campaign.audience_id.toHexString(),
    agent: campaign.agent_id.toHexString(),
  });

  await appendEvent(campaignId, {
    type: "campaign_started",
    total: campaign.items.length,
  });

  // Re-load the agent row once; we need elevenlabs_agent_id per call.
  const agents = await agentsCol();
  const agent = await agents.findOne({ _id: campaign.agent_id });
  if (!agent) {
    clog.error("agent missing");
    await campaigns.updateOne(
      { _id: campaignId },
      { $set: { status: "failed", ended_at: new Date() } },
    );
    await appendEvent(campaignId, { type: "campaign_done", status: "failed" });
    return;
  }

  let cancelled = false;
  for (let i = 0; i < campaign.items.length; i++) {
    if (await isCancelled(campaignId)) {
      cancelled = true;
      break;
    }
    const item = campaign.items[i];
    if (item.status !== "queued") continue;
    if (!item.to_number) {
      await campaigns.updateOne(
        { _id: campaignId, "items.prospect_id": item.prospect_id },
        {
          $set: {
            "items.$.status": "skipped",
            "items.$.error": "No phone number",
            "items.$.ended_at": new Date(),
            last_event_at: new Date(),
          },
        },
      );
      await appendEvent(campaignId, {
        type: "item_skipped",
        prospect_id: item.prospect_id.toHexString(),
        reason: "No phone number",
      });
      continue;
    }

    await campaigns.updateOne(
      { _id: campaignId, "items.prospect_id": item.prospect_id },
      {
        $set: {
          "items.$.status": "calling",
          "items.$.started_at": new Date(),
          last_event_at: new Date(),
        },
      },
    );
    await appendEvent(campaignId, {
      type: "item_started",
      prospect_id: item.prospect_id.toHexString(),
      to_number: item.to_number,
    });

    try {
      const dynamicVariables = await enrichCallContext({
        agentMongoId: agent._id.toHexString(),
        to_number: item.to_number,
      });
      const result = await initiateOutboundCall({
        agentId: agent.elevenlabs_agent_id,
        agentPhoneNumberId: campaign.agent_phone_number_id,
        toNumber: item.to_number,
        dynamicVariables,
      });
      await campaigns.updateOne(
        { _id: campaignId, "items.prospect_id": item.prospect_id },
        {
          $set: {
            "items.$.status": "done",
            "items.$.conversation_id": result.conversation_id,
            "items.$.ended_at": new Date(),
            last_event_at: new Date(),
          },
        },
      );
      await appendEvent(campaignId, {
        type: "item_done",
        prospect_id: item.prospect_id.toHexString(),
        conversation_id: result.conversation_id,
      });
      clog.info("call placed", {
        prospect_id: item.prospect_id.toHexString(),
        conversation_id: result.conversation_id,
      });
    } catch (err) {
      const message =
        err instanceof ElevenLabsError
          ? `${err.section}: ${err.message}`
          : err instanceof Error
            ? err.message
            : "call failed";
      await campaigns.updateOne(
        { _id: campaignId, "items.prospect_id": item.prospect_id },
        {
          $set: {
            "items.$.status": "failed",
            "items.$.error": message,
            "items.$.ended_at": new Date(),
            last_event_at: new Date(),
          },
        },
      );
      await appendEvent(campaignId, {
        type: "item_failed",
        prospect_id: item.prospect_id.toHexString(),
        error: message,
      });
      clog.warn("call failed", {
        prospect_id: item.prospect_id.toHexString(),
        message,
      });
    }

    // Inter-call delay (skip after the last item). Don't burn the whole
    // window if the user cancels — poll every 500 ms.
    if (i < campaign.items.length - 1) {
      const until = Date.now() + INTER_CALL_DELAY_MS;
      while (Date.now() < until) {
        if (await isCancelled(campaignId)) {
          cancelled = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      if (cancelled) break;
    }
  }

  const finalStatus = cancelled ? "cancelled" : "completed";
  await campaigns.updateOne(
    { _id: campaignId },
    {
      $set: {
        status: finalStatus,
        ended_at: new Date(),
        last_event_at: new Date(),
      },
    },
  );
  await appendEvent(campaignId, {
    type: "campaign_done",
    status: finalStatus,
  });
  clog.info("finished", { status: finalStatus });
}

export async function cancelCampaign(campaignId: ObjectId): Promise<void> {
  const campaigns = await callCampaignsCol();
  await campaigns.updateOne(
    { _id: campaignId, status: { $in: ["queued", "running"] } },
    { $set: { status: "cancelled", last_event_at: new Date() } },
  );
  log.info("cancel requested", { campaign: campaignId.toHexString() });
}
