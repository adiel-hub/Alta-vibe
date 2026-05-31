/**
 * Unified view of every tool the workflow has bound for the current phase.
 *
 * The Tools tab used to split tools into "Custom" vs "Integrations" — that
 * split was confusing (the orphan bug hit because tools missing a
 * `provider` field landed under Custom even when they were really
 * provider tools), and it didn't surface the relationship between tools
 * and the workflow nodes that reference them.
 *
 * Now: every bound tool shows here with provenance + workflow refs.
 * Removing here funnels through the bindings module so the workflow
 * stays in sync.
 */
import { useMemo, useState } from "react";
import { useAgentStore } from "@/store/agentStore";
import { appFetch } from "@/lib/apiClient";
import type {
  RuntimePhase,
  RuntimeTool,
  WorkflowNode,
} from "@/types/agent";
import type { CatalogProvider, FieldsMatcher, ToolsTabMode } from "../types";
import { friendlyToolName, prettifyCustomName } from "../utils/names";
import { Section } from "../primitives/Section";
import { ProviderIcon } from "../primitives/ProviderIcon";

type EnrichedTool = {
  tool: RuntimeTool;
  provider: CatalogProvider | undefined;
  workflowNodes: WorkflowNode[];
};

export function ToolboxSection({
  agentId,
  phase,
  fieldsMatch,
  catalog,
  mode = "manage",
  onPick,
}: {
  agentId: string;
  phase: RuntimePhase;
  fieldsMatch: FieldsMatcher;
  catalog: CatalogProvider[] | null;
  mode?: ToolsTabMode;
  onPick?: (tool: RuntimeTool) => void;
}) {
  const tools = useAgentStore((s) => s.config?.tools);
  const workflow = useAgentStore((s) => s.config?.workflow);
  const applyConfigDirect = useAgentStore((s) => s.applyConfigDirect);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const enriched = useMemo<EnrichedTool[]>(() => {
    const all = tools ?? [];
    const providers = catalog ?? [];
    const nodes = workflow?.nodes ?? [];
    return all
      .filter((t) => t.phase === phase)
      .map((tool) => ({
        tool,
        provider: tool.provider
          ? providers.find((p) => p.id === tool.provider)
          : undefined,
        workflowNodes: nodes.filter(
          (n) =>
            n.type === "tool_call" &&
            (n.data?.tool_id === tool.id || n.data?.tool_name === tool.name),
        ),
      }))
      .filter(({ tool, provider, workflowNodes }) =>
        fieldsMatch([
          tool.name,
          tool.description,
          prettifyCustomName(tool.name),
          provider?.name,
          ...workflowNodes.map((n) => n.label),
        ]),
      );
  }, [tools, workflow, catalog, phase, fieldsMatch]);

  if (enriched.length === 0) return null;

  async function remove(tool: RuntimeTool) {
    setBusyId(tool.id);
    setError(null);
    try {
      const res = await appFetch(
        `/api/agents/${agentId}/provider-tools?id=${encodeURIComponent(tool.id)}&name=${encodeURIComponent(tool.name)}`,
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
      // Refetch the agent so the workflow side of the store (where
      // bindings live) updates too — `provider-tools` returns only
      // `tools`, and a node that referenced the removed tool's id
      // would otherwise be left dangling in the local store.
      const agentRes = await appFetch(`/api/agents/${agentId}`);
      if (agentRes.ok) {
        const fresh = await agentRes.json();
        applyConfigDirect(
          {
            tools: fresh.config_cache.tools,
            workflow: fresh.config_cache.workflow,
          },
          fresh.revision,
        );
      } else {
        applyConfigDirect({ tools: data.tools }, data.revision ?? 0);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Remove failed");
    } finally {
      setBusyId(null);
    }
  }

  const sectionTitle =
    phase === "in_call"
      ? "Attached tools"
      : phase === "pre_call"
        ? "Pre-call tools"
        : "Post-call tools";

  return (
    <Section title={sectionTitle}>
      {error && (
        <div className="mb-2 rounded-md border border-red-400/40 bg-red-500/10 px-3 py-2 text-xs text-red-200">
          {error}
        </div>
      )}
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {enriched.map(({ tool, provider, workflowNodes }) => {
          const isBusy = busyId === tool.id;
          const displayName = provider
            ? friendlyToolName(tool.name, provider.id, phase)
            : prettifyCustomName(tool.name);
          const isPick = mode === "pick";
          return (
            <li
              key={tool.id}
              className="flex flex-col gap-2 rounded-xl border border-(--color-border) bg-white p-3"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    {provider && (
                      <ProviderIcon icon={provider.icon} name={provider.name} />
                    )}
                    <h4 className="truncate text-sm font-semibold leading-tight text-(--color-foreground-strong)">
                      {displayName}
                    </h4>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1">
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                        provider
                          ? "bg-(--color-accent)/10 text-(--color-accent)"
                          : "bg-(--color-panel-soft) text-(--color-muted)"
                      }`}
                    >
                      {provider ? provider.name : "Custom"}
                    </span>
                    {tool.method && (
                      <span className="rounded bg-(--color-panel-soft) px-1.5 py-0.5 text-[10px] font-medium text-(--color-muted)">
                        {tool.method}
                      </span>
                    )}
                  </div>
                </div>
              </div>
              {tool.description && (
                <p className="line-clamp-3 text-xs leading-snug text-(--color-muted)">
                  {tool.description}
                </p>
              )}
              {workflowNodes.length > 0 && (
                <div className="rounded-md border border-(--color-accent)/30 bg-(--color-accent)/5 px-2 py-1.5">
                  <div className="text-[10px] font-medium uppercase tracking-wider text-(--color-accent)">
                    Wired in workflow
                  </div>
                  <ul className="mt-0.5 space-y-0.5">
                    {workflowNodes.map((n) => (
                      <li
                        key={n.id}
                        className="truncate text-[11px] text-(--color-foreground-strong)"
                      >
                        → {n.label || n.id}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="mt-auto flex gap-2">
                {isPick ? (
                  <button
                    type="button"
                    onClick={() => onPick?.(tool)}
                    className="flex-1 rounded-md bg-(--color-accent) px-2 py-1 text-xs font-semibold text-(--color-accent-foreground) transition hover:opacity-90"
                  >
                    Use this tool
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => remove(tool)}
                    className="rounded-md border border-(--color-border) bg-(--color-panel-soft) px-2 py-1 text-xs hover:bg-red-500/10 hover:text-red-600 disabled:opacity-50"
                    title={
                      workflowNodes.length > 0
                        ? "Removing this tool will leave the wired workflow node(s) without a target — edit the workflow first if you want them to keep working."
                        : undefined
                    }
                  >
                    {isBusy ? "Removing…" : "Remove"}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
