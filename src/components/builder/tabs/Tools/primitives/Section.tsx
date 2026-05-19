export function Section({
  title,
  busy,
  children,
}: {
  title: string;
  busy?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-4 last:mb-0">
      <div className="mb-2 flex items-center justify-between px-1">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-(--color-muted)">
          {title}
        </h3>
        {busy && (
          <span className="text-xs text-(--color-accent)">syncing…</span>
        )}
      </div>
      {children}
    </div>
  );
}
