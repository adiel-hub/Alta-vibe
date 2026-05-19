"use client";

import type { WidgetEntry } from "@/store/agentStore";

export function StatusBadge({ status }: { status: WidgetEntry["status"] }) {
  const map: Record<WidgetEntry["status"], string> = {
    pending: "bg-(--color-muted)/20 text-(--color-muted)",
    done: "bg-(--color-success)/20 text-(--color-success)",
    cancelled: "bg-(--color-muted)/20 text-(--color-muted)",
    failed: "bg-(--color-danger)/20 text-(--color-danger)",
  };
  return (
    <span className={`rounded-full px-2 py-[1px] text-[10px] uppercase ${map[status]}`}>
      {status}
    </span>
  );
}
