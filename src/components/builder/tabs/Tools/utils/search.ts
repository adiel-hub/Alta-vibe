import type { FieldsMatcher } from "../types";

/**
 * Smart token-based fuzzy matcher used by the search bar.
 *
 *  - Lowercases both query and haystack.
 *  - Treats `_` / `-` / whitespace as the same separator so "create contact"
 *    matches "hubspot_create_contact" and "create-contact" alike.
 *  - Requires every token in the query to appear as a substring (order-
 *    independent). Empty query matches everything.
 *
 * Callers pass an array of candidate fields — the matcher concatenates and
 * normalises them as one blob so you can ask "does this query hit ANY of
 * (provider name, tool wire name, friendly name, description, category)?"
 * with a single call.
 */
export function normalizeForSearch(s: string | undefined | null): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/[_\-/.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function makeMatcher(query: string): FieldsMatcher {
  const tokens = normalizeForSearch(query).split(" ").filter(Boolean);
  if (tokens.length === 0) return () => true;
  return (fields) => {
    const blob = fields.map(normalizeForSearch).join(" ");
    return tokens.every((t) => blob.includes(t));
  };
}
