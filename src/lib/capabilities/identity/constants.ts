/**
 * Identity-related constants shared between server-only capability code
 * and client modules (the agent store, the Persona/Voice tabs).
 *
 * Kept in its own file so client bundles can read these without pulling in
 * `@anthropic-ai/claude-agent-sdk`, which is Node-only and breaks the
 * browser build.
 */

export const STARTER_NAME = "New voice agent";
export const STARTER_FIRST_MESSAGE = "Hi! How can I help today?";
export const STARTER_SYSTEM_PROMPT =
  "You are a helpful voice agent. Be friendly, concise, and proactive.";
