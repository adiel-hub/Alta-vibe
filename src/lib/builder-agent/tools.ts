/**
 * In-process MCP tools the Claude Agent SDK calls to mutate the voice agent.
 * Every tool reaches the underlying voice provider's REST API directly,
 * emits a state_patch event the right panel consumes, and returns a one-line
 * text result Claude uses to narrate the change.
 *
 * Naming: BUILDER tools (this file) are what Claude calls to configure the
 * voice agent. RUNTIME tools (created via `add_*_runtime_tool` /
 * `create_custom_runtime_tool` here) are what the deployed voice agent calls
 * during a call, tagged with phase = pre_call | in_call | post_call.
 */
import { z } from "zod";
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import {
  assignPhoneNumberToAgent,
  createKbFromText,
  createKbFromUrl,
  createRuntimeTool,
  deleteKbDocument,
  deleteRuntimeTool,
  initiateOutboundCall,
  listConversations,
  getConversationDetail,
  listPhoneNumbers,
  listTtsModels,
  listVoices,
  patchAgent,
  renameKbDocument,
  ElevenLabsError,
} from "@/lib/elevenlabs/client";
import { crawlSite, scrapePage } from "@/lib/firecrawl/client";
import type {
  AgentConfigCache,
  DataCollectionField,
  EvaluationCriterion,
  KnowledgeBaseDocument,
  McpIntegration,
  PhoneNumber,
  RuntimePhase,
  RuntimeTool,
  SSEEvent,
} from "@/types/agent";

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
      ...textResult(`${op} failed (${status}): ${message}`),
      isError: true,
    };
  }
}

export function createBuilderTools(ctx: ToolContext) {
  return createSdkMcpServer({
    name: "alta",
    version: "0.2.0",
    tools: [
      // --- Identity ---------------------------------------------------------
      tool(
        "update_agent_name",
        "Set the agent's display name (short, 2-5 words).",
        { name: z.string().min(1).max(80) },
        async ({ name }) =>
          applyWith(ctx, "name", "rename", async () => {
            await patchAgent(ctx.elevenlabs_agent_id, { name });
            return { patch: { name }, summary: `Renamed agent to "${name}".` };
          }),
      ),

      tool(
        "update_first_message",
        "Set the agent's opening line played when a call connects.",
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
        { system_prompt: z.string().min(20).max(20_000) },
        async ({ system_prompt }) =>
          applyWith(ctx, "system_prompt", "system_prompt", async () => {
            await patchAgent(ctx.elevenlabs_agent_id, { system_prompt });
            return {
              patch: { system_prompt },
              summary: "Updated system prompt.",
            };
          }),
      ),

      // --- Voice ------------------------------------------------------------
      tool(
        "list_available_voices",
        "Return the catalog of available voices. Call this before update_voice so you pick a real voice_id; never invent one.",
        {},
        async () => {
          try {
            const voices = await listVoices();
            const trimmed = voices.slice(0, 80).map((v) => ({
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
            return { patch: { voice_id }, summary: "Voice updated." };
          }),
      ),

      tool(
        "update_voice_settings",
        "Tune voice expression: stability (0-1 robotic↔dramatic), similarity_boost (0-1), style (0-1 v3 expressiveness), use_speaker_boost (bool), speed (0.7-1.2). Pass only fields you want to change.",
        {
          stability: z.number().min(0).max(1).optional(),
          similarity_boost: z.number().min(0).max(1).optional(),
          style: z.number().min(0).max(1).optional(),
          use_speaker_boost: z.boolean().optional(),
          speed: z.number().min(0.5).max(2).optional(),
        },
        async (input) =>
          applyWith(ctx, "voice", "voice_settings", async () => {
            await patchAgent(ctx.elevenlabs_agent_id, { voice_settings: input });
            const partial = Object.fromEntries(
              Object.entries(input).filter(([, v]) => v !== undefined),
            );
            const next = { ...ctx.config.voice_settings, ...partial };
            return {
              patch: { voice_settings: next },
              summary: "Voice settings updated.",
            };
          }),
      ),

      tool(
        "list_tts_models",
        "List available TTS models (including the multilingual v3 model). Call before update_tts_model.",
        {},
        async () => {
          try {
            const models = await listTtsModels();
            return textResult(
              JSON.stringify(
                models.map((m) => ({
                  model_id: m.model_id,
                  name: m.name,
                  languages: (m.languages ?? []).slice(0, 30),
                })),
              ),
            );
          } catch (err) {
            const message = err instanceof Error ? err.message : "Unknown error";
            return { ...textResult(`list_tts_models failed: ${message}`), isError: true };
          }
        },
      ),

      tool(
        "update_tts_model",
        "Select the TTS model. Use one of: eleven_v3, eleven_multilingual_v2, eleven_turbo_v2_5, eleven_flash_v2_5. Use eleven_v3 for the most expressive output.",
        { tts_model: z.string().min(1) },
        async ({ tts_model }) =>
          applyWith(ctx, "voice", "tts_model", async () => {
            await patchAgent(ctx.elevenlabs_agent_id, { tts_model });
            return { patch: { tts_model }, summary: `TTS model set to ${tts_model}.` };
          }),
      ),

      tool(
        "update_language",
        "Set the conversation language using an ISO code (e.g. 'en', 'es', 'fr', 'de'). For multilingual support, also set tts_model to eleven_multilingual_v2 or eleven_v3.",
        { language: z.string().min(2).max(8) },
        async ({ language }) =>
          applyWith(ctx, "voice", "language", async () => {
            await patchAgent(ctx.elevenlabs_agent_id, { language });
            return { patch: { language }, summary: `Language set to ${language}.` };
          }),
      ),

      // --- LLM --------------------------------------------------------------
      tool(
        "update_llm_settings",
        "Set the LLM model (e.g. 'gemini-2.0-flash', 'gpt-4o-mini', 'claude-sonnet-4-6') and/or temperature (0-1).",
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
        "update_max_call_duration",
        "Set the maximum duration (seconds) for any single call before the agent hangs up. Common values: 300-1800.",
        { max_duration_seconds: z.number().int().min(30).max(7200) },
        async ({ max_duration_seconds }) =>
          applyWith(ctx, "limits", "max_duration", async () => {
            await patchAgent(ctx.elevenlabs_agent_id, { max_duration_seconds });
            return {
              patch: { max_duration_seconds },
              summary: `Max call duration set to ${max_duration_seconds}s.`,
            };
          }),
      ),

      // --- Knowledge base ---------------------------------------------------
      tool(
        "add_knowledge_base_url",
        "Index a single URL into the agent's knowledge base for RAG.",
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
        "add_knowledge_base_text",
        "Add an arbitrary text snippet to the knowledge base.",
        {
          name: z.string().min(1),
          text: z.string().min(10),
        },
        async ({ name, text }) =>
          applyWith(ctx, "knowledge_base", "kb_add_text", async () => {
            const doc = await createKbFromText({ name, text });
            const entry: KnowledgeBaseDocument = {
              id: doc.id,
              name: doc.name,
              type: "text",
              source: "text",
            };
            const next = [...ctx.config.knowledge_base, entry];
            await patchAgent(ctx.elevenlabs_agent_id, {
              knowledge_base: next.map((d) => ({ id: d.id, name: d.name, type: d.type })),
            });
            return {
              patch: { knowledge_base: next },
              summary: `Added text snippet "${name}".`,
            };
          }),
      ),

      tool(
        "scrape_website_to_knowledge_base",
        "Use the web scraper to crawl up to N pages from a starting URL and add each page as a separate knowledge base document. Use this when the user pastes a site URL or asks to index a docs/help section.",
        {
          start_url: z.string().url(),
          limit: z.number().int().min(1).max(25).default(8),
        },
        async ({ start_url, limit }) =>
          applyWith(ctx, "knowledge_base", "kb_scrape", async () => {
            const pages = await crawlSite({ startUrl: start_url, limit });
            const created: KnowledgeBaseDocument[] = [];
            for (const page of pages) {
              if (!page.markdown || page.markdown.length < 50) continue;
              const name = page.title || page.url;
              const doc = await createKbFromText({
                name: name.slice(0, 120),
                text: `Source: ${page.url}\n\n${page.markdown}`,
              });
              created.push({
                id: doc.id,
                name: doc.name,
                type: "text",
                source: page.url,
              });
              // Emit a per-page patch so the right panel shows pages as they land.
              const incremental = [...ctx.config.knowledge_base, ...created];
              ctx.emit({
                type: "state_patch",
                revision: ctx.bumpRevision(),
                patch: { knowledge_base: incremental },
              });
              Object.assign(ctx.config, { knowledge_base: incremental });
            }
            const next = ctx.config.knowledge_base;
            await patchAgent(ctx.elevenlabs_agent_id, {
              knowledge_base: next.map((d) => ({ id: d.id, name: d.name, type: d.type })),
            });
            return {
              patch: { knowledge_base: next },
              summary: `Scraped ${created.length} page${created.length === 1 ? "" : "s"} into the knowledge base.`,
            };
          }),
      ),

      tool(
        "scrape_single_page_to_knowledge_base",
        "Scrape exactly one page and add it as a knowledge base document.",
        { url: z.string().url() },
        async ({ url }) =>
          applyWith(ctx, "knowledge_base", "kb_scrape_one", async () => {
            const page = await scrapePage(url);
            if (!page.markdown) throw new Error("Empty scrape");
            const doc = await createKbFromText({
              name: (page.title || page.url).slice(0, 120),
              text: `Source: ${page.url}\n\n${page.markdown}`,
            });
            const entry: KnowledgeBaseDocument = {
              id: doc.id,
              name: doc.name,
              type: "text",
              source: page.url,
            };
            const next = [...ctx.config.knowledge_base, entry];
            await patchAgent(ctx.elevenlabs_agent_id, {
              knowledge_base: next.map((d) => ({ id: d.id, name: d.name, type: d.type })),
            });
            return {
              patch: { knowledge_base: next },
              summary: `Scraped "${doc.name}".`,
            };
          }),
      ),

      tool(
        "remove_knowledge_base_document",
        "Detach a document from the agent and delete it from the workspace.",
        { document_id: z.string().min(1) },
        async ({ document_id }) =>
          applyWith(ctx, "knowledge_base", "kb_remove", async () => {
            const next = ctx.config.knowledge_base.filter((d) => d.id !== document_id);
            await patchAgent(ctx.elevenlabs_agent_id, {
              knowledge_base: next.map((d) => ({ id: d.id, name: d.name, type: d.type })),
            });
            await deleteKbDocument(document_id).catch(() => {});
            return {
              patch: { knowledge_base: next },
              summary: "Knowledge base document removed.",
            };
          }),
      ),

      tool(
        "rename_knowledge_base_document",
        "Rename a knowledge base document.",
        { document_id: z.string().min(1), name: z.string().min(1).max(120) },
        async ({ document_id, name }) =>
          applyWith(ctx, "knowledge_base", "kb_rename", async () => {
            await renameKbDocument(document_id, name);
            const next = ctx.config.knowledge_base.map((d) =>
              d.id === document_id ? { ...d, name } : d,
            );
            return {
              patch: { knowledge_base: next },
              summary: `Renamed document to "${name}".`,
            };
          }),
      ),

      // --- Runtime tools (what the agent calls during a call) ---------------
      tool(
        "create_custom_runtime_tool",
        "Create ANY runtime tool the deployed agent can call during a conversation. Use this when the user wants a tool not covered by the built-in helpers. Specify phase: 'pre_call' (runs before greeting), 'in_call' (during conversation), 'post_call' (after hangup). For webhook tools, provide api_schema with url, method, and parameter shapes.",
        {
          name: z.string().min(1).max(64),
          description: z.string().min(1).max(500),
          phase: z.enum(["pre_call", "in_call", "post_call"]),
          type: z.enum(["webhook", "client", "system"]).default("webhook"),
          api_schema: z
            .object({
              url: z.string().url(),
              method: z.enum(["GET", "POST", "PUT", "DELETE"]),
              request_headers: z.record(z.string(), z.string()).optional(),
              request_body_schema: z.unknown().optional(),
              query_params_schema: z.unknown().optional(),
            })
            .optional(),
        },
        async ({ name, description, phase, type, api_schema }) =>
          applyWith(ctx, "tools", "tool_create", async () => {
            const phaseScopedName = phase === "in_call" ? name : `${phase}__${name}`;
            const created = await createRuntimeTool({
              name: phaseScopedName,
              description,
              type,
              phase: phase as RuntimePhase,
              api_schema,
            });
            const entry: RuntimeTool = {
              id: created.id,
              name: phaseScopedName,
              type,
              description,
              phase: phase as RuntimePhase,
              method: api_schema?.method,
              url: api_schema?.url,
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
              summary: `Created ${phase} tool "${name}".`,
            };
          }),
      ),

      tool(
        "remove_runtime_tool",
        "Remove a runtime tool from the agent by id.",
        { tool_id: z.string().min(1) },
        async ({ tool_id }) =>
          applyWith(ctx, "tools", "tool_remove", async () => {
            const next = ctx.config.tools.filter((t) => t.id !== tool_id);
            await patchAgent(ctx.elevenlabs_agent_id, {
              tools: next.map((t) => ({
                id: t.id,
                name: t.name,
                type: t.type,
                description: t.description,
              })),
            });
            await deleteRuntimeTool(tool_id).catch(() => {});
            return {
              patch: { tools: next },
              summary: `Removed runtime tool ${tool_id}.`,
            };
          }),
      ),

      // --- MCP integrations -------------------------------------------------
      tool(
        "add_mcp_integration",
        "Attach an MCP server so the deployed agent can use its tools at runtime.",
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

      // --- Data collection / evaluation (post-call analysis) ---------------
      tool(
        "add_data_collection_field",
        "Define a structured field the agent should extract from the conversation (e.g. 'order_number', 'callback_time'). Surfaced in call logs.",
        {
          name: z.string().min(1).max(64),
          type: z.enum(["string", "number", "boolean"]),
          description: z.string().min(1).max(500),
        },
        async ({ name, type, description }) =>
          applyWith(ctx, "data", "data_add", async () => {
            const entry: DataCollectionField = {
              id: name,
              name,
              type,
              description,
            };
            const next = [...ctx.config.data_collection, entry];
            await patchAgent(ctx.elevenlabs_agent_id, {
              data_collection: Object.fromEntries(
                next.map((d) => [d.name, { type: d.type, description: d.description }]),
              ),
            });
            return {
              patch: { data_collection: next },
              summary: `Added data field "${name}".`,
            };
          }),
      ),

      tool(
        "remove_data_collection_field",
        "Remove a data collection field by name.",
        { name: z.string().min(1) },
        async ({ name }) =>
          applyWith(ctx, "data", "data_remove", async () => {
            const next = ctx.config.data_collection.filter((d) => d.name !== name);
            await patchAgent(ctx.elevenlabs_agent_id, {
              data_collection: Object.fromEntries(
                next.map((d) => [d.name, { type: d.type, description: d.description }]),
              ),
            });
            return {
              patch: { data_collection: next },
              summary: `Removed data field "${name}".`,
            };
          }),
      ),

      tool(
        "add_evaluation_criterion",
        "Define a yes/no quality criterion the platform should score after each call (e.g. 'agent verified caller identity').",
        {
          name: z.string().min(1).max(64),
          prompt: z.string().min(10).max(800),
        },
        async ({ name, prompt }) =>
          applyWith(ctx, "evaluation", "eval_add", async () => {
            const entry: EvaluationCriterion = {
              id: name,
              name,
              prompt,
            };
            const next = [...ctx.config.evaluation_criteria, entry];
            await patchAgent(ctx.elevenlabs_agent_id, {
              evaluation_criteria: next,
            });
            return {
              patch: { evaluation_criteria: next },
              summary: `Added evaluation criterion "${name}".`,
            };
          }),
      ),

      tool(
        "remove_evaluation_criterion",
        "Remove an evaluation criterion by name.",
        { name: z.string().min(1) },
        async ({ name }) =>
          applyWith(ctx, "evaluation", "eval_remove", async () => {
            const next = ctx.config.evaluation_criteria.filter((c) => c.name !== name);
            await patchAgent(ctx.elevenlabs_agent_id, {
              evaluation_criteria: next,
            });
            return {
              patch: { evaluation_criteria: next },
              summary: `Removed evaluation criterion "${name}".`,
            };
          }),
      ),

      // --- Phone numbers + outbound -----------------------------------------
      tool(
        "list_phone_numbers",
        "List phone numbers available in the workspace (across providers).",
        {},
        async () => {
          try {
            const nums = await listPhoneNumbers();
            return textResult(JSON.stringify(nums));
          } catch (err) {
            const message = err instanceof Error ? err.message : "Unknown error";
            return { ...textResult(`list_phone_numbers failed: ${message}`), isError: true };
          }
        },
      ),

      tool(
        "assign_phone_number_to_agent",
        "Attach a workspace phone number to THIS agent so inbound calls reach it.",
        { phone_number_id: z.string().min(1) },
        async ({ phone_number_id }) =>
          applyWith(ctx, "phone", "phone_assign", async () => {
            await assignPhoneNumberToAgent(phone_number_id, ctx.elevenlabs_agent_id);
            const existing = ctx.config.phone_numbers.find((p) => p.id === phone_number_id);
            const numbers: PhoneNumber[] = existing
              ? ctx.config.phone_numbers
              : [
                  ...ctx.config.phone_numbers,
                  { id: phone_number_id, number: "(assigned)", provider: "unknown" },
                ];
            return {
              patch: { phone_numbers: numbers },
              summary: "Phone number attached to agent.",
            };
          }),
      ),

      tool(
        "place_outbound_test_call",
        "Place an outbound test call from the agent to a number (e.g. the user's mobile). Requires a phone number attached to the agent.",
        {
          to_number: z.string().regex(/^\+?[0-9 \-()]{6,20}$/),
          agent_phone_number_id: z.string().min(1),
        },
        async ({ to_number, agent_phone_number_id }) => {
          try {
            const { conversation_id } = await initiateOutboundCall({
              agentId: ctx.elevenlabs_agent_id,
              agentPhoneNumberId: agent_phone_number_id,
              toNumber: to_number,
            });
            return textResult(
              `Outbound call initiated to ${to_number}. Conversation id: ${conversation_id}.`,
            );
          } catch (err) {
            const message = err instanceof Error ? err.message : "Unknown error";
            ctx.emit({ type: "state_error", section: "phone", message });
            return { ...textResult(`outbound_call failed: ${message}`), isError: true };
          }
        },
      ),

      // --- Call logs (read-only) -------------------------------------------
      tool(
        "list_recent_calls",
        "Return summary of the most recent calls (status, duration, outcome). Useful for the user to review what happened.",
        { limit: z.number().int().min(1).max(50).default(10) },
        async ({ limit }) => {
          try {
            const logs = await listConversations(ctx.elevenlabs_agent_id, limit);
            return textResult(JSON.stringify(logs));
          } catch (err) {
            const message = err instanceof Error ? err.message : "Unknown error";
            return { ...textResult(`list_recent_calls failed: ${message}`), isError: true };
          }
        },
      ),

      tool(
        "get_call_details",
        "Return the full transcript, recording URL, evaluation results, and data collection results for a specific conversation id.",
        { conversation_id: z.string().min(1) },
        async ({ conversation_id }) => {
          try {
            const detail = await getConversationDetail(conversation_id);
            return textResult(JSON.stringify(detail));
          } catch (err) {
            const message = err instanceof Error ? err.message : "Unknown error";
            return { ...textResult(`get_call_details failed: ${message}`), isError: true };
          }
        },
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
  "update_voice_settings",
  "list_tts_models",
  "update_tts_model",
  "update_language",
  "update_llm_settings",
  "update_max_call_duration",
  "add_knowledge_base_url",
  "add_knowledge_base_text",
  "scrape_website_to_knowledge_base",
  "scrape_single_page_to_knowledge_base",
  "remove_knowledge_base_document",
  "rename_knowledge_base_document",
  "create_custom_runtime_tool",
  "remove_runtime_tool",
  "add_mcp_integration",
  "remove_mcp_integration",
  "add_data_collection_field",
  "remove_data_collection_field",
  "add_evaluation_criterion",
  "remove_evaluation_criterion",
  "list_phone_numbers",
  "assign_phone_number_to_agent",
  "place_outbound_test_call",
  "list_recent_calls",
  "get_call_details",
] as const;
