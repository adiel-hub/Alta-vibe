"use client";

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

type Variant = "primary" | "secondary" | "danger" | "ghost";
type Size = "sm" | "md" | "lg";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  /** Render as a full-width block button. */
  block?: boolean;
  /** Optional leading icon. */
  iconLeft?: ReactNode;
  /** Optional trailing icon. */
  iconRight?: ReactNode;
};

// Radius matches the header "Test call" button (rounded-lg). All primary
// blue actions across the builder use this component so the visual language
// stays consistent — change the radius / accent treatment here and every
// call site updates in lockstep.
const BASE =
  "inline-flex items-center justify-center gap-2 rounded-lg font-semibold transition-[opacity,background-color,border-color,color] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--color-accent)/40 disabled:cursor-not-allowed disabled:opacity-50";

const SIZE: Record<Size, string> = {
  sm: "px-3 py-1 text-[12px]",
  md: "px-3.5 py-1.5 text-[12px]",
  lg: "px-4 py-2 text-sm",
};

const VARIANT: Record<Variant, string> = {
  primary:
    "border border-(--color-accent) bg-(--color-accent) text-(--color-accent-foreground) hover:opacity-90",
  secondary:
    "border border-(--color-border) bg-(--color-panel) text-(--color-foreground-strong) hover:bg-(--color-panel-soft)",
  danger:
    "border border-(--color-danger) bg-(--color-danger)/10 text-(--color-danger) hover:bg-(--color-danger)/20",
  ghost:
    "border border-transparent bg-transparent text-(--color-muted) hover:bg-(--color-panel-soft) hover:text-(--color-foreground-strong)",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      variant = "primary",
      size = "md",
      block,
      iconLeft,
      iconRight,
      className,
      children,
      type,
      ...rest
    },
    ref,
  ) {
    const classes = [
      BASE,
      SIZE[size],
      VARIANT[variant],
      block ? "w-full" : "",
      className ?? "",
    ]
      .filter(Boolean)
      .join(" ");
    return (
      <button ref={ref} type={type ?? "button"} className={classes} {...rest}>
        {iconLeft}
        {children}
        {iconRight}
      </button>
    );
  },
);
