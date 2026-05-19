"use client";

import { useEffect, useRef, useState } from "react";
import { useAgentStore, type SectionKey } from "@/store/agentStore";
import { OverviewTab } from "./tabs/OverviewTab";
import { WorkflowTab } from "./tabs/WorkflowTab";
import { VoiceTab } from "./tabs/VoiceTab";
import { KnowledgeBaseTab } from "./tabs/KnowledgeBaseTab";
import { CallOutcomesTab } from "./tabs/CallOutcomesTab";
import { ToolsTab } from "./tabs/ToolsTab";
import { PhoneTab } from "./tabs/PhoneTab";
import { CallLogsTab } from "./tabs/CallLogsTab";
import { TestCallButton } from "./TestCallButton";

const TABS = [
  { id: "persona", label: "Persona" },
  { id: "workflow", label: "Workflow" },
  { id: "voice", label: "Voice & Language" },
  { id: "kb", label: "Knowledge" },
  { id: "outcomes", label: "Post-call analysis" },
  { id: "tools", label: "Tools" },
  { id: "phone", label: "Phone" },
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
  data: "outcomes",
  evaluation: "outcomes",
};

// Tabs that fully control their own scrollable area (workflow playground).
const FULL_BLEED_TABS: TabId[] = ["workflow"];

export function VisualPanel({ agentId }: { agentId: string }) {
  const [tab, setTab] = useState<TabId>("persona");
  const elevenLabsAgentId = useAgentStore(
    (s) => s.agent?.elevenlabs_agent_id,
  );
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
      <header className="flex h-14 shrink-0 items-end gap-1 border-b border-(--color-border) bg-(--color-panel) px-5">
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
        <div className="flex items-center gap-2 pb-2 pl-3">
          {elevenLabsAgentId && (
            <a
              href={`https://elevenlabs.io/app/conversational-ai/agents/${elevenLabsAgentId}`}
              target="_blank"
              rel="noopener noreferrer"
              title="Open this agent in the 11labs builder"
              className="inline-flex items-center gap-2 rounded-full border border-(--color-border) bg-(--color-panel) px-3.5 py-1.5 text-[12px] font-semibold text-(--color-foreground-strong) transition hover:border-(--color-accent) hover:text-(--color-accent)"
            >
              <ExternalLinkIcon />
              Open in 11labs
            </a>
          )}
          <TestCallButton agentId={agentId} />
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
        {tab === "workflow" && <WorkflowTab agentId={agentId} />}
        {tab === "voice" && <VoiceTab agentId={agentId} />}
        {tab === "kb" && <KnowledgeBaseTab agentId={agentId} />}
        {tab === "outcomes" && <CallOutcomesTab agentId={agentId} />}
        {tab === "tools" && <ToolsTab />}
        {tab === "phone" && <PhoneTab agentId={agentId} />}
        {tab === "calls" && <CallLogsTab agentId={agentId} />}
      </div>
    </div>
  );
}

function ExternalLinkIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}
