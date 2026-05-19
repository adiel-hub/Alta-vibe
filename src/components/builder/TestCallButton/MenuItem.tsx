// ── Menu item ────────────────────────────────────────────────────────────

export function MenuItem({
  icon,
  label,
  hint,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex w-full items-center gap-3 px-3 py-2 text-left transition hover:bg-(--color-panel-soft)"
    >
      <span
        className="grid h-7 w-7 place-items-center rounded-md bg-(--color-panel-soft) text-(--color-foreground-strong)"
        aria-hidden
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-medium text-(--color-foreground-strong)">
          {label}
        </span>
        <span className="block truncate text-[11px] text-(--color-muted)">
          {hint}
        </span>
      </span>
    </button>
  );
}
