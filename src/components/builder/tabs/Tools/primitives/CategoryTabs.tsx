export function CategoryTabs({
  categories,
  active,
  onChange,
}: {
  categories: string[];
  active: string;
  onChange: (c: string) => void;
}) {
  return (
    <div
      role="tablist"
      className="mb-3 flex w-fit max-w-full gap-1 overflow-x-auto rounded-lg border border-(--color-border) bg-(--color-panel-soft) p-1"
    >
      {categories.map((c) => {
        const selected = active === c;
        return (
          <button
            key={c}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(c)}
            className={`shrink-0 rounded-md px-3 py-1.5 text-sm transition ${
              selected
                ? "bg-white font-medium text-(--color-foreground-strong) shadow-sm"
                : "text-(--color-muted) hover:text-(--color-foreground)"
            }`}
          >
            {c}
          </button>
        );
      })}
    </div>
  );
}
