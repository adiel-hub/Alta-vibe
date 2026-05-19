"use client";

import { useAgentStore } from "@/store/agentStore";
import type { TodoItem } from "@/types/agent";

/**
 * Stable empty-array sentinel. Returning `?? []` inline from a zustand
 * selector creates a fresh reference every render, which makes React's
 * useSyncExternalStore think the snapshot keeps changing and throws
 * "getServerSnapshot should be cached" with an infinite render loop.
 * Sharing one frozen array keeps the reference identity stable.
 */
const EMPTY_TODOS: readonly TodoItem[] = Object.freeze([]);

/**
 * Plan-of-action card the builder agent writes to via the update_todo_list
 * tool. Sits at the top of the chat so the user can watch the multi-step
 * build progress without scanning streamed tool pills.
 *
 * Hides itself entirely when the list is empty OR every item is completed —
 * a fully-finished card adds visual noise once the work is shipped.
 */
export function TodoListCard() {
  const todos = useAgentStore(
    (s) => (s.config?.todo_list as readonly TodoItem[] | undefined) ?? EMPTY_TODOS,
  );

  if (todos.length === 0) return null;
  const allDone = todos.every((t) => t.status === "completed");
  if (allDone) return null;

  const completed = todos.filter((t) => t.status === "completed").length;

  return (
    <section
      aria-label="Build plan"
      className="animate-fade-in mb-4 overflow-hidden rounded-xl border border-(--color-border) bg-(--color-panel) shadow-(--shadow-xs)"
    >
      <header className="flex items-center gap-2 border-b border-(--color-border) px-3 py-2">
        <span
          aria-hidden
          className="grid h-5 w-5 place-items-center rounded-md bg-(--color-accent)/10 text-(--color-accent)"
        >
          <ListIcon />
        </span>
        <h3 className="text-[12px] font-semibold text-(--color-foreground-strong)">
          Build plan
        </h3>
        <span className="ml-auto font-mono text-[10px] text-(--color-muted)">
          {completed}/{todos.length}
        </span>
      </header>
      <ul className="flex flex-col">
        {todos.map((t, i) => (
          <TodoRow key={t.id} item={t} index={i} />
        ))}
      </ul>
    </section>
  );
}

function TodoRow({ item, index }: { item: TodoItem; index: number }) {
  const isDone = item.status === "completed";
  const isActive = item.status === "in_progress";
  return (
    <li
      style={{ animationDelay: `${Math.min(index, 6) * 25}ms` }}
      className="animate-message-in flex items-center gap-2.5 px-3 py-1.5 transition"
    >
      <StatusIndicator status={item.status} />
      <span
        dir="auto"
        className={`flex-1 text-[12px] leading-snug transition ${
          isDone
            ? "text-(--color-muted-soft) line-through decoration-(--color-border)"
            : isActive
              ? "font-medium text-(--color-foreground-strong)"
              : "text-(--color-foreground)"
        }`}
      >
        {item.label}
      </span>
    </li>
  );
}

function StatusIndicator({ status }: { status: TodoItem["status"] }) {
  if (status === "completed") {
    return (
      <span
        aria-label="Completed"
        className="grid h-4 w-4 shrink-0 place-items-center rounded-full bg-(--color-success)/15 text-(--color-success)"
      >
        <CheckIcon />
      </span>
    );
  }
  if (status === "in_progress") {
    return (
      <span
        aria-label="In progress"
        className="grid h-4 w-4 shrink-0 place-items-center"
      >
        <span
          className="block h-3 w-3 rounded-full border-[1.5px] border-(--color-accent)/30 border-t-(--color-accent)"
          style={{ animation: "vask-spin 0.9s linear infinite" }}
        />
      </span>
    );
  }
  return (
    <span
      aria-label="Pending"
      className="h-4 w-4 shrink-0 rounded-full border border-dashed border-(--color-border)"
    />
  );
}

function CheckIcon() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function ListIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <polyline points="3 6 4 7 5 5" />
      <polyline points="3 12 4 13 5 11" />
      <polyline points="3 18 4 19 5 17" />
    </svg>
  );
}
