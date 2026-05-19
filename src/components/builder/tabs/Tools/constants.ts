import type { RuntimePhase } from "@/types/agent";

export const PHASES: { id: RuntimePhase; label: string }[] = [
  { id: "pre_call", label: "Pre-Call" },
  { id: "in_call", label: "In-Call" },
  { id: "post_call", label: "Post-Call" },
];

export const PHASE_HINTS: Record<RuntimePhase, string> = {
  pre_call:
    "Run before the agent greets the caller — e.g. look up caller history, decide which greeting to use.",
  in_call:
    "Run during the conversation — fetch data, take action, trigger workflows.",
  post_call:
    "Run after the call ends — log to CRM, send a summary email, file a ticket.",
};
