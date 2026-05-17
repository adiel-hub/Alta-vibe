"use client";

import { useEffect, useRef, useState } from "react";
import { useAgentStore, type SectionKey } from "@/store/agentStore";
import { OverviewTab } from "./tabs/OverviewTab";
import { WorkflowTab } from "./tabs/WorkflowTab";
import { VoiceTab } from "./tabs/VoiceTab";
import { KnowledgeBaseTab } from "./tabs/KnowledgeBaseTab";
import { ToolsTab } from "./tabs/ToolsTab";
import { PhoneTab } from "./tabs/PhoneTab";
import { CallLogsTab } from "./tabs/CallLogsTab";
import { TestCallTab } from "./tabs/TestCallTab";
import { AnalyticsTab } from "./tabs/AnalyticsTab";

const TABS = [
  { id: "persona", label: "Persona" },
  { id: "workflow", label: "Workflow" },
  { id: "voice", label: "Voice & Language" },
  { id: "kb", label: "Knowledge" },
  { id: "tools", label: "Tools" },
  { id: "analytics", label: "Analytics" },
  { id: "phone", label: "Phone" },
  { id: "test", label: "Test" },
  { id: "calls", label: "Call logs" },
] as const;

type TabId = (typeof TABS)[number]["id"];

const SECTION_TO_TAB: Partial<Record<SectionKey, TabId>> = {
  name: "persona",
  first_message: "persona",
  system_prompt: "persona",
  workflow: "workflow",
  voice: "voice",
  llm: "voice",
  knowledge_base: "kb",
  tools: "tools",
  mcp: "tools",
  phone: "phone",
  data: "analytics",
  evaluation: "analytics",
};

// Tabs that fully control their own scrollable area (workflow playground).
const FULL_BLEED_TABS: TabId[] = ["workflow"];

export function VisualPanel({ agentId }: { agentId: string }) {
  const [tab, setTab] = useState<TabId>("persona");
  const config = useAgentStore((s) => s.config);
  const lastError = useAgentStore((s) => s.agent?.last_error);
  const activeJobId = useAgentStore((s) => s.activeJobId);
  const lastActiveSection = useAgentStore((s) => s.lastActiveSection);
  const inFlight = useAgentStore((s) => s.inFlight);
  const lastAutoSwitchAt = useRef<number>(0);

  // Auto-switch to whichever tab the live turn just started touching.
  useEffect(() => {
    if (!activeJobId) return;
    if (!lastActiveSection) return;
    if (lastActiveSection.at <= lastAutoSwitchAt.current) return;
    const next = SECTION_TO_TAB[lastActiveSection.key];
    if (!next) return;
    lastAutoSwitchAt.current = lastActiveSection.at;
    setTab(next);
  }, [lastActiveSection, activeJobId]);

  const fullBleed = FULL_BLEED_TABS.includes(tab);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-end gap-1 border-b border-(--color-border) bg-(--color-panel) px-5 pt-3">
        <nav className="flex flex-1 gap-0 overflow-x-auto pb-0">
          {TABS.map((t) => {
            const sectionsForTab = (
              Object.entries(SECTION_TO_TAB) as [SectionKey, TabId][]
            )
              .filter(([, tabId]) => tabId === t.id)
              .map(([sec]) => sec);
            const building = sectionsForTab.some((s) => inFlight.has(s));
            const isOn = tab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => {
                  lastAutoSwitchAt.current = Date.now();
                  setTab(t.id);
                }}
                className={`relative -mb-px inline-flex items-center gap-1.5 whitespace-nowrap rounded-t-md border-b-2 px-3 py-2 text-[13px] font-medium transition ${
                  isOn
                    ? "border-(--color-accent) text-(--color-accent)"
                    : "border-transparent text-(--color-muted) hover:text-(--color-foreground-strong)"
                }`}
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    building
                      ? "animate-pulse bg-(--color-violet-500)"
                      : isOn
                        ? "bg-(--color-success)"
                        : "bg-(--color-border-strong)"
                  }`}
                />
                {t.label}
              </button>
            );
          })}
        </nav>
        <div className="pb-2 pl-3 text-right">
          <div className="font-mono text-[10px] uppercase tracking-widest text-(--color-muted-soft)">
            Voice agent
          </div>
          <div className="truncate text-[13px] font-semibold text-(--color-foreground-strong)">
            {config?.name ?? "—"}
          </div>
        </div>
      </header>

      {lastError && (
        <div className="border-b border-(--color-danger)/40 bg-(--color-red-50) px-5 py-2 text-xs text-(--color-danger)">
          Last error · {lastError.op} · {lastError.message}
        </div>
      )}

      <div
        key={tab}
        className={`tab-content ${
          fullBleed
            ? "flex-1 min-h-0 overflow-hidden"
            : "flex-1 overflow-y-auto px-6 py-6"
        }`}
        style={
          fullBleed
            ? undefined
            : {
                backgroundImage:
                  "radial-gradient(circle, rgba(0,0,0,0.045) 1px, transparent 1px)",
                backgroundSize: "22px 22px",
                backgroundColor: "var(--color-panel-sunken)",
              }
        }
      >
        {tab === "persona" && <OverviewTab agentId={agentId} />}
        {tab === "workflow" && <WorkflowTab />}
        {tab === "voice" && <VoiceTab agentId={agentId} />}
        {tab === "kb" && <KnowledgeBaseTab agentId={agentId} />}
        {tab === "tools" && <ToolsTab />}
        {tab === "analytics" && <AnalyticsTab />}
        {tab === "phone" && <PhoneTab agentId={agentId} />}
        {tab === "test" && <TestCallTab agentId={agentId} />}
        {tab === "calls" && <CallLogsTab agentId={agentId} />}
      </div>
    </div>
  );
}
