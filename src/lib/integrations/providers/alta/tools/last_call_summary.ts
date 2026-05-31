/**
 * Fetches the previous conversation's summary + data_collection so the
 * agent can reference what was discussed last time. Two data paths:
 *
 *  1. Fast path — if the post-call webhook persisted `data_collection`
 *     back into the matching `CampaignItem`, we read it directly from
 *     Mongo. One round-trip, no ElevenLabs API call.
 *  2. Fallback — fetch the conversation detail from ElevenLabs and use
 *     its `analysis.transcript_summary` + `data_collection`.
 *
 * Depends on `engagement_last_conversation_id` from `alta_call_history`.
 */
import { ObjectId } from "mongodb";
import { callCampaignsCol } from "@/lib/mongodb";
import { getConversationDetail } from "@/lib/elevenlabs/conversations/detail";
import type { ProviderRuntimeToolSpec } from "../../types";

export const ALTA_LAST_CALL_SUMMARY: ProviderRuntimeToolSpec = {
  key: "last_call_summary",
  name: "alta_last_call_summary",
  description:
    "Fetches the previous conversation's summary and key extracted fields so the agent can reference what was discussed. Depends on alta_call_history running first. Exposes engagement_summary and engagement_outcomes (JSON-stringified key/value of prior data_collection).",
  phase: "pre_call",
  method: "POST",
  path: "alta://last_call_summary",
  category: "Alta",
  needs: ["engagement_last_conversation_id"],
  timeout_ms: 8000, // fetching transcripts can be slow
  execute: async (ctx, prior) => {
    const conversationId = prior.engagement_last_conversation_id;
    if (!conversationId) return null;

    // 1) Fast path — read the cached data_collection off the matching
    //    campaign item. Available when the post-call webhook has fired
    //    on this conversation.
    if (ctx.prospect_id && ObjectId.isValid(ctx.prospect_id)) {
      const campaigns = await callCampaignsCol();
      const hit = await campaigns.findOne(
        { "items.conversation_id": conversationId },
        { projection: { items: 1 } },
      );
      const item = hit?.items.find((i) => i.conversation_id === conversationId);
      if (item?.data_collection) {
        return {
          engagement_summary: "",
          engagement_outcomes: JSON.stringify(item.data_collection),
        };
      }
    }

    // 2) Fallback — fetch from ElevenLabs.
    try {
      const detail = await getConversationDetail(conversationId);
      const summary = detail.analysis?.summary ?? detail.outcome ?? "";
      const dc = detail.analysis?.data_collection ?? [];
      const outcomes = Object.fromEntries(
        dc.map((d) => [d.name, String(d.value ?? "")]),
      );
      return {
        engagement_summary: summary,
        engagement_outcomes: JSON.stringify(outcomes),
      };
    } catch {
      return null;
    }
  },
  output_aliases: {
    engagement_summary: "engagement_summary",
    engagement_outcomes: "engagement_outcomes",
  },
  narrative: (_ctx, output) => {
    const o = output as Record<string, string> | null;
    if (!o?.engagement_summary) return null;
    return `Last conversation: ${o.engagement_summary}`;
  },
};
