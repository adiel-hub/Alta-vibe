/**
 * Per-provider connect UX hints. `tokenLabel` triggers the paste-a-PAT
 * flow; `oauth` triggers the popup-redirect flow. Providers absent from
 * this map fall through to the legacy stub-credentials handler.
 */
export type ProviderConnectDocs = {
  docsUrl: string;
  tokenLabel?: string;
  oauth?: {
    startPath: string; // POST endpoint that mints an authorize URL
  };
};

export const PROVIDER_DOCS: Record<string, ProviderConnectDocs> = {
  hubspot: {
    docsUrl: "https://developers.hubspot.com/docs/guides/apps/private-apps/overview",
    tokenLabel: "Private App access token",
  },
  google_calendar: {
    docsUrl:
      "https://developers.google.com/identity/protocols/oauth2/web-server",
    oauth: {
      startPath: "/api/integrations/google_calendar/oauth/start",
    },
  },
};
