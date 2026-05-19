"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useAgentStore } from "@/store/agentStore";
import { attachToTurn, sendMessage } from "@/store/sseClient";
import { appFetch } from "@/lib/apiClient";
import { createClientLogger } from "@/lib/clientLogger";
import type { ContentBlock } from "@/types/agent";
import { ChatWidget } from "./ChatWidget";
import { Typewriter } from "./Typewriter";
import { VersionHistoryPanel } from "./VersionHistoryPanel";
import { friendlyForTool } from "@/lib/capabilities/toolDisplay";

const log = createClientLogger("chat");

export function ChatPanel({ agentId }: { agentId: string }) {
  const turns = useAgentStore((s) => s.turns);
  const streaming = useAgentStore((s) => s.streaming);
  const agentName = useAgentStore((s) => s.config?.name);
  // Used to suppress the "thinking…" dots when a tool pill is already
  // visible — otherwise we show two activity indicators side by side.
  const liveTool = useAgentStore((s) => s.liveTool);
  // True for the whole duration of the agent's turn (from kickoff through
  // SSE end), not just while sendMessage is in flight. Drives the spinner
  // on the send button.
  const activeJobId = useAgentStore((s) => s.activeJobId);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const scrollerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await appFetch(`/api/agents/${agentId}/turns/active`);
        if (!res.ok) return;
        const json = (await res.json()) as { active: { id: string } | null };
        if (cancelled || !json.active) {
          log.debug("no active turn to resume", { agent_id: agentId });
          return;
        }
        log.info("resuming active turn", {
          agent_id: agentId,
          job_id: json.active.id,
        });
        setSending(true);
        await attachToTurn(agentId, json.active.id, 0);
      } catch (err) {
        log.warn("resume failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setSending(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  useEffect(() => {
    if (scrollerRef.current) {
      scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
    }
  }, [turns, streaming]);

  const send = async () => {
    const text = input.trim();
    if (!text || sending) return;
    log.debug("user send", { text_len: text.length });
    setInput("");
    setSending(true);
    setError(null);
    try {
      await sendMessage(agentId, text);
    } catch (err) {
      log.error("send error", {
        error: err instanceof Error ? err.message : String(err),
      });
      setError(err instanceof Error ? err.message : "Stream failed");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-(--color-border) px-4 animate-fade-in">
        {historyOpen ? (
          <button
            type="button"
            onClick={() => setHistoryOpen(false)}
            aria-label="Back to chat"
            title="Back to chat"
            className="grid h-8 w-8 place-items-center rounded-md text-(--color-muted) transition hover:bg-(--color-panel-soft) hover:text-(--color-foreground-strong)"
          >
            <BackArrowIcon />
          </button>
        ) : (
          <Link
            href="/"
            aria-label="Back to home"
            title="Back to home"
            className="grid h-8 w-8 place-items-center rounded-md text-(--color-muted) transition hover:bg-(--color-panel-soft) hover:text-(--color-foreground-strong)"
          >
            <BackArrowIcon />
          </Link>
        )}
        {historyOpen ? (
          <span className="truncate px-1.5 py-0.5 text-[13px] font-semibold text-(--color-foreground-strong)">
            Version history
          </span>
        ) : (
          <EditableAgentName agentId={agentId} value={agentName ?? ""} />
        )}
        <div className="ml-auto flex items-center gap-2">
          {activeJobId && (
            <span
              className="flex items-center gap-1 text-(--color-accent) animate-fade-in"
              role="status"
              aria-label="Agent is working"
              title="Agent is working"
            >
              <span className="dot-flash" />
              <span className="dot-flash" style={{ animationDelay: "120ms" }} />
              <span className="dot-flash" style={{ animationDelay: "240ms" }} />
            </span>
          )}
          <button
            type="button"
            onClick={() => setHistoryOpen((v) => !v)}
            title={historyOpen ? "Back to chat" : "Version history"}
            aria-pressed={historyOpen}
            className={`grid h-8 w-8 place-items-center rounded-md transition ${
              historyOpen
                ? "bg-(--color-accent)/10 text-(--color-accent)"
                : "text-(--color-muted) hover:bg-(--color-panel-soft) hover:text-(--color-foreground-strong)"
            }`}
          >
            <HistoryIcon />
          </button>
        </div>
      </header>

      {historyOpen ? (
        <VersionHistoryPanel agentId={agentId} />
      ) : (
      <>
      <div ref={scrollerRef} className="flex-1 space-y-4 overflow-y-auto px-5 py-5 text-(--color-foreground)">
        {turns.length === 0 && !streaming && (
          <div className="space-y-2 text-sm text-(--color-muted) animate-fade-in">
            <p>Try one of:</p>
            <ul className="list-disc space-y-1 pl-5">
              <li className="italic">
                &quot;Sketch a workflow for triaging support calls.&quot;
              </li>
              <li className="italic">
                &quot;Use a calm female voice and slow her down a touch.&quot;
              </li>
              <li className="italic">
                &quot;Crawl https://docs.example.com into the knowledge base.&quot;
              </li>
              <li className="italic">
                &quot;Connect HubSpot so the agent can look up callers.&quot;
              </li>
              <li className="italic">
                &quot;Extract order_number and resolved (boolean) from every call.&quot;
              </li>
            </ul>
          </div>
        )}
        {turns.map((turn, i) => (
          <TurnView
            key={turn.id}
            role={turn.role}
            content={turn.content}
            agentId={agentId}
            // Live-typewriter the final assistant turn while the run is still
            // active; otherwise show fully.
            live={false}
            isLast={i === turns.length - 1}
          />
        ))}
        {streaming && (
          <TurnView
            role="assistant"
            content={[{ type: "text", text: streaming.text || "" }]}
            agentId={agentId}
            live
            isLast
            // Suppress the "thinking…" dots when a tool is mid-flight; the
            // tool pill below already shows running state. Showing both
            // duplicates the "something is happening" signal.
            streamingHint={!streaming.text && !liveTool}
          />
        )}
      </div>

      {error && (
        <div className="border-t border-(--color-danger) bg-(--color-danger)/10 px-5 py-2 text-xs text-(--color-danger) animate-fade-in">
          {error}
        </div>
      )}

      <footer className="border-t border-(--color-border) bg-(--color-panel) p-3">
        <div className="rounded-xl border border-(--color-border) bg-(--color-panel) p-2.5 transition focus-within:border-(--color-accent) focus-within:shadow-[0_0_0_3px_rgba(79,70,229,0.08)]">
          <textarea
            dir="auto"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            rows={2}
            placeholder="Describe a change…"
            disabled={sending}
            className="w-full resize-none bg-transparent text-sm text-(--color-foreground-strong) outline-none placeholder:text-(--color-muted-soft)"
          />
          <div className="mt-2 flex items-center gap-2 border-t border-(--color-panel-soft) pt-2">
            <span className="ml-auto rounded border border-(--color-border) bg-(--color-panel-soft) px-1.5 py-0.5 font-mono text-[10px] text-(--color-muted-soft)">
              ⏎
            </span>
            {(() => {
              const running = sending || activeJobId !== null;
              return (
                <button
                  onClick={send}
                  disabled={running || !input.trim()}
                  // While the agent is running we keep the button visually
                  // "live" (accent bg, no greying) and just swap the icon
                  // for a spinner — that's a clearer signal than dimming it.
                  className={
                    running
                      ? "grid h-7 w-7 place-items-center rounded-md bg-(--color-accent) text-white"
                      : "grid h-7 w-7 place-items-center rounded-md bg-(--color-accent) text-white transition hover:brightness-110 disabled:bg-(--color-border) disabled:text-(--color-muted-soft) disabled:hover:brightness-100"
                  }
                  aria-label={running ? "Agent is running" : "Send"}
                >
                  {running ? (
                    <span
                      className="block h-3 w-3 rounded-full border-[1.5px] border-white/40 border-t-white"
                      style={{ animation: "vask-spin 0.8s linear infinite" }}
                      aria-hidden
                    />
                  ) : (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <line x1="5" y1="12" x2="19" y2="12" />
                      <polyline points="12 5 19 12 12 19" />
                    </svg>
                  )}
                </button>
              );
            })()}
          </div>
        </div>
      </footer>
      </>
      )}
    </div>
  );
}

function BackArrowIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <line x1="19" y1="12" x2="5" y2="12" />
      <polyline points="12 19 5 12 12 5" />
    </svg>
  );
}

function HistoryIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <polyline points="3 3 3 8 8 8" />
      <polyline points="12 7 12 12 15 14" />
    </svg>
  );
}

function EditableAgentName({
  agentId,
  value,
}: {
  agentId: string;
  value: string;
}) {
  const applyConfigDirect = useAgentStore((s) => s.applyConfigDirect);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Animated reveal of the name in view mode. `shown` is what's rendered;
  // it ramps up to `value` character-by-character whenever `value` changes
  // externally (e.g. update_agent_name fires). User-initiated saves bypass
  // the animation via `skipNextAnimRef` so the user doesn't see their own
  // typed name re-type itself.
  const [shown, setShown] = useState(value);
  const prevValueRef = useRef(value);
  const skipNextAnimRef = useRef(false);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  useEffect(() => {
    if (editing && inputRef.current) {
      const el = inputRef.current;
      el.focus();
      const len = el.value.length;
      el.setSelectionRange(len, len);
    }
  }, [editing]);

  useEffect(() => {
    if (editing) return;
    if (prevValueRef.current === value) return;
    prevValueRef.current = value;

    if (skipNextAnimRef.current || !value) {
      skipNextAnimRef.current = false;
      setShown(value);
      return;
    }

    setShown("");
    let i = 0;
    const cps = 22;
    const id = window.setInterval(() => {
      i += 1;
      setShown(value.slice(0, i));
      if (i >= value.length) window.clearInterval(id);
    }, Math.round(1000 / cps));
    return () => window.clearInterval(id);
  }, [value, editing]);

  const cancel = () => {
    setDraft(value);
    setEditing(false);
  };

  const save = async () => {
    const next = draft.trim();
    if (!next || next === value) {
      cancel();
      return;
    }
    setSaving(true);
    try {
      const res = await appFetch(`/api/agents/${agentId}/config`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: next }),
      });
      if (!res.ok) throw new Error(`Save failed (${res.status})`);
      const json = (await res.json()) as { revision: number };
      skipNextAnimRef.current = true;
      applyConfigDirect({ name: next }, json.revision);
      setEditing(false);
    } catch (err) {
      log.error("rename failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void save()}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void save();
          } else if (e.key === "Escape") {
            e.preventDefault();
            cancel();
          }
        }}
        disabled={saving}
        placeholder="Name the agent"
        aria-label="Agent name"
        className="w-[260px] rounded-sm bg-transparent px-1 py-0.5 text-[13px] font-semibold text-(--color-foreground-strong) outline-none disabled:opacity-60 placeholder:font-normal placeholder:text-(--color-muted-soft)"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      title="Rename agent"
      className="group flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 text-left transition hover:bg-(--color-panel-soft)"
    >
      {shown && (
        <span className="truncate text-[13px] font-semibold text-(--color-foreground-strong)">
          {shown}
        </span>
      )}
      <PenIcon
        className={`h-3 w-3 shrink-0 text-(--color-muted) transition ${
          shown ? "opacity-0 group-hover:opacity-100" : "opacity-60"
        }`}
      />
    </button>
  );
}

function PenIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
    </svg>
  );
}

function TurnView({
  role,
  content,
  agentId,
  live,
  isLast,
  streamingHint,
}: {
  role: "user" | "assistant" | "system";
  content: ContentBlock[];
  agentId?: string;
  live: boolean;
  isLast: boolean;
  streamingHint?: boolean;
}) {
  const isUser = role === "user";
  const isSystem = role === "system";

  // Build a tool_use_id → tool_result map so each inline ToolCard knows
  // its own outcome without scanning the full block list per render.
  const toolResults = new Map<
    string,
    Extract<ContentBlock, { type: "tool_result" }>
  >();
  for (const b of content) {
    if (b.type === "tool_result") toolResults.set(b.tool_use_id, b);
  }

  // tool_use_ids that produced a widget. Any tool here renders as the
  // widget itself (not a ToolCard) and skips same-name grouping.
  const widgets = useAgentStore((s) => s.widgets);
  const widgetToolUseIds = new Set<string>();
  for (const w of Object.values(widgets)) {
    if (w.tool_use_id) widgetToolUseIds.add(w.tool_use_id);
  }

  // Drop empty assistant bubbles. A turn is visible if it has any non-empty
  // text, a non-result tool block, or we're showing the streaming hint.
  if (role === "assistant" && !streamingHint) {
    const hasVisible = content.some((b) => {
      if (b.type === "text" && b.text.trim().length > 0) return true;
      if (b.type === "tool_use") return true;
      return false;
    });
    if (!hasVisible) return null;
  }

  if (isSystem) {
    const text = content
      .map((b) => (b.type === "text" ? b.text : ""))
      .filter(Boolean)
      .join(" ");
    return (
      <div className="flex justify-center animate-message-in">
        <div className="rounded-full bg-(--color-panel-soft) px-3 py-1 text-[10px] uppercase tracking-wider text-(--color-muted)">
          {text || "system"}
        </div>
      </div>
    );
  }
  const blocks = (
    <>
      {streamingHint && (
        <div className="flex items-center gap-1 text-xs italic text-(--color-muted)">
          <span className="dot-flash" />
          <span className="dot-flash" style={{ animationDelay: "120ms" }} />
          <span className="dot-flash" style={{ animationDelay: "240ms" }} />
          <span className="ml-2">thinking</span>
        </div>
      )}
      {groupConsecutiveTools(content, widgetToolUseIds).map((item, i, arr) => {
        if (item.kind === "group") {
          return (
            <ToolCardGroup
              key={`g-${item.blocks[0].id}`}
              name={item.name}
              blocks={item.blocks}
              results={toolResults}
            />
          );
        }
        return (
          <BlockView
            key={i}
            block={item.block}
            agentId={agentId}
            live={live}
            isLast={isLast && i === arr.length - 1}
            result={
              item.block.type === "tool_use"
                ? toolResults.get(item.block.id)
                : undefined
            }
          />
        );
      })}
    </>
  );

  if (isUser) {
    return (
      <div className="animate-message-in flex justify-end">
        <div className="max-w-[85%] rounded-2xl bg-(--color-panel-soft) px-4 py-2 text-sm text-(--color-foreground-strong)">
          {blocks}
        </div>
      </div>
    );
  }

  return (
    <div className="animate-message-in flex gap-2.5">
      <span className="grid h-7 w-7 shrink-0 place-items-center overflow-hidden rounded-lg bg-(--color-violet-100)">
        <Image
          src="/alta-avatar.png"
          alt=""
          width={28}
          height={28}
          className="h-full w-full object-cover"
        />
      </span>
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="text-[13px] font-semibold text-(--color-foreground-strong)">
          Alex
        </div>
        <div className="space-y-3 text-sm text-(--color-foreground)">
          {blocks}
        </div>
      </div>
    </div>
  );
}

function BlockView({
  block,
  agentId,
  live,
  isLast,
  result,
}: {
  block: ContentBlock;
  agentId?: string;
  live: boolean;
  isLast: boolean;
  result?: Extract<ContentBlock, { type: "tool_result" }>;
}) {
  const widgets = useAgentStore((s) => s.widgets);

  if (block.type === "text") {
    return (
      <div dir="auto" className="leading-relaxed">
        <Typewriter text={block.text} live={live && isLast} />
      </div>
    );
  }
  if (block.type === "tool_use") {
    // Widgets render as their own interactive component, not a tool card.
    // Any tool that creates a widget action (request_user_action,
    // setup_phone_number, …) shows up as the widget itself. We look up by
    // tool_use_id — set by the SSE client when widget_inserted follows
    // tool_call_start — so this works for every widget-producing tool
    // automatically without a hardcoded name list.
    if (agentId) {
      const input = block.input as { kind?: string; payload?: unknown } | undefined;
      const widget =
        Object.values(widgets).find((w) => w.tool_use_id === block.id) ??
        // Legacy fallback: widgets persisted before tool_use_id stamping
        // existed (re-hydrated on reload) match by kind+payload equality.
        // Only meaningful for `request_user_action` where the tool input
        // carries the same shape as the widget payload.
        (block.name === "mcp__alta__request_user_action"
          ? Object.values(widgets).find(
              (w) =>
                w.kind === input?.kind &&
                JSON.stringify(w.payload) === JSON.stringify(input?.payload),
            )
          : undefined);
      if (widget) return <ChatWidget agentId={agentId} widget={widget} />;
    }
    // Hide SDK internals from the chat. ToolSearch is the Claude Agent
    // SDK's deferred-tool loader — it fires every turn to bring our MCP
    // tool schemas into the model's context. It's machinery, not a step
    // the user cares about.
    if (block.name === "ToolSearch") return null;
    return <ToolCard block={block} result={result} />;
  }
  // tool_result blocks are rendered INSIDE the matching tool_use card.
  return null;
}

type ToolStatus = "running" | "success" | "error";

type GroupedItem =
  | { kind: "block"; block: ContentBlock }
  | {
      kind: "group";
      name: string;
      blocks: Extract<ContentBlock, { type: "tool_use" }>[];
    };

/**
/**
 * Tool calls that are pure internal discovery — the agent looking things up
 * to decide what to do next — and add noise to the chat without telling the
 * user anything actionable. Hidden from the chat history rendering.
 */
const HIDDEN_TOOL_NAMES = new Set([
  "ToolSearch",
  "mcp__alta__list_integration_providers",
  "mcp__alta__list_connected_integrations",
]);

/**
 * Collapse runs of consecutive same-name tool calls into one item so we
 * don't paint six "Writing a knowledge note" rows in a column — the user
 * can click to drill into the individual inputs/outputs.
 *
 * Standalone tool_result blocks and tools in HIDDEN_TOOL_NAMES are skipped
 * (already invisible in BlockView). Widget tools render alone.
 */
function groupConsecutiveTools(
  content: ContentBlock[],
  widgetToolUseIds: Set<string>,
): GroupedItem[] {
  // Any tool that produced a widget renders as the widget itself (not a
  // ToolCard) and must not be folded into a same-name group.
  const isWidgetTool = (b: ContentBlock) =>
    b.type === "tool_use" && widgetToolUseIds.has(b.id);
  const items: GroupedItem[] = [];
  let i = 0;
  while (i < content.length) {
    const block = content[i];

    if (block.type === "tool_result") {
      i++;
      continue;
    }

    if (block.type === "tool_use" && HIDDEN_TOOL_NAMES.has(block.name)) {
      i++;
      continue;
    }

    if (block.type !== "tool_use") {
      items.push({ kind: "block", block });
      i++;
      continue;
    }

    if (isWidgetTool(block)) {
      items.push({ kind: "block", block });
      i++;
      continue;
    }

    const group: Extract<ContentBlock, { type: "tool_use" }>[] = [block];
    let j = i + 1;
    while (j < content.length) {
      const next = content[j];
      if (next.type === "tool_result") {
        j++;
        continue;
      }
      if (next.type === "tool_use" && HIDDEN_TOOL_NAMES.has(next.name)) {
        j++;
        continue;
      }
      if (
        next.type === "tool_use" &&
        next.name === block.name &&
        !isWidgetTool(next)
      ) {
        group.push(next);
        j++;
        continue;
      }
      break;
    }

    if (group.length === 1) {
      items.push({ kind: "block", block });
      i++;
    } else {
      items.push({ kind: "group", name: block.name, blocks: group });
      i = j;
    }
  }
  return items;
}

function extractResultText(
  result?: Extract<ContentBlock, { type: "tool_result" }>,
): string | null {
  if (!result) return null;
  const out = result.output;
  if (typeof out === "string") return out;
  if (Array.isArray(out)) {
    return out
      .map((x) =>
        x && typeof x === "object" && "type" in x && (x as { type?: string }).type === "text"
          ? (x as { text?: string }).text ?? ""
          : "",
      )
      .filter(Boolean)
      .join("\n");
  }
  return JSON.stringify(out, null, 2);
}

function StatusIndicator({ status }: { status: ToolStatus }) {
  if (status === "running") return <span className="vb-tool-spin" aria-hidden />;
  if (status === "success") {
    return (
      <span
        className="grid h-3.5 w-3.5 place-items-center text-[10px] font-bold text-(--color-success)"
        aria-hidden
      >
        ✓
      </span>
    );
  }
  return (
    <span
      className="grid h-3.5 w-3.5 place-items-center text-[10px] font-bold text-(--color-danger)"
      aria-hidden
    >
      ✕
    </span>
  );
}

/**
 * Inline card that represents one tool call in the assistant's response.
 * Renders a one-line summary (spinner | ✓ | ✗  +  emoji  +  friendly label).
 * Click to expand → shows the input args and the tool's text output.
 */
function ToolCard({
  block,
  result,
}: {
  block: Extract<ContentBlock, { type: "tool_use" }>;
  result?: Extract<ContentBlock, { type: "tool_result" }>;
}) {
  const [expanded, setExpanded] = useState(false);
  const friendly = friendlyForTool(block.name);
  const status: ToolStatus = !result
    ? "running"
    : result.is_error
      ? "error"
      : "success";

  const indicator = <StatusIndicator status={status} />;

  const resultText = extractResultText(result);

  return (
    <div className="vb-tool-card">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="vb-tool-card-head"
        aria-expanded={expanded}
      >
        {indicator}
        <span className="vb-tool-card-emoji" aria-hidden>
          {friendly.emoji}
        </span>
        <span
          className={`vb-tool-card-label ${
            status === "running" ? "vb-tool-card-label-shimmer" : ""
          }`}
        >
          {friendly.label}
        </span>
        <span className="vb-tool-card-chev" aria-hidden>
          {expanded ? "▾" : "▸"}
        </span>
      </button>
      {expanded && (
        <div className="vb-tool-card-body">
          {block.input !== undefined && (
            <div className="vb-tool-card-section">
              <div className="vb-tool-card-section-label">Input</div>
              <pre dir="auto" className="vb-tool-card-pre">
                {JSON.stringify(block.input, null, 2)}
              </pre>
            </div>
          )}
          {resultText !== null && (
            <div className="vb-tool-card-section">
              <div className="vb-tool-card-section-label">
                {status === "error" ? "Error" : "Result"}
              </div>
              <pre
                dir="auto"
                className={`vb-tool-card-pre ${
                  status === "error" ? "vb-tool-card-pre-error" : ""
                }`}
              >
                {resultText || "(empty)"}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Collapsed view of N consecutive calls to the same tool. The head row
 * shows the friendly label and a `×N` count; expanding lists every call's
 * input and result so the user can inspect each one.
 *
 * Aggregate status: any in-flight call → running; otherwise any error → error;
 * otherwise success.
 */
function ToolCardGroup({
  name,
  blocks,
  results,
}: {
  name: string;
  blocks: Extract<ContentBlock, { type: "tool_use" }>[];
  results: Map<string, Extract<ContentBlock, { type: "tool_result" }>>;
}) {
  const [expanded, setExpanded] = useState(false);
  const friendly = friendlyForTool(name);

  const callStatuses: ToolStatus[] = blocks.map((b) => {
    const r = results.get(b.id);
    if (!r) return "running";
    return r.is_error ? "error" : "success";
  });
  const aggregateStatus: ToolStatus = callStatuses.includes("running")
    ? "running"
    : callStatuses.includes("error")
      ? "error"
      : "success";

  return (
    <div className="vb-tool-card">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="vb-tool-card-head"
        aria-expanded={expanded}
      >
        <StatusIndicator status={aggregateStatus} />
        <span className="vb-tool-card-emoji" aria-hidden>
          {friendly.emoji}
        </span>
        <span
          className={`vb-tool-card-label ${
            aggregateStatus === "running" ? "vb-tool-card-label-shimmer" : ""
          }`}
        >
          {friendly.label}
        </span>
        <span className="ml-1 rounded-full bg-(--color-panel-soft) px-1.5 py-0.5 font-mono text-[10px] font-medium text-(--color-muted)">
          ×{blocks.length}
        </span>
        <span className="vb-tool-card-chev" aria-hidden>
          {expanded ? "▾" : "▸"}
        </span>
      </button>
      {expanded && (
        <div className="vb-tool-card-body space-y-3">
          {blocks.map((block, idx) => {
            const result = results.get(block.id);
            const status = callStatuses[idx];
            const resultText = extractResultText(result);
            return (
              <div
                key={block.id}
                className="rounded-md border border-(--color-border)/60 bg-(--color-panel)/60 p-2"
              >
                <div className="mb-1.5 flex items-center gap-2 text-[10px] font-mono uppercase tracking-widest text-(--color-muted)">
                  <StatusIndicator status={status} />
                  <span>Call {idx + 1}</span>
                </div>
                {block.input !== undefined && (
                  <div className="vb-tool-card-section">
                    <div className="vb-tool-card-section-label">Input</div>
                    <pre dir="auto" className="vb-tool-card-pre">
                      {JSON.stringify(block.input, null, 2)}
                    </pre>
                  </div>
                )}
                {resultText !== null && (
                  <div className="vb-tool-card-section">
                    <div className="vb-tool-card-section-label">
                      {status === "error" ? "Error" : "Result"}
                    </div>
                    <pre
                      dir="auto"
                      className={`vb-tool-card-pre ${
                        status === "error" ? "vb-tool-card-pre-error" : ""
                      }`}
                    >
                      {resultText || "(empty)"}
                    </pre>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
