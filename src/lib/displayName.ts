import { prettify } from "@/components/builder/ChatWidget/_shared/prettify";

/**
 * Resolve the display name for an entry that may have an explicit `label`
 * (agent- or user-set) and always has a snake_case `name`. Falls back to a
 * Title-Cased version of the slug so legacy entries without a label still
 * read cleanly.
 */
export function displayName(entry: { label?: string; name: string }): string {
  const label = entry.label?.trim();
  if (label && label.length > 0) return label;
  return prettify(entry.name);
}
