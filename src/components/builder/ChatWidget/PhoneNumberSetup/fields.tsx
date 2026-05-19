import { EyeIcon, EyeOffIcon } from "../_shared/icons";

export function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 px-4 py-2 text-xs font-medium transition ${
        active
          ? "border-b-2 border-(--color-accent) text-(--color-foreground-strong)"
          : "border-b-2 border-transparent text-(--color-muted) hover:text-(--color-foreground-strong)"
      }`}
    >
      {children}
    </button>
  );
}

export function Field({
  label,
  value,
  onChange,
  placeholder,
  disabled,
  mono,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
  mono?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium text-(--color-muted)">
        {label}
      </span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        autoComplete="off"
        className={`w-full rounded-md border border-(--color-border) bg-white px-2.5 py-1.5 text-[12px] outline-none focus:border-(--color-accent) ${
          mono ? "font-mono text-[11px]" : ""
        }`}
      />
    </label>
  );
}

export function SelectField({
  label,
  value,
  onChange,
  options,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
  disabled?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium text-(--color-muted)">
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="w-full rounded-md border border-(--color-border) bg-white px-2 py-1.5 text-[12px] outline-none focus:border-(--color-accent)"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function SecretField({
  label,
  value,
  onChange,
  placeholder,
  disabled,
  revealed,
  onToggleReveal,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
  revealed: boolean;
  onToggleReveal: () => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium text-(--color-muted)">
        {label}
      </span>
      <div className="relative">
        <input
          type={revealed ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          autoComplete="off"
          className="w-full rounded-md border border-(--color-border) bg-white px-2.5 py-1.5 pr-9 font-mono text-[11px] outline-none focus:border-(--color-accent)"
        />
        <button
          type="button"
          onClick={onToggleReveal}
          aria-label={revealed ? "Hide" : "Show"}
          className="absolute right-1 top-1/2 grid h-6 w-7 -translate-y-1/2 place-items-center rounded text-(--color-muted) transition hover:bg-(--color-panel-soft) hover:text-(--color-foreground-strong)"
        >
          {revealed ? <EyeOffIcon /> : <EyeIcon />}
        </button>
      </div>
    </label>
  );
}
