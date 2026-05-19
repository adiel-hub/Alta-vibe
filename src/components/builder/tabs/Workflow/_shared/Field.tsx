export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="vb-field">
      <div className="vb-field-label">{label}</div>
      {children}
      {hint && <p className="vb-field-hint">{hint}</p>}
    </div>
  );
}
