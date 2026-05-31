"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useAgentStore } from "@/store/agentStore";
import { appFetch } from "@/lib/apiClient";
import type {
  AgentConfigCache,
  AgentDTO,
  RuntimePhase,
  RuntimeTool,
} from "@/types/agent";
import type { CatalogProvider, ToolsTabMode } from "./types";
import { PHASE_HINTS } from "./constants";
import { makeMatcher } from "./utils/search";
import { SearchBar } from "./primitives/SearchBar";
import { PhaseTabs } from "./primitives/PhaseTabs";
import { ToolboxSection } from "./sections/ToolboxSection";
import { IntegrationsSection } from "./sections/IntegrationsSection";

export type { ToolsTabMode } from "./types";

export function ToolsTab({
  mode = "manage",
  onPick,
  initialPhase = "in_call",
}: {
  mode?: ToolsTabMode;
  onPick?: (tool: RuntimeTool) => void;
  initialPhase?: RuntimePhase;
} = {}) {
  const agent = useAgentStore((s) => s.agent);
  const config = useAgentStore((s) => s.config);
  const applyConfigDirect = useAgentStore((s) => s.applyConfigDirect);
  const pendingToolFocus = useAgentStore((s) => s.pendingToolFocus);

  const [activePhase, setActivePhase] = useState<RuntimePhase>(initialPhase);
  const [query, setQuery] = useState("");

  // On mount, refetch the agent. The GET handler runs `ensureBindingsMigrated`,
  // which drops any orphan tools from `config.tools` — without this, the
  // local Zustand store could keep showing tools that no longer exist
  // server-side until the user navigates away.
  const agentId = agent?.id;
  useEffect(() => {
    if (!agentId) return;
    let cancelled = false;
    appFetch(`/api/agents/${agentId}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r)))
      .then((data: AgentDTO) => {
        if (cancelled) return;
        // Only refresh the tools slice — leaving the rest alone avoids
        // clobbering anything the user might be editing in another tab.
        const patch: Partial<AgentConfigCache> = {
          tools: data.config_cache.tools,
          workflow: data.config_cache.workflow,
        };
        applyConfigDirect(patch, data.revision);
      })
      .catch(() => {
        // Stale UI > broken UI. The user can still navigate.
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, applyConfigDirect]);

  // Catalog is shared by ToolboxSection (provenance / icon lookup) and
  // IntegrationsSection (the browse drawer). Fetching once at the parent
  // keeps both views in sync and halves the network round trips.
  const [catalog, setCatalog] = useState<CatalogProvider[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  useEffect(() => {
    if (!agentId) return;
    let cancelled = false;
    appFetch(`/api/agents/${agentId}/provider-tools`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r)))
      .then((data: { catalog: CatalogProvider[] }) => {
        if (!cancelled) setCatalog(data.catalog);
      })
      .catch(() => {
        if (!cancelled) setCatalogError("Couldn't load integrations catalog.");
      });
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  // When Alta creates a new tool, the store stamps the new tool's phase into
  // pendingToolFocus. Switch the sub-tab to match, but only once per stamp —
  // the user is free to navigate away after that.
  const lastConsumedAt = useRef<number | null>(null);
  useEffect(() => {
    if (!pendingToolFocus) return;
    if (lastConsumedAt.current === pendingToolFocus.at) return;
    lastConsumedAt.current = pendingToolFocus.at;
    setActivePhase(pendingToolFocus.phase);
  }, [pendingToolFocus]);

  const fieldsMatch = useMemo(() => makeMatcher(query), [query]);
  const hasQuery = query.trim().length > 0;

  if (!config || !agent) return null;

  // In pick mode the picker is rendered inside a modal that already
  // provides its own panel chrome — strip our outer card so it doesn't
  // double up.
  const isPick = mode === "pick";
  const Outer = isPick
    ? ({ children }: { children: React.ReactNode }) => <>{children}</>
    : ({ children }: { children: React.ReactNode }) => (
        <div className="mx-auto flex max-w-[760px] flex-col gap-5">
          <div className="rounded-2xl border border-(--color-border) bg-(--color-panel) p-4">
            {children}
          </div>
        </div>
      );

  return (
    <Outer>
      <SearchBar value={query} onChange={setQuery} />

      <PhaseTabs active={activePhase} onChange={setActivePhase} />

      <p className="mb-4 px-1 text-xs text-(--color-muted)">
        {PHASE_HINTS[activePhase]}
        {isPick && initialPhase === "in_call" && activePhase !== "in_call" && (
          <span className="ml-1 text-(--color-warn, #b45309)">
            Note: workflow tool_call nodes only execute during the
            conversation. Pick an In-Call tool to wire into the graph.
          </span>
        )}
      </p>

      {catalogError && (
        <div className="mb-2 rounded-md border border-red-400/40 bg-red-500/10 px-3 py-2 text-xs text-red-200">
          {catalogError}
        </div>
      )}

      <ToolboxSection
        agentId={agent.id}
        phase={activePhase}
        fieldsMatch={fieldsMatch}
        catalog={catalog}
        mode={mode}
        onPick={onPick}
      />

      <IntegrationsSection
        agentId={agent.id}
        phase={activePhase}
        fieldsMatch={fieldsMatch}
        hasQuery={hasQuery}
        catalog={catalog}
        catalogError={catalogError}
        mode={mode}
        onPick={onPick}
      />
    </Outer>
  );
}
