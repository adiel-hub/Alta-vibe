"use client";

import { useState } from "react";
import { useAgentStore } from "@/store/agentStore";
import { OverviewTab } from "./tabs/OverviewTab";
import { VoiceTab } from "./tabs/VoiceTab";
import { KnowledgeBaseTab } from "./tabs/KnowledgeBaseTab";
import { ToolsTab } from "./tabs/ToolsTab";
import { TestCallTab } from "./tabs/TestCallTab";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "voice", label: "Voice & LLM" },
  { id: "kb", label: "Knowledge" },
  { id: "tools", label: "Tools" },
  { id: "test", label: "Test call" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export function VisualPanel({ agentId }: { agentId: string }) {
  const [tab, setTab] = useState<TabId>("overview");
  const config = useAgentStore((s) => s.config);
  const lastError = useAgentStore((s) => s.agent?.last_error);

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-(--color-border) px-5 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wider text-(--color-muted)">
              Agent
            </h2>
            <p className="truncate text-base font-medium">{config?.name ?? "—"}</p>
          </div>
        </div>
        <nav className="mt-3 flex gap-1 overflow-x-auto">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`rounded-full px-3 py-1 text-xs font-medium whitespace-nowrap transition ${
                tab === t.id
                  ? "bg-(--color-accent) text-(--color-accent-foreground)"
                  : "text-(--color-muted) hover:text-(--color-foreground)"
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>

      {lastError && (
        <div className="border-b border-(--color-danger) bg-(--color-danger)/10 px-5 py-2 text-xs text-(--color-danger)">
          Last ElevenLabs error · {lastError.op} · {lastError.message}
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-5 py-5">
        {tab === "overview" && <OverviewTab />}
        {tab === "voice" && <VoiceTab />}
        {tab === "kb" && <KnowledgeBaseTab agentId={agentId} />}
        {tab === "tools" && <ToolsTab />}
        {tab === "test" && <TestCallTab agentId={agentId} />}
      </div>
    </div>
  );
}
