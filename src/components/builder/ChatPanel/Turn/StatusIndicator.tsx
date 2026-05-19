import type { ToolStatus } from "./grouping";

export function StatusIndicator({ status }: { status: ToolStatus }) {
  if (status === "running") return <span className="vb-tool-spin" aria-hidden />;
  if (status === "success") {
    return (
      <span
        className="grid h-3.5 w-3.5 place-items-center text-[10px] font-bold text-(--color-success)"
        aria-hidden
      >
        ✓
      </span>
    );
  }
  return (
    <span
      className="grid h-3.5 w-3.5 place-items-center text-[10px] font-bold text-(--color-danger)"
      aria-hidden
    >
      ✕
    </span>
  );
}
