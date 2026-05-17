import Anthropic from "@anthropic-ai/sdk";
import { listVoices } from "./elevenlabs/client";

export type AgentSeed = {
  name: string;
  first_message: string;
  system_prompt: string;
  voice_id: string;
};

const DEFAULT_VOICE_FALLBACK = "21m00Tcm4TlvDq8ikWAM"; // ElevenLabs default "Rachel"

const SEED_SYSTEM = `You convert a one-paragraph product description into a starter
ElevenLabs voice-agent configuration. Output via the provided tool, no prose.
Keep "name" short (2-4 words). The first message should greet the caller in
1-2 sentences. The system prompt should establish the agent's role, tone,
boundaries, and what it can help with — 4-8 sentences.`;

const seedTool = {
  name: "create_initial_agent",
  description: "Emit the starter ElevenLabs voice-agent configuration.",
  input_schema: {
    type: "object" as const,
    properties: {
      name: { type: "string" },
      first_message: { type: "string" },
      system_prompt: { type: "string" },
    },
    required: ["name", "first_message", "system_prompt"],
  },
};

export async function seedAgentFromDescription(
  description: string,
): Promise<AgentSeed> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  const client = new Anthropic({ apiKey });

  const result = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: SEED_SYSTEM,
    tools: [seedTool],
    tool_choice: { type: "tool", name: seedTool.name },
    messages: [{ role: "user", content: description.slice(0, 4_000) }],
  });

  const block = result.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") {
    throw new Error("Seed model returned no tool_use block");
  }
  const input = block.input as {
    name: string;
    first_message: string;
    system_prompt: string;
  };

  let voiceId = DEFAULT_VOICE_FALLBACK;
  try {
    const voices = await listVoices();
    if (voices[0]) voiceId = voices[0].voice_id;
  } catch {
    // fall back to hard-coded default if voice listing fails
  }

  return {
    name: input.name,
    first_message: input.first_message,
    system_prompt: input.system_prompt,
    voice_id: voiceId,
  };
}
