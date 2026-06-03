import type { PronunciationRule } from "@/types/agent";
import { elFetch } from "../core/fetch";

/**
 * ElevenLabs pronunciation dictionary client. A dictionary is a versioned PLS
 * lexicon of rules; mutating its rules mints a new `version_id` which must be
 * re-attached to the agent via `pronunciation_dictionary_locators`.
 *
 * Shape mirrors knowledge-base/index.ts (elFetch + a stable `section`).
 */

export type ElevenPronunciationDictionary = {
  id: string;
  version_id: string;
  name: string;
};

/** Map our local rule into the upstream wire shape (drops our local `id`). */
function toUpstreamRule(rule: PronunciationRule): Record<string, unknown> {
  if (rule.type === "phoneme") {
    return {
      string_to_replace: rule.string_to_replace,
      type: "phoneme",
      phoneme: rule.phoneme ?? "",
      alphabet: rule.alphabet ?? "ipa",
    };
  }
  return {
    string_to_replace: rule.string_to_replace,
    type: "alias",
    alias: rule.alias ?? "",
  };
}

/**
 * Create a new dictionary seeded with `rules`. Upstream returns the dictionary
 * id and the initial version id (`id` / `version_id` — older responses used
 * `pronunciation_dictionary_id`, so we accept both).
 */
export async function createDictionaryFromRules(input: {
  name: string;
  rules: PronunciationRule[];
}): Promise<ElevenPronunciationDictionary> {
  const res = await elFetch("/v1/pronunciation-dictionaries/add-from-rules", {
    method: "POST",
    section: "pronunciation",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: input.name,
      rules: input.rules.map(toUpstreamRule),
    }),
  });
  const json = (await res.json()) as {
    id?: string;
    pronunciation_dictionary_id?: string;
    version_id: string;
    name?: string;
  };
  return {
    id: json.id ?? json.pronunciation_dictionary_id ?? "",
    version_id: json.version_id,
    name: json.name ?? input.name,
  };
}

/** Append rules to an existing dictionary. Returns the new version id. */
export async function addRules(
  dictionaryId: string,
  rules: PronunciationRule[],
): Promise<{ version_id: string }> {
  const res = await elFetch(
    `/v1/pronunciation-dictionaries/${dictionaryId}/add-rules`,
    {
      method: "POST",
      section: "pronunciation",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rules: rules.map(toUpstreamRule) }),
    },
  );
  const json = (await res.json()) as { version_id: string };
  return { version_id: json.version_id };
}

/**
 * Remove rules from a dictionary by the graphemes they match
 * (`string_to_replace`). Returns the new version id.
 */
export async function removeRules(
  dictionaryId: string,
  ruleStrings: string[],
): Promise<{ version_id: string }> {
  const res = await elFetch(
    `/v1/pronunciation-dictionaries/${dictionaryId}/remove-rules`,
    {
      method: "POST",
      section: "pronunciation",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rule_strings: ruleStrings }),
    },
  );
  const json = (await res.json()) as { version_id: string };
  return { version_id: json.version_id };
}

/** Fetch a dictionary's metadata (id, name, latest_version_id). */
export async function getDictionary(dictionaryId: string): Promise<{
  id: string;
  name: string;
  latest_version_id?: string;
}> {
  const res = await elFetch(
    `/v1/pronunciation-dictionaries/${dictionaryId}/`,
    { method: "GET", section: "pronunciation" },
  );
  const json = (await res.json()) as {
    id?: string;
    pronunciation_dictionary_id?: string;
    name?: string;
    latest_version_id?: string;
  };
  return {
    id: json.id ?? json.pronunciation_dictionary_id ?? dictionaryId,
    name: json.name ?? "",
    latest_version_id: json.latest_version_id,
  };
}
