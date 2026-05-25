/**
 * Tool-id filter for the ElevenLabs `tool_ids` patch.
 *
 * Pre-call and post-call tools run server-side from our lifecycle webhooks
 * (see ./dispatch.ts). They're stored in `config_cache.tools` with a
 * synthetic `local_…` id so we can recognise them, but ElevenLabs never
 * sees them — any tool_id starting with `local_` is filtered out before
 * the agent patch goes upstream.
 */
import type { RuntimeTool } from "@/types/agent";

const LOCAL_PREFIX = "local_";

/** True for tools that ElevenLabs has never heard of (lifecycle-only). */
export function isLocalToolId(id: string): boolean {
  return id.startsWith(LOCAL_PREFIX);
}

/** Project a `config_cache.tools` array down to the ids ElevenLabs should see. */
export function externalToolIds(tools: RuntimeTool[]): string[] {
  return tools.filter((t) => !isLocalToolId(t.id)).map((t) => t.id);
}
