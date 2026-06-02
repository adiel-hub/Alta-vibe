/**
 * Phase-0 helper: enable the real-time monitoring feature on an agent.
 *
 * The monitor WebSocket closes with code 1008 ("Monitoring is not enabled for
 * this agent") unless `conversation_config.monitoring_enabled` is true. This
 * flips it via a minimal PATCH (ElevenLabs deep-merges conversation_config, so
 * sibling settings are untouched).
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/enable-monitoring.ts <local_agent_id>
 *   (local_agent_id = the 24-hex Mongo _id; the EL agent id is resolved from it)
 */
import { ObjectId } from "mongodb";
import { agentsCol } from "@/lib/mongodb";
import { elFetch } from "@/lib/elevenlabs/core/fetch";

async function main(): Promise<void> {
  const localId = process.argv[2];
  if (!localId || !ObjectId.isValid(localId)) {
    console.error("✖ Usage: tsx scripts/enable-monitoring.ts <local_agent_id (24-hex)>");
    process.exit(1);
  }

  const agent = await (await agentsCol()).findOne({ _id: new ObjectId(localId) });
  if (!agent) {
    console.error(`✖ no agent with _id ${localId}`);
    process.exit(1);
  }
  const elId = agent.elevenlabs_agent_id as string | undefined;
  if (!elId) {
    console.error("✖ agent has no elevenlabs_agent_id");
    process.exit(1);
  }

  console.log(`→ enabling monitoring on EL agent ${elId} (local ${localId})`);
  await elFetch(`/v1/convai/agents/${elId}`, {
    method: "PATCH",
    section: "update",
    headers: { "content-type": "application/json" },
    // The flag lives under conversation_config.conversation (verified via GET).
    // Widen monitoring_events to include tool events — the default selection
    // omits them, but they're what we need to track tool/transfer nodes.
    body: JSON.stringify({
      conversation_config: {
        conversation: {
          monitoring_enabled: true,
          monitoring_events: [
            "conversation_initiation_metadata",
            "user_transcript",
            "agent_response",
            "agent_response_correction",
            "agent_chat_response_part",
            "client_tool_call",
            "agent_tool_request",
            "agent_tool_response",
            "agent_tool_response_full_payload",
            "interruption",
          ],
        },
      },
    }),
  });
  console.log("✓ monitoring_enabled = true. Start a new web call and re-run monitor-probe.ts.");
  process.exit(0);
}

main().catch((err) => {
  console.error("✖ failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
