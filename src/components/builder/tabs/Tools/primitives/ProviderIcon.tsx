export function ProviderIcon({
  icon,
  name,
  size = "sm",
}: {
  icon: string;
  name: string;
  size?: "sm" | "lg";
}) {
  const imgClass =
    size === "lg" ? "h-10 w-10 shrink-0" : "h-5 w-5 shrink-0";
  const textClass = size === "lg" ? "text-3xl leading-none" : "text-base leading-none";
  if (icon.startsWith("/") || icon.startsWith("http")) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={icon}
        alt={`${name} logo`}
        className={`${imgClass} rounded object-contain`}
      />
    );
  }
  return <span className={textClass}>{icon}</span>;
}
