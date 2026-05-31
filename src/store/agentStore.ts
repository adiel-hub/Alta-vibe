"use client";

import { create } from "zustand";
import type {
  AgentConfigCache,
  AgentDTO,
  ContentBlock,
  RuntimePhase,
  WidgetKind,
} from "@/types/agent";
import {
  STARTER_FIRST_MESSAGE,
  STARTER_NAME,
  STARTER_SYSTEM_PROMPT,
} from "@/lib/capabilities/identity/constants";
/**
 * Each identity field (name, first_message, system_prompt) is "authored"
 * once its value differs from the bootstrap default. While a builder turn
 * is running and a field is still pristine, the Persona tab and chat
 * header swap that field for a skeleton. The flags are sticky — once
 * flipped true, they stay true for the session, so subsequent edits never
 * re-skeleton.
 *
 * Legacy: pre-refactor HubSpot connects auto-injected a caller-context
 * block bounded by HTML-comment markers. The block is no longer injected,
 * but agents created before the refactor may still carry it in their
 * stored prompt — strip it before comparing so we don't false-positive
 * "authored" on otherwise-pristine starters.
 */
const LEGACY_CALLER_CTX_BLOCK =
  /\n*<!-- alta:caller_context:start -->[\s\S]*?<!-- alta:caller_context:end -->\n*/g;

function stripLegacyCallerContextBlock(prompt: string): string {
  return prompt.replace(LEGACY_CALLER_CTX_BLOCK, "\n").replace(/\n{3,}/g, "\n\n");
}

function isSystemPromptAuthored(prompt: string | undefined): boolean {
  if (!prompt) return false;
  return stripLegacyCallerContextBlock(prompt).trim() !== STARTER_SYSTEM_PROMPT;
}

function isNameAuthored(name: string | undefined): boolean {
  if (!name) return false;
  return name.trim() !== STARTER_NAME;
}

function isFirstMessageAuthored(msg: string | undefined): boolean {
  if (msg === undefined) return false;
  return msg.trim() !== STARTER_FIRST_MESSAGE.trim();
}

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
  /** For orphan widgets (no tool_use_id) only: id of the turn this widget
   * was created right after. ChatPanel renders the widget immediately
   * below that turn, so a subsequent user message lands BELOW the widget
   * at the true bottom of the chat instead of getting visually shoved up
   * by a still-pinned widget. */
  after_turn_id?: string;
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
  /** Stamped each time `applyPatch` lands a `tools` patch that contains a
   *  previously-unseen tool id. The Tools tab watches this and switches its
   *  phase sub-tab to match, so when Alta creates a post-call webhook the
   *  user lands on Post-Call instead of whatever phase was open before.
   *  Renames/deletes don't bump it; only new ids do. */
  pendingToolFocus: { phase: RuntimePhase; at: number } | null;
  /** Bumped each time `applyPatch` lands a patch that touches any
   *  voice-tab field (`voice_id`, `language`, `voice_settings`, `llm`,
   *  `temperature`, `max_duration_seconds`). The Voice tab watches this
   *  counter and replays its staged-skeleton reveal on every bump, so
   *  every Alta voice update animates the whole tab the same way the
   *  first-turn build does. NOT bumped by `applyConfigDirect` — user
   *  slider drags shouldn't re-animate. */
  voiceRevealToken: number;
  /** True once the agent name has been authored — i.e. it differs from
   *  the bootstrap default. The chat header shows a skeleton instead of
   *  the name while this is false and a builder turn is active. */
  nameAuthored: boolean;
  /** True once the first_message (greeting) has been authored. The
   *  Persona tab shows a skeleton while this is false and a builder
   *  turn is active. */
  firstMessageAuthored: boolean;
  /** True once the system prompt has been authored — i.e. it differs from
   *  the starter template (caller-context block ignored). The Persona tab
   *  shows a skeleton instead of the textarea while this is false and a
   *  builder turn is active, so the user doesn't see the bootstrap text
   *  flicker before Alta writes the real prompt. */
  systemPromptAuthored: boolean;
  /** True for the lifetime of the very first builder turn. Sticky — doesn't
   *  flip when intermediate patches land, only when the first assistant
   *  turn finalizes. Drives the Voice tab's staged "build animation" so
   *  every field reveals/animates even ones Alta doesn't actually touch
   *  (sliders, llm, max duration). Seeded at hydrate by checking whether
   *  the system prompt is still the bootstrap. */
  isFirstBuild: boolean;
};

type Actions = {
  hydrate: (
    agent: AgentDTO,
    turns: ChatTurn[],
    widgets?: WidgetEntry[],
  ) => void;
  applyPatch: (revision: number, patch: Partial<AgentConfigCache>) => void;
  applyConfigDirect: (patch: Partial<AgentConfigCache>, revision: number) => void;
  /** Apply a live-streamed partial value for one of the persona fields.
   *  Updates config[field] and flips the matching authored flag so the
   *  skeleton clears as soon as the first character lands. Does NOT bump
   *  revision — the canonical state_patch arrives when the tool completes
   *  and rebumps then. */
  applyToolInputPartial: (
    field: "name" | "first_message" | "system_prompt",
    value: string,
  ) => void;
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
  liveTool: null,
  lastActiveSection: null,
  kbPendingAnimationIds: new Set(),
  evalPendingAnimationIds: new Set(),
  dataPendingAnimationIds: new Set(),
  pendingToolFocus: null,
  voiceRevealToken: 0,
  nameAuthored: false,
  firstMessageAuthored: false,
  systemPromptAuthored: false,
  isFirstBuild: false,

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
      liveTool: null,
      // Page load / agent switch: docs are already there, no animation.
      kbPendingAnimationIds: new Set(),
      evalPendingAnimationIds: new Set(),
      dataPendingAnimationIds: new Set(),
      pendingToolFocus: null,
      voiceRevealToken: 0,
      nameAuthored: isNameAuthored(agent.config_cache?.name),
      firstMessageAuthored: isFirstMessageAuthored(
        agent.config_cache?.first_message,
      ),
      systemPromptAuthored: isSystemPromptAuthored(
        agent.config_cache?.system_prompt,
      ),
      isFirstBuild: !isSystemPromptAuthored(agent.config_cache?.system_prompt),
    }),

  applyPatch: (revision, patch) =>
    set((s) => {
      if (!s.config) return s;
      if (revision <= s.revision) return s;
      const touchesVoiceTab =
        patch.voice_id !== undefined ||
        patch.language !== undefined ||
        patch.voice_settings !== undefined ||
        patch.llm !== undefined ||
        patch.temperature !== undefined ||
        patch.max_duration_seconds !== undefined;
      const voiceRevealToken = touchesVoiceTab
        ? s.voiceRevealToken + 1
        : s.voiceRevealToken;
      console.debug("[voice-anim] applyPatch", {
        revision,
        patchKeys: Object.keys(patch),
        touchesVoiceTab,
        prevToken: s.voiceRevealToken,
        nextToken: voiceRevealToken,
      });
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
      const newToolPhase = newestToolPhase(s.config.tools, patch.tools);
      const pendingToolFocus = newToolPhase
        ? { phase: newToolPhase, at: Date.now() }
        : s.pendingToolFocus;
      // Keep the AgentDTO mirror in sync — agent.name is the top-level
      // name shown in the agent picker, but the source of truth for
      // edits flows through config_cache.name. Without this, renaming
      // the agent from chat leaves the picker showing the old name.
      const nextAgent =
        patch.name !== undefined && s.agent && s.agent.name !== patch.name
          ? { ...s.agent, name: patch.name }
          : s.agent;
      const nameAuthored =
        s.nameAuthored ||
        (patch.name !== undefined && isNameAuthored(patch.name));
      const firstMessageAuthored =
        s.firstMessageAuthored ||
        (patch.first_message !== undefined &&
          isFirstMessageAuthored(patch.first_message));
      const systemPromptAuthored =
        s.systemPromptAuthored ||
        (patch.system_prompt !== undefined &&
          isSystemPromptAuthored(patch.system_prompt));
      return {
        config: merged,
        revision,
        kbPendingAnimationIds,
        evalPendingAnimationIds,
        dataPendingAnimationIds,
        pendingToolFocus,
        voiceRevealToken,
        agent: nextAgent,
        nameAuthored,
        firstMessageAuthored,
        systemPromptAuthored,
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
      // User-driven saves always count as authored, even if the typed text
      // happens to match the starter — the user explicitly chose it.
      const nameAuthored = s.nameAuthored || patch.name !== undefined;
      const firstMessageAuthored =
        s.firstMessageAuthored || patch.first_message !== undefined;
      const systemPromptAuthored =
        s.systemPromptAuthored || patch.system_prompt !== undefined;
      return {
        config: merged,
        revision: Math.max(s.revision, revision),
        kbPendingAnimationIds,
        evalPendingAnimationIds,
        dataPendingAnimationIds,
        nameAuthored,
        firstMessageAuthored,
        systemPromptAuthored,
      };
    }),

  applyToolInputPartial: (field, value) =>
    set((s) => {
      if (!s.config) return s;
      const merged: AgentConfigCache = { ...s.config, [field]: value };
      const nextAgent =
        field === "name" && s.agent && s.agent.name !== value
          ? { ...s.agent, name: value }
          : s.agent;
      return {
        config: merged,
        agent: nextAgent,
        ...(field === "name" ? { nameAuthored: true } : {}),
        ...(field === "first_message" ? { firstMessageAuthored: true } : {}),
        ...(field === "system_prompt" ? { systemPromptAuthored: true } : {}),
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
    set((s) => ({
      activeJobId: jobId,
      activeAssistantTurnId: assistantTurnId,
      lastSeq: jobId ? 0 : -1,
      // First builder turn just ended → drop the build-animation flag so
      // any future turn (user edits) doesn't replay the staged Voice-tab
      // reveal.
      isFirstBuild: jobId === null ? false : s.isFirstBuild,
    })),

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
 * Identify the phase of the newest tool in a `tools` patch — the one whose
 * id wasn't in the previous list. Returns null when the patch doesn't touch
 * tools or only renames/deletes existing ones.
 *
 * Why: when Alta creates a post-call webhook the user should land on the
 *      Post-Call sub-tab; without this the Tools tab opens on whatever
 *      phase was last selected.
 * When multiple new ids appear in one patch the last one wins — the model
 * emits tool_use blocks sequentially and the last is the most-recently-
 * authored, which is the one the user is reading about.
 */
function newestToolPhase(
  prev: AgentConfigCache["tools"] | undefined,
  patchTools: AgentConfigCache["tools"] | undefined,
): RuntimePhase | null {
  if (!patchTools) return null;
  const prevIds = new Set((prev ?? []).map((t) => t.id));
  let phase: RuntimePhase | null = null;
  for (const t of patchTools) {
    if (prevIds.has(t.id)) continue;
    phase = t.phase;
  }
  return phase;
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

