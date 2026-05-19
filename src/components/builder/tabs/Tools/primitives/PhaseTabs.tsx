import type { RuntimePhase } from "@/types/agent";
import { PHASES } from "../constants";

export function PhaseTabs({
  active,
  onChange,
}: {
  active: RuntimePhase;
  onChange: (p: RuntimePhase) => void;
}) {
  return (
    <div className="mb-3 grid grid-cols-3 gap-1 rounded-lg border border-(--color-border) bg-(--color-panel-soft) p-1">
      {PHASES.map((p) => {
        const selected = active === p.id;
        return (
          <button
            key={p.id}
            type="button"
            onClick={() => onChange(p.id)}
            className={`rounded-md py-1.5 text-sm transition ${
              selected
                ? "bg-(--color-panel) font-medium text-(--color-foreground-strong) shadow-sm"
                : "text-(--color-muted) hover:text-(--color-foreground)"
            }`}
          >
            {p.label}
          </button>
        );
      })}
    </div>
  );
}
