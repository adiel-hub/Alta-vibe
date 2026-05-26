import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import type { Capability } from "../types";
import { runToolStep } from "../types";
import { STARTER_SYSTEM_PROMPT } from "./constants";

export const identityCapability: Capability = {
  id: "identity",
  label: "Identity",
  defaultSlice: () => ({
    name: "Untitled voice agent",
    first_message: "Hi! How can I help today?",
    system_prompt: STARTER_SYSTEM_PROMPT,
  }),
  tools: (ctx) => [
    tool(
      "update_agent_name",
      "Set the agent's display name (short, 2-5 words).",
      { name: z.string().min(1).max(80) },
      async ({ name }) =>
        runToolStep(ctx, "name", "update_agent_name", async () => ({
          patch: { name },
          upstreamPatch: { name },
          summary: `Renamed agent to "${name}".`,
        })),
    ),
    tool(
      "update_first_message",
      "Set the agent's opening line played when a call connects.",
      { first_message: z.string().min(1).max(500) },
      async ({ first_message }) =>
        runToolStep(ctx, "first_message", "update_first_message", async () => ({
          patch: { first_message },
          upstreamPatch: { first_message },
          summary: "Updated first message.",
        })),
    ),
    tool(
      "update_system_prompt",
      "Replace the agent's full system prompt. Provide the entire new prompt; this is not a diff. Include behaviour, tone, escalation rules, and (if a workflow exists) reference to the workflow nodes.",
      { system_prompt: z.string().min(20).max(20_000) },
      async ({ system_prompt }) =>
        runToolStep(ctx, "system_prompt", "update_system_prompt", async () => ({
          patch: { system_prompt },
          upstreamPatch: { system_prompt },
          summary: "Updated system prompt.",
        })),
    ),
  ],
};
