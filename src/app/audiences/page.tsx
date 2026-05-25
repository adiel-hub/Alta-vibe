import { redirect } from "next/navigation";
import { ObjectId } from "mongodb";
import {
  audienceChatSessionsCol,
} from "@/lib/mongodb";
import { getOrCreateAudienceBuilderAgent } from "@/lib/audiences/builderAgent";

export const dynamic = "force-dynamic";

/**
 * Bare /audiences route. The Audiences nav item should feel like "drop me
 * back into my last audience-builder chat". If the workspace already has
 * sessions, resume the most-recent one; otherwise show the hero so a new
 * chat can start.
 */
export default async function AudiencesIndex(): Promise<never> {
  try {
    const agent = await getOrCreateAudienceBuilderAgent();
    const newest = await (await audienceChatSessionsCol())
      .find(
        { agent_id: agent._id } as Record<string, ObjectId>,
        { projection: { _id: 1 } },
      )
      .sort({ last_message_at: -1 })
      .limit(1)
      .next();
    if (newest) redirect(`/audiences/build/${newest._id.toHexString()}`);
  } catch {
    // Mongo unreachable — fall through to the hero so the page still renders.
  }
  redirect("/audiences/build");
}
