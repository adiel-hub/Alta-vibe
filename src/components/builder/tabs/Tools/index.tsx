"use client";

import { useMemo, useState } from "react";
import { useAgentStore } from "@/store/agentStore";
import type { RuntimePhase, RuntimeTool } from "@/types/agent";
import type { ToolsTabMode } from "./types";
import { PHASE_HINTS } from "./constants";
import { makeMatcher } from "./utils/search";
import { SearchBar } from "./primitives/SearchBar";
import { PhaseTabs } from "./primitives/PhaseTabs";
import { CustomToolsSection } from "./sections/CustomToolsSection";
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

  const [activePhase, setActivePhase] = useState<RuntimePhase>(initialPhase);
  const [query, setQuery] = useState("");

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

      <CustomToolsSection
        agentId={agent.id}
        phase={activePhase}
        fieldsMatch={fieldsMatch}
        mode={mode}
        onPick={onPick}
      />

      <IntegrationsSection
        agentId={agent.id}
        phase={activePhase}
        fieldsMatch={fieldsMatch}
        hasQuery={hasQuery}
        mode={mode}
        onPick={onPick}
      />
    </Outer>
  );
}
