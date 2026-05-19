import { useMemo, useState } from "react";
import { useAgentStore } from "@/store/agentStore";
import { appFetch } from "@/lib/apiClient";
import type { RuntimePhase, RuntimeTool } from "@/types/agent";
import type { FieldsMatcher, ToolsTabMode } from "../types";
import { prettifyCustomName } from "../utils/names";
import { Section } from "../primitives/Section";

// ── Custom Tools (built by the agent via write_tool) ─────────────────────

/**
 * Renders agent-synthesized tools (anything without a `provider` field —
 * i.e. tools built by `write_tool` / `create_custom_runtime_tool`). The
 * data already lives in `config.tools`, so no extra fetch is needed; we
 * just filter by phase + search.
 */
export function CustomToolsSection({
  agentId,
  phase,
  fieldsMatch,
}: {
  agentId: string;
  phase: RuntimePhase;
  fieldsMatch: FieldsMatcher;
  mode?: ToolsTabMode;
  onPick?: (tool: RuntimeTool) => void;
}) {
  const tools = useAgentStore((s) => s.config?.tools);
  const applyConfigDirect = useAgentStore((s) => s.applyConfigDirect);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const customForPhase = useMemo(() => {
    const all = tools ?? [];
    return all.filter(
      (t) =>
        !t.provider &&
        t.phase === phase &&
        fieldsMatch([t.name, t.description, prettifyCustomName(t.name)]),
    );
  }, [tools, phase, fieldsMatch]);

  if (customForPhase.length === 0) return null;

  async function remove(toolId: string) {
    setBusyId(toolId);
    setError(null);
    try {
      const res = await appFetch(
        `/api/agents/${agentId}/provider-tools?id=${encodeURIComponent(toolId)}`,
        { method: "DELETE" },
      );
      const data = (await res.json()) as {
        revision?: number;
        tools?: RuntimeTool[];
        error?: string;
      };
      if (!res.ok || !data.tools) {
        setError(data.error ?? `Remove failed (${res.status})`);
        return;
      }
      applyConfigDirect({ tools: data.tools }, data.revision ?? 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Remove failed");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Section title="Custom tools">
      {error && (
        <div className="mb-2 rounded-md border border-red-400/40 bg-red-500/10 px-3 py-2 text-xs text-red-200">
          {error}
        </div>
      )}
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {customForPhase.map((t) => {
          const isBusy = busyId === t.id;
          return (
            <li
              key={t.id}
              className="flex flex-col gap-2 rounded-xl border border-(--color-border) bg-white p-3"
            >
              <div className="flex items-start justify-between gap-2">
                <h4 className="text-sm font-semibold leading-tight text-(--color-foreground-strong)">
                  {prettifyCustomName(t.name)}
                </h4>
                {t.method && (
                  <span className="shrink-0 rounded bg-(--color-panel-soft) px-1.5 py-0.5 text-[10px] font-medium text-(--color-muted)">
                    {t.method}
                  </span>
                )}
              </div>
              {t.description && (
                <p className="line-clamp-3 text-xs leading-snug text-(--color-muted)">
                  {t.description}
                </p>
              )}
              <button
                type="button"
                disabled={isBusy}
                onClick={() => remove(t.id)}
                className="mt-auto self-start rounded-md border border-(--color-border) bg-(--color-panel-soft) px-2 py-1 text-xs hover:bg-red-500/10 hover:text-red-600 disabled:opacity-50"
              >
                {isBusy ? "Removing…" : "Remove"}
              </button>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
