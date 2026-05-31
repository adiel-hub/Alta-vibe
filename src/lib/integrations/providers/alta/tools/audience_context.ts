/**
 * Surfaces the audience name + description so the agent knows which list
 * this caller is from. Useful when one agent runs multiple campaigns
 * (cold outreach vs re-engagement vs renewal) and the framing differs.
 */
import { ObjectId } from "mongodb";
import { audiencesCol } from "@/lib/mongodb";
import type { ProviderRuntimeToolSpec } from "../../types";

export const ALTA_AUDIENCE_CONTEXT: ProviderRuntimeToolSpec = {
  key: "audience_context",
  name: "alta_audience_context",
  description:
    "Surfaces the audience the caller belongs to. Exposes meta_audience_name and meta_audience_description. Useful when one agent handles multiple campaigns with different framing.",
  phase: "pre_call",
  method: "POST",
  path: "alta://audience_context",
  category: "Alta",
  execute: async (ctx) => {
    if (!ctx.audience_id || !ObjectId.isValid(ctx.audience_id)) return null;
    const audiences = await audiencesCol();
    const doc = await audiences.findOne({ _id: new ObjectId(ctx.audience_id) });
    if (!doc) return null;
    return {
      meta_audience_name: doc.name ?? "",
      meta_audience_description: doc.description ?? "",
    };
  },
  output_aliases: {
    meta_audience_name: "meta_audience_name",
    meta_audience_description: "meta_audience_description",
  },
};
