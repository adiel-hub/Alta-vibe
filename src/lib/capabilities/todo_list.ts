import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import type { Capability } from "./types";
import { runToolStep } from "./types";
import type { TodoItem } from "@/types/agent";

const TodoItemSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(60)
    .describe(
      "Stable kebab-case handle for this item (e.g. 'persona', 'workflow'). Used so re-issuing the list preserves animation continuity.",
    ),
  label: z
    .string()
    .min(1)
    .max(120)
    .describe(
      "Short user-facing description of the step, in the user's language (e.g. 'Set up persona', 'Design the workflow').",
    ),
  status: z
    .enum(["pending", "in_progress", "completed"])
    .describe(
      "Current state of the item. At most one item should be in_progress at a time.",
    ),
});

export const todoListCapability: Capability = {
  id: "todo_list",
  label: "Todo list",
  defaultSlice: () => ({ todo_list: [] }),
  tools: (ctx) => [
    tool(
      "update_todo_list",
      "Replace the visible plan-of-action card shown above the chat. Use this at the START of any multi-step task (especially the first agent-creation turn) to lay out what you're going to do, then call it again after each step to mark it 'completed' and the next one 'in_progress'. Pass the FULL list every time — this is a replace, not a patch. Pass an empty array to clear the card once the whole plan is done.",
      {
        todos: z
          .array(TodoItemSchema)
          .max(20)
          .describe(
            "Full ordered list of plan items. Replaces the previous list. Send [] to hide the card.",
          ),
      },
      async ({ todos }) =>
        runToolStep(ctx, "todo_list", "update_todo_list", async () => {
          const next: TodoItem[] = todos.map((t) => ({
            id: t.id,
            label: t.label,
            status: t.status,
          }));
          const completed = next.filter((t) => t.status === "completed").length;
          const inProgress = next.filter((t) => t.status === "in_progress")
            .length;
          const summary =
            next.length === 0
              ? "Cleared the plan card."
              : `Plan: ${completed}/${next.length} done${inProgress ? `, ${inProgress} in progress` : ""}.`;
          return { patch: { todo_list: next }, summary };
        }),
    ),
  ],
};
