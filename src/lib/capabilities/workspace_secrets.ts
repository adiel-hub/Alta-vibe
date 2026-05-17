import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import {
  createWorkspaceSecret,
  listWorkspaceSecrets,
} from "@/lib/elevenlabs/client";
import type { Capability } from "./types";

/**
 * Workspace-scoped secrets the runtime tools can reference as
 * `{{secret.NAME}}` in request_headers, body, or query params — keeps API
 * keys off the agent's prompt and out of conversation transcripts.
 *
 * Used by webhook runtime tools that need to authenticate against external
 * APIs (e.g. CRM, payments, custom integrations).
 */
export const workspaceSecretsCapability: Capability = {
  id: "secrets",
  label: "Workspace secrets",
  defaultSlice: () => ({}),
  tools: (_ctx) => [
    tool(
      "create_workspace_secret",
      "Store a named secret in the workspace for runtime tools to use. Reference it later in tool api_schema as `{{secret.NAME}}` in headers/body. The value is never echoed back — only the name + id.",
      {
        name: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[A-Z0-9_]+$/, "must be UPPER_SNAKE_CASE"),
        value: z.string().min(1).max(10_000),
      },
      async ({ name, value }) => {
        try {
          const { id } = await createWorkspaceSecret({ name, value });
          return {
            content: [
              {
                type: "text" as const,
                text: `Secret "${name}" stored (id=${id}). Reference it from webhook tools as {{secret.${name}}}.`,
              },
            ],
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : "Unknown error";
          return {
            content: [
              { type: "text" as const, text: `create_workspace_secret failed: ${message}` },
            ],
            isError: true,
          };
        }
      },
    ),

    tool(
      "list_workspace_secrets",
      "List secret names available in the workspace. Returns names + ids only — values are never readable.",
      {},
      async () => {
        try {
          const secrets = await listWorkspaceSecrets();
          return {
            content: [{ type: "text" as const, text: JSON.stringify(secrets) }],
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : "Unknown error";
          return {
            content: [
              { type: "text" as const, text: `list_workspace_secrets failed: ${message}` },
            ],
            isError: true,
          };
        }
      },
    ),
  ],
};
