import { appFetch } from "@/lib/apiClient";
import { useAgentStore, type WidgetEntry } from "@/store/agentStore";
import { attachToTurn } from "@/store/sseClient";
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
    | { resumed_job_id?: string }
    | null;
  if (json?.resumed_job_id) {
    log.info("agent loop resumed", { job_id: json.resumed_job_id });
    // Detached attach — agent continues its loop with the widget result.
    void attachToTurn(agentId, json.resumed_job_id, 0);
  }
}
