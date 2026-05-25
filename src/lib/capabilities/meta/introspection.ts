/**
 * Read-only introspection tools. The full config is already inlined in the
 * system prompt every turn, but these let the agent re-fetch a specific slice
 * from the canonical Mongo document — useful after a tool error, to confirm a
 * value the user is challenging, or when the inline snapshot might be stale
 * relative to a concurrent edit.
 *
 * Also exposes the rolling conversation_summary so the agent can read what
 * older turns covered without us having to inline the (possibly long) summary
 * into every prompt verbatim.
 */
import { ObjectId } from "mongodb";
import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { agentsCol } from "@/lib/mongodb";
import type { AgentConfigCache } from "@/types/agent";
import type { Capability } from "../types";

const SECTIONS = [
  "all",
  "identity",
  "voice",
  "llm",
  "workflow",
  "tools",
  "knowledge_base",
  "mcp",
  "telephony",
  "phone_numbers",
  "data_collection",
  "evaluation_criteria",
] as const;

type Section = (typeof SECTIONS)[number];

function sliceConfig(cfg: AgentConfigCache, section: Section): unknown {
  switch (section) {
    case "all":
      return cfg;
    case "identity":
      return {
        name: cfg.name,
        first_message: cfg.first_message,
        system_prompt: cfg.system_prompt,
        language: cfg.language,
      };
    case "voice":
      return {
        voice_id: cfg.voice_id,
        voice_settings: cfg.voice_settings,
        tts_model: cfg.tts_model,
        language: cfg.language,
      };
    case "llm":
      return {
        llm: cfg.llm,
        temperature: cfg.temperature,
        max_duration_seconds: cfg.max_duration_seconds,
      };
    case "workflow":
      return cfg.workflow;
    case "tools":
      return cfg.tools;
    case "knowledge_base":
      return cfg.knowledge_base;
    case "mcp":
      return cfg.mcp_servers;
    case "telephony":
    case "phone_numbers":
      return cfg.phone_numbers;
    case "data_collection":
      return cfg.data_collection;
    case "evaluation_criteria":
      return cfg.evaluation_criteria;
  }
}

export const introspectionCapability: Capability = {
  id: "introspection",
  label: "Introspection",
  defaultSlice: () => ({}),
  tools: (ctx) => [
    tool(
      "read_agent_config",
      "Re-read the agent's current configuration from the source of truth. " +
        "The full config is already shown in your system prompt — use this when " +
        "you suspect drift, want to confirm a specific value the user is asking " +
        "about, or after a failed tool call. Pass a section to scope the response; " +
        "omit it (or use 'all') to get the entire config_cache.",
      {
        section: z
          .enum(SECTIONS)
          .optional()
          .describe(
            "identity | voice | llm | workflow | tools | knowledge_base | mcp | " +
              "telephony | phone_numbers | integrations | data_collection | " +
              "evaluation_criteria | all (default)",
          ),
      },
      async ({ section }) => {
        const col = await agentsCol();
        const doc = await col.findOne(
          { _id: new ObjectId(ctx.agentMongoId) },
          { projection: { config_cache: 1, revision: 1, name: 1, description: 1 } },
        );
        if (!doc) {
          return {
            content: [{ type: "text", text: "Agent record not found." }],
            isError: true,
          };
        }
        const which: Section = section ?? "all";
        const slice = sliceConfig(doc.config_cache, which);
        const payload =
          which === "all"
            ? {
                revision: doc.revision,
                name: doc.name,
                description: doc.description,
                config: slice,
              }
            : { revision: doc.revision, section: which, value: slice };
        return {
          content: [{ type: "text", text: JSON.stringify(payload) }],
        };
      },
    ),

    tool(
      "read_conversation_summary",
      "Return the rolling summary of conversation turns that have rolled out " +
        "of the live transcript window. Use when the user references something " +
        "decided earlier in a long session that isn't in the last 15 turns. " +
        "Returns null if no summary has been generated yet.",
      {},
      async () => {
        const col = await agentsCol();
        const doc = await col.findOne(
          { _id: new ObjectId(ctx.agentMongoId) },
          {
            projection: {
              conversation_summary: 1,
              summary_through_message_id: 1,
            },
          },
        );
        if (!doc) {
          return {
            content: [{ type: "text", text: "Agent record not found." }],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                summary: doc.conversation_summary ?? null,
                summary_through_message_id:
                  doc.summary_through_message_id?.toHexString() ?? null,
              }),
            },
          ],
        };
      },
    ),
  ],
};
