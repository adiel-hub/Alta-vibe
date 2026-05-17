/**
 * Workflow tracking — registers a `report_workflow_state` CLIENT runtime
 * tool on the deployed agent. The browser-side test-call hook listens for
 * invocations of this client tool and highlights the matching workflow node
 * in real time, so the user can watch the conversation traverse the graph.
 *
 * Builder tool: `enable_workflow_state_tracking()`. Idempotent.
 */
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { createRuntimeTool, patchAgent } from "@/lib/elevenlabs/client";
import type { RuntimeTool } from "@/types/agent";
import type { Capability } from "./types";
import { runToolStep } from "./types";

export const TRACKING_TOOL_NAME = "report_workflow_state";

export const workflowTrackingCapability: Capability = {
  id: "workflow_tracking",
  label: "Workflow tracking",
  defaultSlice: () => ({}),
  tools: (ctx) => [
    tool(
      "enable_workflow_state_tracking",
      "Idempotently register the report_workflow_state client tool on the deployed agent so test calls can visualise which workflow node the conversation is in. Call this once after you've built a workflow.",
      {},
      async () =>
        runToolStep(ctx, "workflow", "enable_workflow_tracking", async () => {
          const existing = ctx.config.tools.find((t) => t.name === TRACKING_TOOL_NAME);
          if (existing) {
            return {
              patch: {},
              summary: "Workflow state tracking already enabled.",
            };
          }
          const created = await createRuntimeTool({
            name: TRACKING_TOOL_NAME,
            description:
              "Report the current workflow node the conversation is in. Call this immediately upon entering each node. Argument: node_id (string).",
            type: "client",
            phase: "in_call",
          });
          const entry: RuntimeTool = {
            id: created.id,
            name: TRACKING_TOOL_NAME,
            type: "client",
            description: "Workflow node tracker.",
            phase: "in_call",
          };
          const next = [...ctx.config.tools, entry];
          await patchAgent(ctx.elevenlabs_agent_id, {
            tool_ids: next.map((t) => t.id),
          });
          return {
            patch: { tools: next },
            summary: "Workflow state tracking enabled for test calls.",
          };
        }),
    ),
  ],
};
