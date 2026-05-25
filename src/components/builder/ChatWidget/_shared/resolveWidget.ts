import { appFetch } from "@/lib/apiClient";
import { useAgentStore, type WidgetEntry } from "@/store/agentStore";
import { attachToTurn } from "@/store/sseClient";
import type { AgentConfigCache } from "@/types/agent";
import { createClientLogger } from "@/lib/clientLogger";

const log = createClientLogger("widget");

export async function resolveWidget(
  agentId: string,
  widget: WidgetEntry,
  status: "done" | "cancelled" | "failed",
  result?: unknown,
): Promise<void> {
  log.info("resolve", {
    kind: widget.kind,
    action_id: widget.action_id,
    status,
  });
  useAgentStore.getState().resolveWidget(widget.action_id, status, result ?? null);
  const res = await appFetch(
    `/api/agents/${agentId}/widgets/${widget.action_id}/resolve`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status, result }),
    },
  );
  if (!res.ok) {
    log.error("resolve failed", { status: res.status });
    useAgentStore
      .getState()
      .resolveWidget(widget.action_id, "failed", { reason: `Resolve HTTP ${res.status}` });
    throw new Error(`Resolve failed (${res.status})`);
  }
  const json = (await res.json().catch(() => null)) as
    | {
        resumed_job_id?: string;
        config_patch?: { revision: number; patch: Partial<AgentConfigCache> };
      }
    | null;
  // Some side-effect branches (e.g. connect_integration → cascade tool
  // install) mutate config_cache outside the chat turn lifecycle, so the
  // resumed turn's SSE stream won't carry a state_patch for those
  // changes. Apply the inline patch first so the workflow / tools panels
  // refresh immediately, BEFORE the agent's reply starts streaming.
  if (json?.config_patch) {
    useAgentStore
      .getState()
      .applyConfigDirect(json.config_patch.patch, json.config_patch.revision);
  }
  if (json?.resumed_job_id) {
    log.info("agent loop resumed", { job_id: json.resumed_job_id });
    // Detached attach — agent continues its loop with the widget result.
    void attachToTurn(agentId, json.resumed_job_id, 0);
  }
}
