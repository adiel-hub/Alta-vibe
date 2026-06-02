/**
 * Ephemeral live-call position state, kept OUT of useAgentStore on purpose.
 *
 * The header `TestCallButton` writes here (per spoken turn) and the Workflow
 * canvas — a different React subtree — reads here, with no shared ancestor.
 * A dedicated zustand store gives cross-subtree reads with surgical
 * subscriptions, and keeps high-frequency call churn from re-rendering the
 * config-driven canvas on every event.
 *
 * The workflow graph is SNAPSHOTTED at `start()` so a mid-call Alta edit can't
 * desync the node ids the engine is committed to.
 */
import { create } from "zustand";
import type { WorkflowState } from "@/types/agent";
import { createInitialState, reduce } from "@/lib/callMonitor/callPositionEngine";
import type {
  CallConfidence,
  CallStatus,
  EngineEvent,
} from "@/lib/callMonitor/types";

type CallMonitorState = {
  status: CallStatus;
  conversationId: string | null;
  activeNodeId: string | null;
  visited: string[];
  confidence: CallConfidence;
  /** Frozen graph snapshot for the active call. */
  workflow: WorkflowState | null;

  /** Seed the engine at the start node and freeze the graph. Call before startSession. */
  start: (workflow: WorkflowState) => void;
  setConversationId: (id: string) => void;
  ingest: (event: EngineEvent) => void;
  /** Back to idle; clears the trail. */
  reset: () => void;
};

const IDLE = {
  status: "idle" as CallStatus,
  conversationId: null,
  activeNodeId: null,
  visited: [] as string[],
  confidence: "exact" as CallConfidence,
  workflow: null,
};

export const useCallMonitorStore = create<CallMonitorState>((set, get) => ({
  ...IDLE,

  start: (workflow) =>
    set({ ...IDLE, workflow, ...createInitialState(workflow) }),

  setConversationId: (id) => set({ conversationId: id }),

  ingest: (event) => {
    const { workflow } = get();
    if (!workflow) return;
    const next = reduce(
      {
        activeNodeId: get().activeNodeId,
        visited: get().visited,
        status: get().status,
        confidence: get().confidence,
      },
      event,
      { workflow },
    );
    set(next);
  },

  reset: () => set({ ...IDLE }),
}));
