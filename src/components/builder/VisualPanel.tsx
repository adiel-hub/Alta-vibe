"use client";

import { useEffect, useRef, useState } from "react";
import { useAgentStore, type SectionKey } from "@/store/agentStore";
import { useCallMonitorStore } from "@/store/callMonitorStore";
import { OverviewTab } from "./tabs/Overview";
import { WorkflowTab } from "./tabs/Workflow";
import { VoiceTab } from "./tabs/Voice";
import { KnowledgeBaseTab } from "./tabs/KnowledgeBase";
import { CallOutcomesTab } from "./tabs/CallOutcomes";
import { ToolsTab } from "./tabs/Tools";
import { PhoneTab } from "./tabs/Phone";
import { CallLogsTab } from "./tabs/CallLogs";
import { DashboardTab } from "./tabs/Dashboard";
import { TestCallButton } from "./TestCallButton";

const TABS = [
  { id: "persona", label: "Persona" },
  { id: "workflow", label: "Workflow" },
  { id: "voice", label: "Configurations" },
  { id: "kb", label: "Knowledge" },
  { id: "outcomes", label: "Outcomes" },
  { id: "tools", label: "Tools" },
  { id: "phone", label: "Phone" },
  { id: "calls", label: "Call logs" },
  { id: "dashboard", label: "Dashboard" },
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
  pronunciation: "kb",
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
  const callStatus = useCallMonitorStore((s) => s.status);
  const prevCallStatus = useRef(callStatus);
  const lastError = useAgentStore((s) => s.agent?.last_error);
  const activeJobId = useAgentStore((s) => s.activeJobId);
  const lastActiveSection = useAgentStore((s) => s.lastActiveSection);
  const inFlight = useAgentStore((s) => s.inFlight);
  const turns = useAgentStore((s) => s.turns);
  const lastAutoSwitchAt = useRef<number>(0);

  // Hide the right-side sections during the initial create flow and play
  // the Katie sketching gif instead. The trigger is "the builder agent
  // has called update_first_message at least once in this conversation"
  // — checking the first_message field directly doesn't work because
  // brand-new agents are seeded with a default greeting, so the field is
  // never empty.
  const hasPolishedGreeting = turns.some(
    (t) =>
      t.role === "assistant" &&
      t.content.some(
        (b) => b.type === "tool_use" && b.name.endsWith("update_first_message"),
      ),
  );
  const showCreationAnim = !hasPolishedGreeting;

  // Each new turn starts with a fresh auto-switch budget. Without this
  // reset, lastAutoSwitchAt.current carries forward the timestamp from
  // turn N's final switch (or a manual click between turns), and turn
  // N+1's first tool can lose the timestamp race — the panel stays on
  // whatever tab the previous turn ended on (commonly Post-call analysis
  // after add_call_outcome / add_data_collection_field).
  useEffect(() => {
    if (activeJobId) lastAutoSwitchAt.current = 0;
  }, [activeJobId]);

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

  // When a web test call starts, jump to the Workflow tab so the user can
  // watch the call move through the graph live. Only fires on the idle→live
  // edge (web calls), so a manual tab change mid-call is respected.
  useEffect(() => {
    if (callStatus === "live" && prevCallStatus.current !== "live") {
      setTab("workflow");
    }
    prevCallStatus.current = callStatus;
  }, [callStatus]);

  const fullBleed = FULL_BLEED_TABS.includes(tab);

  if (showCreationAnim) {
    return (
      <div className="preparing-canvas grid h-full place-items-center animate-fade-in">
        <div className="flex flex-col items-center gap-4">
          {/* Plain <img> is intentional — next/image rewrites GIFs and can
              kill the animation. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/katie-pencil.gif"
            alt="Setting up your agent"
            className="h-auto w-[16rem] max-w-[55vw] rounded-2xl"
          />
          <p className="text-sm font-normal text-(--color-muted)">
            Preparing your agent
            <span className="dot-flash ml-1" />
            <span className="dot-flash" style={{ animationDelay: "120ms" }} />
            <span className="dot-flash" style={{ animationDelay: "240ms" }} />
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-end gap-1 border-b border-(--color-border) bg-(--color-panel) px-5">
        <nav className="flex flex-1 gap-0 overflow-x-auto pb-0 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
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
        {tab === "dashboard" && <DashboardTab agentId={agentId} />}
      </div>
    </div>
  );
}
