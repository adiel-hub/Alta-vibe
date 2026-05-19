import { useEffect, useMemo, useState } from "react";
import { useAgentStore } from "@/store/agentStore";
import { appFetch } from "@/lib/apiClient";
import type { RuntimePhase, RuntimeTool } from "@/types/agent";
import type {
  CatalogProvider,
  CatalogTool,
  FieldsMatcher,
  ToolsTabMode,
} from "../types";
import { friendlyToolName } from "../utils/names";
import { Section } from "../primitives/Section";
import { ProviderIcon } from "../primitives/ProviderIcon";
import { ProviderToolList } from "./ProviderToolList";
import { ConnectProviderButton } from "./ConnectProviderButton";

// ── Integrations ─────────────────────────────────────────────────────────

export function IntegrationsSection({
  agentId,
  phase,
  fieldsMatch,
  hasQuery,
  mode = "manage",
  onPick,
}: {
  agentId: string;
  phase: RuntimePhase;
  fieldsMatch: FieldsMatcher;
  hasQuery: boolean;
  mode?: ToolsTabMode;
  onPick?: (tool: RuntimeTool) => void;
}) {
  const applyConfigDirect = useAgentStore((s) => s.applyConfigDirect);
  const tools = useAgentStore((s) => s.config?.tools);
  const installedNames = useMemo(
    () => new Set(tools?.map((t) => t.name) ?? []),
    [tools],
  );

  const [catalog, setCatalog] = useState<CatalogProvider[] | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    appFetch(`/api/agents/${agentId}/provider-tools`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r)))
      .then((data: { catalog: CatalogProvider[] }) => {
        if (!cancelled) setCatalog(data.catalog);
      })
      .catch(() => {
        if (!cancelled) setError("Couldn't load integrations catalog.");
      });
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  async function install(provider: string, toolKey: string) {
    setBusyKey(`${provider}:${toolKey}`);
    setError(null);
    try {
      const res = await appFetch(`/api/agents/${agentId}/provider-tools`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider, tool_key: toolKey }),
      });
      const data = (await res.json()) as {
        revision?: number;
        tool?: RuntimeTool;
        error?: string;
      };
      if (!res.ok || !data.tool) {
        setError(data.error ?? `Install failed (${res.status})`);
        return;
      }
      const currentTools = useAgentStore.getState().config?.tools ?? [];
      applyConfigDirect(
        { tools: [...currentTools, data.tool] },
        data.revision ?? 0,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Install failed");
    } finally {
      setBusyKey(null);
    }
  }

  async function uninstall(toolName: string) {
    setBusyKey(`uninstall:${toolName}`);
    setError(null);
    try {
      const res = await appFetch(
        `/api/agents/${agentId}/provider-tools?name=${encodeURIComponent(toolName)}`,
        { method: "DELETE" },
      );
      const data = (await res.json()) as {
        revision?: number;
        tools?: RuntimeTool[];
        error?: string;
      };
      if (!res.ok || !data.tools) {
        setError(data.error ?? `Uninstall failed (${res.status})`);
        return;
      }
      applyConfigDirect({ tools: data.tools }, data.revision ?? 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Uninstall failed");
    } finally {
      setBusyKey(null);
    }
  }

  // Only show providers that have at least one tool in the active phase
  // (and match the search), so the integration grid stays aligned with
  // the tab the user picked.
  const toolMatches = (p: CatalogProvider, t: CatalogTool) =>
    fieldsMatch([
      t.name,
      t.description,
      t.category,
      friendlyToolName(t.name, p.id, phase),
    ]);
  const providerMatches = (p: CatalogProvider) =>
    fieldsMatch([p.name, p.description]);

  const visibleProviders = (catalog ?? []).filter((p) => {
    const hasPhaseTool = p.tools.some((t) => t.phase === phase);
    if (!hasPhaseTool) return false;
    if (providerMatches(p)) return true;
    return p.tools.some((t) => t.phase === phase && toolMatches(p, t));
  });

  // Smart expand on search: when the user types something that only matches
  // tools inside one (or the first) provider, auto-open that provider's
  // drawer so the matching tool is one click closer. Skipped when there's
  // no query, so the manual expand/collapse UX stays intact otherwise.
  useEffect(() => {
    if (!hasQuery || !catalog) return;
    if (expanded && visibleProviders.some((p) => p.id === expanded)) return;
    const firstWithToolHit = visibleProviders.find((p) =>
      p.tools.some((t) => t.phase === phase && toolMatches(p, t)),
    );
    const target = firstWithToolHit ?? visibleProviders[0];
    if (target) setExpanded(target.id);
    // visibleProviders / toolMatches are derived from fieldsMatch + catalog
    // + phase, which are already in the deps. Recomputing them inside the
    // effect keeps the dependency surface small without risking stale
    // closure data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasQuery, fieldsMatch, phase, catalog]);

  return (
    <Section title="Integrations">
      {error && (
        <div className="mb-2 rounded-md border border-red-400/40 bg-red-500/10 px-3 py-2 text-xs text-red-200">
          {error}
        </div>
      )}
      {!catalog ? (
        <p className="rounded-lg border border-dashed border-(--color-border) bg-(--color-panel-soft) px-3 py-3 text-xs text-(--color-muted)">
          Loading catalog…
        </p>
      ) : visibleProviders.length === 0 ? (
        <p className="rounded-lg border border-dashed border-(--color-border) bg-(--color-panel-soft) px-3 py-3 text-xs text-(--color-muted)">
          No integrations for this phase.
        </p>
      ) : (
        <>
          <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5">
            {visibleProviders.map((p) => {
              const isOpen = expanded === p.id;
              const phaseTools = p.tools.filter((t) => t.phase === phase);
              const installedCount = phaseTools.filter((t) =>
                installedNames.has(t.name),
              ).length;
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => setExpanded(isOpen ? null : p.id)}
                    className={`relative flex aspect-square w-full flex-col items-center justify-center gap-1 rounded-xl border bg-white p-2 text-center transition hover:border-(--color-accent)/40 ${
                      isOpen
                        ? "border-(--color-accent)/60 ring-1 ring-(--color-accent)/40"
                        : "border-(--color-border)"
                    }`}
                  >
                    <span
                      className={`absolute right-2 top-2 h-1.5 w-1.5 rounded-full ${
                        p.connected ? "bg-emerald-400" : "bg-amber-400"
                      }`}
                      title={p.connected ? "Connected" : "Not connected"}
                    />
                    <ProviderIcon icon={p.icon} name={p.name} size="lg" />
                    <span className="line-clamp-2 text-sm font-medium leading-tight">
                      {p.name}
                    </span>
                    <span className="text-[10px] uppercase tracking-wider text-(--color-muted)">
                      {installedCount}/{phaseTools.length} installed
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {expanded &&
            (() => {
              const p = visibleProviders.find((v) => v.id === expanded);
              if (!p) return null;
              return (
                <div className="mt-3 rounded-xl border border-(--color-border) bg-(--color-panel-soft)">
                  <div className="flex items-center justify-between gap-2 border-b border-(--color-border) px-3 py-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <ProviderIcon icon={p.icon} name={p.name} />
                      <span className="truncate text-sm font-medium">
                        {p.name}
                      </span>
                      {p.connected && (
                        <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] text-emerald-300">
                          connected
                        </span>
                      )}
                    </div>
                    {!p.connected && (
                      <ConnectProviderButton
                        agentId={agentId}
                        providerName={p.name}
                      />
                    )}
                  </div>
                  <ProviderToolList
                    provider={p}
                    phase={phase}
                    fieldsMatch={fieldsMatch}
                    hasQuery={hasQuery}
                    installedNames={installedNames}
                    busyKey={busyKey}
                    onInstall={install}
                    onUninstall={uninstall}
                    mode={mode}
                    onPick={onPick}
                  />
                </div>
              );
            })()}
        </>
      )}
    </Section>
  );
}
