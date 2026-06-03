import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import {
  addRules,
  createDictionaryFromRules,
  removeRules,
} from "@/lib/elevenlabs/client";
import type {
  PronunciationDictionary,
  PronunciationRule,
} from "@/types/agent";
import type { AgentPatch } from "@/lib/elevenlabs/agents/types";
import type { Capability } from "../types";
import { runToolStep } from "../types";

/** Build the `pronunciation_dictionary_locators` upstream slice for a given
 *  dictionary state. An empty/cleared dictionary detaches all locators. */
function locatorPatch(dict: PronunciationDictionary): AgentPatch {
  if (!dict) return { pronunciation_dictionary_locators: [] };
  return {
    pronunciation_dictionary_locators: [
      {
        pronunciation_dictionary_id: dict.id,
        version_id: dict.version_id,
      },
    ],
  };
}

export const pronunciationCapability: Capability = {
  id: "pronunciation",
  label: "Pronunciation",
  defaultSlice: () => ({ pronunciation_dictionary: null }),
  tools: (ctx) => [
    tool(
      "add_pronunciation_rule",
      [
        "Teach the agent how to say a specific word or phrase (brand names,",
        "products, people, technical terms). Prefer type 'alias' (a respelling",
        "like 'Nike' → 'Nigh-key') — it works on every model and language.",
        "Use type 'phoneme' (IPA/CMU) ONLY for English agents on the",
        "eleven_flash_v2 / eleven_monolingual_v1 model — it is silently ignored",
        "on other models (including the default eleven_v3_conversational).",
      ].join(" "),
      {
        word: z
          .string()
          .min(1)
          .max(120)
          .describe("The word/phrase to correct, e.g. 'tomato'. Case-sensitive."),
        type: z.enum(["alias", "phoneme"]).default("alias"),
        alias: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe("Respelling, required when type='alias'. e.g. 'tom-ay-toe'."),
        phoneme: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe("IPA/CMU transcription, required when type='phoneme'."),
        alphabet: z
          .enum(["ipa", "cmu"])
          .optional()
          .describe("Phonetic alphabet for a phoneme rule. Defaults to 'ipa'."),
      },
      async ({ word, type, alias, phoneme, alphabet }) =>
        runToolStep(ctx, "pronunciation", "add_pronunciation_rule", async () => {
          if (type === "alias" && !alias) {
            throw new Error("`alias` is required when type is 'alias'.");
          }
          if (type === "phoneme" && !phoneme) {
            throw new Error("`phoneme` is required when type is 'phoneme'.");
          }
          const rule: PronunciationRule = {
            id: crypto.randomUUID(),
            type,
            string_to_replace: word,
            ...(type === "alias"
              ? { alias }
              : { phoneme, alphabet: alphabet ?? "ipa" }),
          };

          const existing = ctx.config.pronunciation_dictionary;
          let next: PronunciationDictionary;
          if (!existing) {
            const created = await createDictionaryFromRules({
              name: `${ctx.config.name || "Agent"} pronunciations`,
              rules: [rule],
            });
            next = {
              id: created.id,
              version_id: created.version_id,
              name: created.name,
              rules: [rule],
            };
          } else {
            const { version_id } = await addRules(existing.id, [rule]);
            next = {
              ...existing,
              version_id,
              rules: [...existing.rules, rule],
            };
          }

          return {
            patch: { pronunciation_dictionary: next },
            upstreamPatch: locatorPatch(next),
            summary: `Taught it to say "${word}".`,
          };
        }),
    ),

    tool(
      "remove_pronunciation_rule",
      "Remove a single pronunciation rule by its id. Call list_pronunciation_rules first to find ids.",
      { rule_id: z.string().min(1) },
      async ({ rule_id }) =>
        runToolStep(ctx, "pronunciation", "remove_pronunciation_rule", async () => {
          const dict = ctx.config.pronunciation_dictionary;
          const target = dict?.rules.find((r) => r.id === rule_id);
          if (!dict || !target) {
            throw new Error(
              `No pronunciation rule with id "${rule_id}". Call list_pronunciation_rules to inspect ids.`,
            );
          }
          const { version_id } = await removeRules(dict.id, [
            target.string_to_replace,
          ]);
          const remaining = dict.rules.filter((r) => r.id !== rule_id);
          const next: PronunciationDictionary =
            remaining.length === 0
              ? { ...dict, version_id, rules: [] }
              : { ...dict, version_id, rules: remaining };
          return {
            patch: { pronunciation_dictionary: next },
            upstreamPatch: locatorPatch(next),
            summary: `Removed the pronunciation for "${target.string_to_replace}".`,
          };
        }),
    ),

    tool(
      "list_pronunciation_rules",
      "List the agent's current pronunciation rules with their ids. Read-only.",
      {},
      async () => {
        const dict = ctx.config.pronunciation_dictionary;
        const rules = dict?.rules ?? [];
        return {
          content: [{ type: "text" as const, text: JSON.stringify(rules) }],
        };
      },
    ),
  ],
};
