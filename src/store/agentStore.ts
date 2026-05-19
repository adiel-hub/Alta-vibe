"use client";

import { create } from "zustand";
import type {
  AgentConfigCache,
  AgentDTO,
  ContentBlock,
  WidgetKind,
} from "@/types/agent";

export type SectionKey =
  | "name"
  | "first_message"
  | "system_prompt"
  | "voice"
  | "llm"
  | "knowledge_base"
  | "tools"
  | "mcp"
  | "data"
  | "evaluation"
  | "phone"
  | "limits"
  | "workflow"
  | "integrations"
  | "turn";

export type ChatTurn = {
  id: string;
  role: "user" | "assistant" | "system";
  content: ContentBlock[];
};

export type WidgetEntry = {
  action_id: string;
  kind: WidgetKind;
  payload: unknown;
  status: "pending" | "done" | "cancelled" | "failed";
  result: unknown;
  /** tool_use_id of the request_user_action call that produced this widget.
   * Set by the SSE client when widget_inserted follows tool_call_start.
   * ChatPanel uses this for an O(1) lookup; payload-equality is the legacy
   * fallback for widgets persisted before this field existed. */
  tool_use_id?: string;
};

export type LiveTool = {
  tool_use_id: string;
  raw_name: string;
  emoji: string;
  label: string;
  status: "running" | "success" | "error";
  error_message?: string;
  /** ms timestamp when status switched to terminal — used by UI to fade out. */
  finished_at?: number;
};

type State = {
  agent: AgentDTO | null;
  config: AgentConfigCache | null;
  revision: number;
  /**
   * Cached `agtvrsn_…` id of the version currently applied to the agent.
   * Updated on hydrate from the DTO and by the version-history panel after
   * a successful restore. The panel falls back to highlighting the topmost
   * (newest) version row when this is null.
   */
  currentVersionId: string | null;
  inFlight: Set<SectionKey>;
  errors: Record<string, string>;
  turns: ChatTurn[];
  streaming: { id: string; text: string } | null;
  activeJobId: string | null;
  activeAssistantTurnId: string | null;
  lastSeq: number;
  widgets: Record<string, WidgetEntry>;
  /** Workflow node currently active during a live test call. */
  liveWorkflowNodeId: string | null;
  /** Single morphing tool-status pill rendered in the chat. */
  liveTool: LiveTool | null;
  /** Most-recent section a tool touched. Bumped each call so panel can auto-focus. */
  lastActiveSection: { key: SectionKey; at: number } | null;
  /** Knowledge-base document ids that arrived *via tool execution* and
   *  haven't been visually "introduced" yet — drives the typewriter on
   *  KB cards. Empty on hydrate so opening the KB tab on a fresh load
   *  doesn't replay animations the user already saw. */
  kbPendingAnimationIds: Set<string>;
  /** Same idea for call outcomes (evaluation criteria) — populated when
   *  add_call_outcome / update_call_outcome / remove_call_outcome cause
   *  a patch with a previously-unseen criterion id. */
  evalPendingAnimationIds: Set<string>;
  /** Same idea for data-extraction fields — populated when a patch lands
   *  a previously-unseen data_collection field id (agent-created via the
   *  add_data_field tool). */
  dataPendingAnimationIds: Set<string>;
};

type Actions = {
  hydrate: (
    agent: AgentDTO,
    turns: ChatTurn[],
    widgets?: WidgetEntry[],
  ) => void;
  applyPatch: (revision: number, patch: Partial<AgentConfigCache>) => void;
  applyConfigDirect: (patch: Partial<AgentConfigCache>, revision: number) => void;
  setCurrentVersionId: (versionId: string | null) => void;
  setInFlight: (section: SectionKey, busy: boolean) => void;
  setError: (section: string, message: string | null) => void;
  appendUserTurn: (id: string, text: string) => void;
  appendAssistantDelta: (id: string, text: string) => void;
  appendToolCallStart: (
    turnId: string,
    toolUseId: string,
    name: string,
    input: unknown,
  ) => void;
  appendToolCallResult: (
    turnId: string,
    toolUseId: string,
    output: unknown,
    isError?: boolean,
  ) => void;
  finalizeAssistantTurn: () => void;
  setActiveTurn: (jobId: string | null, assistantTurnId: string | null) => void;
  setLastSeq: (seq: number) => void;
  upsertWidget: (w: WidgetEntry) => void;
  resolveWidget: (
    actionId: string,
    status: "done" | "cancelled" | "failed",
    result: unknown,
  ) => void;
  setLiveWorkflowNode: (nodeId: string | null) => void;
  setLiveTool: (live: LiveTool | null) => void;
  bumpActiveSection: (key: SectionKey) => void;
  markKbAnimationDone: (id: string) => void;
  markEvalAnimationDone: (id: string) => void;
  markDataAnimationDone: (id: string) => void;
};

export const useAgentStore = create<State & Actions>((set) => ({
  agent: null,
  config: null,
  revision: 0,
  currentVersionId: null,
  inFlight: new Set(),
  errors: {},
  turns: [],
  streaming: null,
  activeJobId: null,
  activeAssistantTurnId: null,
  lastSeq: -1,
  widgets: {},
  liveWorkflowNodeId: null,
  liveTool: null,
  lastActiveSection: null,
  kbPendingAnimationIds: new Set(),
  evalPendingAnimationIds: new Set(),
  dataPendingAnimationIds: new Set(),

  hydrate: (agent, turns, widgets) =>
    set({
      agent,
      config: agent.config_cache,
      revision: agent.revision,
      currentVersionId: agent.current_version_id ?? null,
      turns,
      streaming: null,
      inFlight: new Set(),
      errors: {},
      activeJobId: null,
      activeAssistantTurnId: null,
      lastSeq: -1,
      widgets: Object.fromEntries((widgets ?? []).map((w) => [w.action_id, w])),
      liveWorkflowNodeId: null,
      liveTool: null,
      // Page load / agent switch: docs are already there, no animation.
      kbPendingAnimationIds: new Set(),
      evalPendingAnimationIds: new Set(),
      dataPendingAnimationIds: new Set(),
    }),

  applyPatch: (revision, patch) =>
    set((s) => {
      if (!s.config) return s;
      if (revision <= s.revision) return s;
      const merged: AgentConfigCache = { ...s.config, ...patch };
      const kbPendingAnimationIds = diffKbForAnimation(
        s.config.knowledge_base,
        patch.knowledge_base,
        s.kbPendingAnimationIds,
      );
      const evalPendingAnimationIds = diffEvalForAnimation(
        s.config.evaluation_criteria,
        patch.evaluation_criteria,
        s.evalPendingAnimationIds,
      );
      const dataPendingAnimationIds = diffDataForAnimation(
        s.config.data_collection,
        patch.data_collection,
        s.dataPendingAnimationIds,
      );
      // Keep the AgentDTO mirror in sync — agent.name is the top-level
      // name shown in the agent picker, but the source of truth for
      // edits flows through config_cache.name. Without this, renaming
      // the agent from chat leaves the picker showing the old name.
      const nextAgent =
        patch.name !== undefined && s.agent && s.agent.name !== patch.name
          ? { ...s.agent, name: patch.name }
          : s.agent;
      return {
        config: merged,
        revision,
        kbPendingAnimationIds,
        evalPendingAnimationIds,
        dataPendingAnimationIds,
        agent: nextAgent,
      };
    }),

  applyConfigDirect: (patch, revision) =>
    set((s) => {
      if (!s.config) return s;
      const merged: AgentConfigCache = { ...s.config, ...patch };
      const kbPendingAnimationIds = diffKbForAnimation(
        s.config.knowledge_base,
        patch.knowledge_base,
        s.kbPendingAnimationIds,
      );
      const evalPendingAnimationIds = diffEvalForAnimation(
        s.config.evaluation_criteria,
        patch.evaluation_criteria,
        s.evalPendingAnimationIds,
      );
      const dataPendingAnimationIds = diffDataForAnimation(
        s.config.data_collection,
        patch.data_collection,
        s.dataPendingAnimationIds,
      );
      return {
        config: merged,
        revision: Math.max(s.revision, revision),
        kbPendingAnimationIds,
        evalPendingAnimationIds,
        dataPendingAnimationIds,
      };
    }),

  setCurrentVersionId: (versionId) => set({ currentVersionId: versionId }),

  setInFlight: (section, busy) =>
    set((s) => {
      const next = new Set(s.inFlight);
      if (busy) next.add(section);
      else next.delete(section);
      return { inFlight: next };
    }),

  setError: (section, message) =>
    set((s) => {
      const next = { ...s.errors };
      if (message) next[section] = message;
      else delete next[section];
      return { errors: next };
    }),

  appendUserTurn: (id, text) =>
    set((s) => ({
      turns: [...s.turns, { id, role: "user", content: [{ type: "text", text }] }],
      streaming: { id: `${id}:asst`, text: "" },
    })),

  appendAssistantDelta: (id, text) =>
    set((s) => {
      if (!s.streaming || s.streaming.id !== id) return { streaming: { id, text } };
      return { streaming: { id, text: s.streaming.text + text } };
    }),

  appendToolCallStart: (turnId, toolUseId, name, input) =>
    set((s) => {
      const idx = s.turns.findIndex((t) => t.id === turnId);
      const toolBlock: ContentBlock = {
        type: "tool_use",
        id: toolUseId,
        name,
        input,
      };

      // Flush any pending streaming text into its own block BEFORE the
      // tool_use. Without this, pre-tool prose and post-tool prose end up
      // concatenated into a single text block (the model emits "…knowledge
      // base." → tools run → "Cover is a Hebrew…" and we get the smushed
      // "knowledge base.Cover" rendering). Reset the buffer so the post-
      // tool deltas start a fresh paragraph.
      const pending =
        s.streaming && s.streaming.text.trim().length > 0
          ? s.streaming.text
          : null;
      const newStreaming =
        pending && s.streaming ? { ...s.streaming, text: "" } : s.streaming;

      const toAppend: ContentBlock[] = pending
        ? [{ type: "text", text: pending }, toolBlock]
        : [toolBlock];

      if (idx === -1) {
        return {
          streaming: newStreaming,
          turns: [
            ...s.turns,
            { id: turnId, role: "assistant", content: toAppend },
          ],
        };
      }
      const turn = s.turns[idx];
      const next = { ...turn, content: [...turn.content, ...toAppend] };
      const turns = [...s.turns];
      turns[idx] = next;
      return { streaming: newStreaming, turns };
    }),

  appendToolCallResult: (turnId, toolUseId, output, isError) =>
    set((s) => {
      const idx = s.turns.findIndex((t) => t.id === turnId);
      const block: ContentBlock = {
        type: "tool_result",
        tool_use_id: toolUseId,
        output,
        is_error: isError,
      };
      if (idx === -1) {
        return {
          turns: [
            ...s.turns,
            { id: turnId, role: "assistant", content: [block] },
          ],
        };
      }
      const turn = s.turns[idx];
      const next = { ...turn, content: [...turn.content, block] };
      const turns = [...s.turns];
      turns[idx] = next;
      return { turns };
    }),

  finalizeAssistantTurn: () =>
    set((s) => {
      if (!s.streaming) return { streaming: null };
      const id = s.streaming.id;
      const text = s.streaming.text;
      if (!text) return { streaming: null };
      const idx = s.turns.findIndex((t) => t.id === id);
      const block: ContentBlock = { type: "text", text };
      if (idx === -1) {
        return {
          streaming: null,
          turns: [
            ...s.turns,
            { id, role: "assistant", content: [block] },
          ],
        };
      }
      const turn = s.turns[idx];
      const next = { ...turn, content: [...turn.content, block] };
      const turns = [...s.turns];
      turns[idx] = next;
      return { streaming: null, turns };
    }),

  setActiveTurn: (jobId, assistantTurnId) =>
    set({
      activeJobId: jobId,
      activeAssistantTurnId: assistantTurnId,
      lastSeq: jobId ? 0 : -1,
    }),

  setLastSeq: (seq) => set({ lastSeq: seq }),

  upsertWidget: (w) =>
    set((s) => ({ widgets: { ...s.widgets, [w.action_id]: w } })),

  resolveWidget: (actionId, status, result) =>
    set((s) => {
      const existing = s.widgets[actionId];
      if (!existing) return s;
      return {
        widgets: {
          ...s.widgets,
          [actionId]: { ...existing, status, result },
        },
      };
    }),

  setLiveWorkflowNode: (nodeId) => set({ liveWorkflowNodeId: nodeId }),

  setLiveTool: (live) => set({ liveTool: live }),

  bumpActiveSection: (key) => set({ lastActiveSection: { key, at: Date.now() } }),

  markKbAnimationDone: (id) =>
    set((s) => {
      if (!s.kbPendingAnimationIds.has(id)) return s;
      const next = new Set(s.kbPendingAnimationIds);
      next.delete(id);
      return { kbPendingAnimationIds: next };
    }),

  markEvalAnimationDone: (id) =>
    set((s) => {
      if (!s.evalPendingAnimationIds.has(id)) return s;
      const next = new Set(s.evalPendingAnimationIds);
      next.delete(id);
      return { evalPendingAnimationIds: next };
    }),

  markDataAnimationDone: (id) =>
    set((s) => {
      if (!s.dataPendingAnimationIds.has(id)) return s;
      const next = new Set(s.dataPendingAnimationIds);
      next.delete(id);
      return { dataPendingAnimationIds: next };
    }),
}));

/**
 * Compute the next pending-animation set when a patch arrives. Any doc id
 * that's in the patch but wasn't in the previous knowledge_base is "newly
 * created by a tool" and should typewriter-in. Existing ids in the pending
 * set are preserved so an animation queued earlier still fires even if a
 * second patch lands before the user opens the KB tab.
 */
function diffKbForAnimation(
  prevKb: AgentConfigCache["knowledge_base"] | undefined,
  patchKb: AgentConfigCache["knowledge_base"] | undefined,
  current: Set<string>,
): Set<string> {
  if (!patchKb) return current;
  const prevIds = new Set((prevKb ?? []).map((d) => d.id));
  let next: Set<string> | null = null;
  for (const doc of patchKb) {
    if (prevIds.has(doc.id)) continue;
    if (current.has(doc.id)) continue;
    next ??= new Set(current);
    next.add(doc.id);
  }
  return next ?? current;
}

/**
 * Mirror of `diffKbForAnimation` for evaluation criteria. Any criterion id
 * in the patch that wasn't in the previous list is treated as "just added
 * by the agent" and queued for the typewriter on the Call outcomes tab.
 */
function diffEvalForAnimation(
  prev: AgentConfigCache["evaluation_criteria"] | undefined,
  patchCriteria: AgentConfigCache["evaluation_criteria"] | undefined,
  current: Set<string>,
): Set<string> {
  if (!patchCriteria) return current;
  const prevIds = new Set((prev ?? []).map((c) => c.id));
  let next: Set<string> | null = null;
  for (const c of patchCriteria) {
    if (prevIds.has(c.id)) continue;
    if (current.has(c.id)) continue;
    next ??= new Set(current);
    next.add(c.id);
  }
  return next ?? current;
}

/**
 * Mirror of `diffEvalForAnimation` for data-extraction fields. Any field id
 * in the patch that wasn't in the previous list is treated as "just added"
 * and queued for the typewriter on the Data extraction section.
 */
function diffDataForAnimation(
  prev: AgentConfigCache["data_collection"] | undefined,
  patchFields: AgentConfigCache["data_collection"] | undefined,
  current: Set<string>,
): Set<string> {
  if (!patchFields) return current;
  const prevIds = new Set((prev ?? []).map((f) => f.id));
  let next: Set<string> | null = null;
  for (const f of patchFields) {
    if (prevIds.has(f.id)) continue;
    if (current.has(f.id)) continue;
    next ??= new Set(current);
    next.add(f.id);
  }
  return next ?? current;
}
