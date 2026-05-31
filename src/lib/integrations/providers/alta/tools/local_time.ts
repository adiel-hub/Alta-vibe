/**
 * Derives the caller's local hour from their phone number's country code.
 * Used by prompts that want to greet appropriately ("Good morning" vs
 * "Good evening") and by `abort_on_failure` checks (don't dial at 3am).
 *
 * The phone-prefix → IANA-timezone map is intentionally minimal —
 * exhaustive country/region coverage lives in libphonenumber; for v1 we
 * cover the markets the product is being sold in. Unknown prefixes return
 * UTC + empty meta_country_code so the agent has a sensible fallback.
 */
import type { ProviderRuntimeToolSpec } from "../../types";

const PHONE_PREFIX_TO_TIMEZONE: Array<[string, string, string]> = [
  // [prefix, ISO country code, IANA timezone]
  ["+972", "IL", "Asia/Jerusalem"],
  ["+1", "US", "America/New_York"], // approximate — US spans multiple TZs
  ["+44", "GB", "Europe/London"],
  ["+49", "DE", "Europe/Berlin"],
  ["+33", "FR", "Europe/Paris"],
  ["+34", "ES", "Europe/Madrid"],
  ["+39", "IT", "Europe/Rome"],
  ["+31", "NL", "Europe/Amsterdam"],
  ["+41", "CH", "Europe/Zurich"],
  ["+46", "SE", "Europe/Stockholm"],
  ["+47", "NO", "Europe/Oslo"],
  ["+45", "DK", "Europe/Copenhagen"],
  ["+358", "FI", "Europe/Helsinki"],
  ["+351", "PT", "Europe/Lisbon"],
  ["+353", "IE", "Europe/Dublin"],
  ["+61", "AU", "Australia/Sydney"],
  ["+64", "NZ", "Pacific/Auckland"],
  ["+91", "IN", "Asia/Kolkata"],
  ["+852", "HK", "Asia/Hong_Kong"],
  ["+65", "SG", "Asia/Singapore"],
  ["+81", "JP", "Asia/Tokyo"],
  ["+82", "KR", "Asia/Seoul"],
  ["+86", "CN", "Asia/Shanghai"],
  ["+55", "BR", "America/Sao_Paulo"],
  ["+52", "MX", "America/Mexico_City"],
  ["+54", "AR", "America/Argentina/Buenos_Aires"],
  ["+27", "ZA", "Africa/Johannesburg"],
];

function lookupByPhone(phone: string): {
  country_code: string;
  timezone: string;
} | null {
  const trimmed = phone.replace(/[\s\-()]/g, "");
  // Longest-prefix-match — sort by length desc.
  const sorted = [...PHONE_PREFIX_TO_TIMEZONE].sort(
    (a, b) => b[0].length - a[0].length,
  );
  for (const [prefix, country, tz] of sorted) {
    if (trimmed.startsWith(prefix)) {
      return { country_code: country, timezone: tz };
    }
  }
  return null;
}

function partOfDay(hour: number): string {
  if (hour < 5) return "night";
  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";
  if (hour < 22) return "evening";
  return "night";
}

export const ALTA_LOCAL_TIME: ProviderRuntimeToolSpec = {
  key: "local_time",
  name: "alta_local_time",
  description:
    "Derives the caller's local timezone, hour, and part of day from their phone number's country prefix. Exposes meta_country_code, meta_timezone, meta_local_hour, meta_part_of_day. Use the part of day in greetings and gate calls on hour ranges.",
  phase: "pre_call",
  method: "POST",
  path: "alta://local_time",
  category: "Alta",
  execute: async (ctx) => {
    if (!ctx.to_number) return null;
    const match = lookupByPhone(ctx.to_number);
    if (!match) return null;
    // Resolve current hour in the caller's timezone via Intl.
    const fmt = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      hour12: false,
      timeZone: match.timezone,
    });
    const localHour = Number(fmt.format(new Date()));
    return {
      meta_country_code: match.country_code,
      meta_timezone: match.timezone,
      meta_local_hour: String(localHour),
      meta_part_of_day: partOfDay(localHour),
    };
  },
  output_aliases: {
    meta_country_code: "meta_country_code",
    meta_timezone: "meta_timezone",
    meta_local_hour: "meta_local_hour",
    meta_part_of_day: "meta_part_of_day",
  },
  narrative: (_ctx, output) => {
    const o = output as Record<string, string> | null;
    if (!o?.meta_part_of_day) return null;
    return `It's ${o.meta_part_of_day} for the caller (${o.meta_timezone}).`;
  },
};
