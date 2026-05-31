/**
 * Counts past conversations with this prospect across all campaigns and
 * surfaces the most recent conversation_id (which `alta_last_call_summary`
 * uses to fetch the transcript / data_collection).
 */
import { ObjectId } from "mongodb";
import { callCampaignsCol } from "@/lib/mongodb";
import type { ProviderRuntimeToolSpec } from "../../types";

export const ALTA_CALL_HISTORY: ProviderRuntimeToolSpec = {
  key: "call_history",
  name: "alta_call_history",
  description:
    "Counts how many times we've called this prospect and surfaces the most recent conversation_id and date. Emits engagement_call_count, engagement_last_conversation_id, engagement_last_call_date, engagement_days_since.",
  phase: "pre_call",
  method: "POST",
  path: "alta://call_history",
  category: "Alta",
  execute: async (ctx) => {
    if (!ctx.prospect_id || !ObjectId.isValid(ctx.prospect_id)) return null;
    const prospectObjectId = new ObjectId(ctx.prospect_id);
    const campaigns = await callCampaignsCol();
    // Aggregate across all campaigns: unwind items, match this prospect with
    // a non-null conversation_id (i.e. the call actually placed), sort by
    // ended_at desc, count + take latest.
    const pipeline = [
      { $match: { "items.prospect_id": prospectObjectId } },
      { $unwind: "$items" },
      {
        $match: {
          "items.prospect_id": prospectObjectId,
          "items.conversation_id": { $ne: null },
        },
      },
      { $sort: { "items.ended_at": -1 } },
      {
        $group: {
          _id: "$items.prospect_id",
          count: { $sum: 1 },
          last_conversation_id: { $first: "$items.conversation_id" },
          last_call_date: { $first: "$items.ended_at" },
        },
      },
    ];
    const agg = await campaigns.aggregate(pipeline).toArray();
    if (agg.length === 0) return null;
    const row = agg[0] as {
      count: number;
      last_conversation_id: string | null;
      last_call_date: Date | null;
    };
    const daysSince = row.last_call_date
      ? Math.floor((Date.now() - row.last_call_date.getTime()) / 86_400_000)
      : null;
    return {
      engagement_call_count: String(row.count),
      engagement_last_conversation_id: row.last_conversation_id ?? "",
      engagement_last_call_date: row.last_call_date
        ? row.last_call_date.toISOString()
        : "",
      engagement_days_since: daysSince !== null ? String(daysSince) : "",
    };
  },
  output_aliases: {
    engagement_call_count: "engagement_call_count",
    engagement_last_conversation_id: "engagement_last_conversation_id",
    engagement_last_call_date: "engagement_last_call_date",
    engagement_days_since: "engagement_days_since",
  },
  narrative: (_ctx, output) => {
    const o = output as Record<string, string> | null;
    if (!o || !o.engagement_call_count) return null;
    const count = Number(o.engagement_call_count);
    if (count === 0) return null;
    const days = o.engagement_days_since;
    return `Called ${count} time${count === 1 ? "" : "s"} previously${days ? `, last ${days} day${days === "1" ? "" : "s"} ago` : ""}.`;
  },
};
