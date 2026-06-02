/**
 * Central registry of OAuth2 provider configs, keyed by provider id.
 *
 * The proxy's token resolver looks up a provider's `OAuth2ProviderConfig`
 * here to refresh and attach its access token. Each provider's `auth.ts`
 * exports its config; this file is the single wiring point that lists them
 * (the same role registry.ts plays for IntegrationProvider definitions).
 *
 * Adding a new OAuth2 provider = create its config in
 * `lib/integrations/<id>/auth.ts`, then add one import + one entry here.
 */
import type { OAuth2ProviderConfig } from "./oauth2";
import { SALESFORCE_OAUTH_CONFIG } from "@/lib/integrations/salesforce/auth";
import { DYNAMICS365_OAUTH_CONFIG } from "@/lib/integrations/dynamics365/auth";
import { OUTLOOK_CALENDAR_OAUTH_CONFIG } from "@/lib/integrations/outlook_calendar/auth";

export const OAUTH2_CONFIGS: Record<string, OAuth2ProviderConfig> = {
  salesforce: SALESFORCE_OAUTH_CONFIG,
  dynamics365: DYNAMICS365_OAUTH_CONFIG,
  outlook_calendar: OUTLOOK_CALENDAR_OAUTH_CONFIG,
};
