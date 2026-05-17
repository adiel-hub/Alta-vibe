/**
 * In-process MCP tools the Claude Agent SDK calls to mutate the ElevenLabs
 * agent. Each tool calls the ElevenLabs REST API, emits a state_patch event
 * via the injected `emit` channel, then returns a short text result the
 * model uses to narrate the change.
 *
 * Naming: builder tools (here) ≠ runtime tools (what the ElevenLabs agent
 * itself calls during a voice call). The `add_runtime_webhook_tool` builder
 * tool below CREATES a runtime tool on the agent.
 */
import { z } from "zod";
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import {
  patchAgent,
  listVoices,
  createKbFromUrl,
  deleteKbDocument,
  ElevenLabsError,
} from "@/lib/elevenlabs/client";
import type {
  AgentConfigCache,
  SSEEvent,
  KnowledgeBaseDocument,
  RuntimeTool,
  McpIntegration,
} from "@/types/agent";

export type { SSEEvent };

export type ToolContext = {
  elevenlabs_agent_id: string;
  /** Current config snapshot, mutated in place as tools succeed. */
  config: AgentConfigCache;
  emit: (event: SSEEvent) => void;
  bumpRevision: () => number;
};

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

async function applyWith(
  ctx: ToolContext,
  section: string,
  op: string,
  fn: () => Promise<{ patch: Partial<AgentConfigCache>; summary: string }>,
) {
  try {
    const { patch, summary } = await fn();
    Object.assign(ctx.config, patch);
    const revision = ctx.bumpRevision();
    ctx.emit({ type: "state_patch", revision, patch });
    return textResult(summary);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const status = err instanceof ElevenLabsError ? err.status : 0;
    ctx.emit({ type: "state_error", section, message });
    return {
      ...textResult(`ElevenLabs ${op} failed (${status}): ${message}`),
      isError: true,
    };
  }
}

export function createBuilderTools(ctx: ToolContext) {
  return createSdkMcpServer({
    name: "alta",
    version: "0.1.0",
    tools: [
      tool(
        "update_agent_name",
        "Set the agent's display name (short, 2-4 words).",
        { name: z.string().min(1).max(80) },
        async ({ name }) =>
          applyWith(ctx, "name", "rename", async () => {
            await patchAgent(ctx.elevenlabs_agent_id, { name });
            return { patch: { name }, summary: `Renamed agent to "${name}".` };
          }),
      ),

      tool(
        "update_first_message",
        "Set the agent's opening line spoken when a call connects.",
        { first_message: z.string().min(1).max(500) },
        async ({ first_message }) =>
          applyWith(ctx, "first_message", "first_message", async () => {
            await patchAgent(ctx.elevenlabs_agent_id, { first_message });
            return {
              patch: { first_message },
              summary: "Updated first message.",
            };
          }),
      ),

      tool(
        "update_system_prompt",
        "Replace the agent's full system prompt. Provide the entire new prompt; this is not a diff.",
        { system_prompt: z.string().min(20).max(8000) },
        async ({ system_prompt }) =>
          applyWith(ctx, "system_prompt", "system_prompt", async () => {
            await patchAgent(ctx.elevenlabs_agent_id, { system_prompt });
            return {
              patch: { system_prompt },
              summary: "Updated system prompt.",
            };
          }),
      ),

      tool(
        "list_available_voices",
        "Return the ElevenLabs voice catalog. Call this before update_voice so you can pick a concrete voice_id.",
        {},
        async () => {
          try {
            const voices = await listVoices();
            const trimmed = voices.slice(0, 60).map((v) => ({
              voice_id: v.voice_id,
              name: v.name,
              category: v.category,
              labels: v.labels,
            }));
            return textResult(JSON.stringify(trimmed));
          } catch (err) {
            const message = err instanceof Error ? err.message : "Unknown error";
            return { ...textResult(`list_voices failed: ${message}`), isError: true };
          }
        },
      ),

      tool(
        "update_voice",
        "Set the agent's voice. Use a voice_id returned by list_available_voices.",
        { voice_id: z.string().min(1) },
        async ({ voice_id }) =>
          applyWith(ctx, "voice", "voice", async () => {
            await patchAgent(ctx.elevenlabs_agent_id, { voice_id });
            return {
              patch: { voice_id },
              summary: `Voice updated.`,
            };
          }),
      ),

      tool(
        "update_llm_settings",
        "Change the LLM model and/or temperature the agent uses.",
        {
          llm: z.string().optional(),
          temperature: z.number().min(0).max(1).optional(),
        },
        async ({ llm, temperature }) =>
          applyWith(ctx, "llm", "llm", async () => {
            await patchAgent(ctx.elevenlabs_agent_id, { llm, temperature });
            const patch: Partial<AgentConfigCache> = {};
            if (llm !== undefined) patch.llm = llm;
            if (temperature !== undefined) patch.temperature = temperature;
            return { patch, summary: "LLM settings updated." };
          }),
      ),

      tool(
        "add_knowledge_base_url",
        "Index a URL into the agent's knowledge base (RAG).",
        {
          url: z.string().url(),
          name: z.string().optional(),
        },
        async ({ url, name }) =>
          applyWith(ctx, "knowledge_base", "kb_add_url", async () => {
            const doc = await createKbFromUrl({ url, name });
            const entry: KnowledgeBaseDocument = {
              id: doc.id,
              name: doc.name,
              type: "url",
              source: url,
            };
            const next = [...ctx.config.knowledge_base, entry];
            await patchAgent(ctx.elevenlabs_agent_id, {
              knowledge_base: next.map((d) => ({ id: d.id, name: d.name, type: d.type })),
            });
            return {
              patch: { knowledge_base: next },
              summary: `Added "${doc.name}" to the knowledge base.`,
            };
          }),
      ),

      tool(
        "remove_knowledge_base_document",
        "Detach a document from the agent and delete it from the workspace knowledge base.",
        { document_id: z.string().min(1) },
        async ({ document_id }) =>
          applyWith(ctx, "knowledge_base", "kb_remove", async () => {
            const next = ctx.config.knowledge_base.filter((d) => d.id !== document_id);
            await patchAgent(ctx.elevenlabs_agent_id, {
              knowledge_base: next.map((d) => ({ id: d.id, name: d.name, type: d.type })),
            });
            await deleteKbDocument(document_id).catch(() => {
              // tolerate if the doc is already gone in EL
            });
            return {
              patch: { knowledge_base: next },
              summary: "Knowledge base document removed.",
            };
          }),
      ),

      tool(
        "add_runtime_webhook_tool",
        "Add a webhook tool the AGENT itself can call during a voice call (not a builder tool).",
        {
          name: z.string().min(1),
          description: z.string().min(1),
          url: z.string().url(),
          method: z.enum(["GET", "POST", "PUT", "DELETE"]),
        },
        async ({ name, description }) =>
          applyWith(ctx, "tools", "tools_add", async () => {
            const entry: RuntimeTool = {
              id: name,
              name,
              type: "webhook",
              description,
            };
            const next = [...ctx.config.tools, entry];
            await patchAgent(ctx.elevenlabs_agent_id, {
              tools: next.map((t) => ({
                id: t.id,
                name: t.name,
                type: t.type,
                description: t.description,
              })),
            });
            return {
              patch: { tools: next },
              summary: `Added runtime tool "${name}".`,
            };
          }),
      ),

      tool(
        "remove_runtime_tool",
        "Remove a runtime tool from the agent by id.",
        { tool_id: z.string().min(1) },
        async ({ tool_id }) =>
          applyWith(ctx, "tools", "tools_remove", async () => {
            const next = ctx.config.tools.filter((t) => t.id !== tool_id);
            await patchAgent(ctx.elevenlabs_agent_id, {
              tools: next.map((t) => ({
                id: t.id,
                name: t.name,
                type: t.type,
                description: t.description,
              })),
            });
            return {
              patch: { tools: next },
              summary: `Removed runtime tool ${tool_id}.`,
            };
          }),
      ),

      tool(
        "add_mcp_integration",
        "Attach an MCP server to the agent so it can use that server's tools at runtime.",
        {
          server_id: z.string().min(1),
          name: z.string().optional(),
          url: z.string().url().optional(),
        },
        async ({ server_id, name, url }) =>
          applyWith(ctx, "mcp", "mcp_add", async () => {
            const entry: McpIntegration = {
              id: server_id,
              name: name ?? server_id,
              url: url ?? "",
            };
            const next = [...ctx.config.mcp_servers, entry];
            await patchAgent(ctx.elevenlabs_agent_id, {
              mcp_server_ids: next.map((m) => m.id),
            });
            return {
              patch: { mcp_servers: next },
              summary: `Connected MCP server "${entry.name}".`,
            };
          }),
      ),

      tool(
        "remove_mcp_integration",
        "Detach an MCP server from the agent.",
        { server_id: z.string().min(1) },
        async ({ server_id }) =>
          applyWith(ctx, "mcp", "mcp_remove", async () => {
            const next = ctx.config.mcp_servers.filter((m) => m.id !== server_id);
            await patchAgent(ctx.elevenlabs_agent_id, {
              mcp_server_ids: next.map((m) => m.id),
            });
            return {
              patch: { mcp_servers: next },
              summary: `Disconnected MCP server ${server_id}.`,
            };
          }),
      ),
    ],
  });
}

export const BUILDER_TOOL_NAMES = [
  "update_agent_name",
  "update_first_message",
  "update_system_prompt",
  "list_available_voices",
  "update_voice",
  "update_llm_settings",
  "add_knowledge_base_url",
  "remove_knowledge_base_document",
  "add_runtime_webhook_tool",
  "remove_runtime_tool",
  "add_mcp_integration",
  "remove_mcp_integration",
] as const;
