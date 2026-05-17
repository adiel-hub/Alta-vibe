"use client";

import { create } from "zustand";
import type {
  AgentConfigCache,
  AgentDTO,
  ContentBlock,
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
  | "limits";

export type ChatTurn = {
  id: string;
  role: "user" | "assistant";
  content: ContentBlock[];
};

type State = {
  agent: AgentDTO | null;
  config: AgentConfigCache | null;
  revision: number;
  inFlight: Set<SectionKey>;
  errors: Record<string, string>;
  turns: ChatTurn[];
  streaming: { id: string; text: string } | null;
  activeJobId: string | null;
  activeAssistantTurnId: string | null;
  lastSeq: number;
};

type Actions = {
  hydrate: (agent: AgentDTO, turns: ChatTurn[]) => void;
  applyPatch: (revision: number, patch: Partial<AgentConfigCache>) => void;
  applyConfigDirect: (patch: Partial<AgentConfigCache>, revision: number) => void;
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
};

export const useAgentStore = create<State & Actions>((set) => ({
  agent: null,
  config: null,
  revision: 0,
  inFlight: new Set(),
  errors: {},
  turns: [],
  streaming: null,
  activeJobId: null,
  activeAssistantTurnId: null,
  lastSeq: -1,

  hydrate: (agent, turns) =>
    set({
      agent,
      config: agent.config_cache,
      revision: agent.revision,
      turns,
      streaming: null,
      inFlight: new Set(),
      errors: {},
      activeJobId: null,
      activeAssistantTurnId: null,
      lastSeq: -1,
    }),

  applyPatch: (revision, patch) =>
    set((s) => {
      if (!s.config) return s;
      if (revision <= s.revision) return s;
      const merged: AgentConfigCache = { ...s.config, ...patch };
      return { config: merged, revision };
    }),

  applyConfigDirect: (patch, revision) =>
    set((s) => {
      if (!s.config) return s;
      const merged: AgentConfigCache = { ...s.config, ...patch };
      return { config: merged, revision: Math.max(s.revision, revision) };
    }),

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
      if (!s.streaming) return { streaming: { id, text } };
      if (s.streaming.id !== id)
        return { streaming: { id, text: s.streaming.text + text } };
      return { streaming: { id, text: s.streaming.text + text } };
    }),

  appendToolCallStart: (turnId, toolUseId, name, input) =>
    set((s) => {
      const idx = s.turns.findIndex((t) => t.id === turnId);
      const block: ContentBlock = {
        type: "tool_use",
        id: toolUseId,
        name,
        input,
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
}));
