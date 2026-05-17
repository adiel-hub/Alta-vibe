/**
 * Thin aggregator over the capability registry. Capabilities live in
 * `src/lib/capabilities/`; this file simply collects their MCP tools into a
 * single SDK MCP server passed to the Claude Agent SDK at turn start.
 *
 * Adding a feature does NOT touch this file. Edit only when you change the
 * MCP server identity itself.
 */
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { CAPABILITIES, type ToolContext } from "@/lib/capabilities";

export type { ToolContext };

export function createBuilderTools(ctx: ToolContext) {
  return createSdkMcpServer({
    name: "alta",
    version: "0.3.0",
    tools: CAPABILITIES.flatMap((c) => c.tools(ctx)),
  });
}
