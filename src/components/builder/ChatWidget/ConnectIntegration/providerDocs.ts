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
    /**
     * When set, the connect UI shows a URL field the user must fill before
     * the popup opens, and posts it as `instance_url` to `startPath`. Used by
     * per-tenant providers whose API base / OAuth scope is instance-derived
     * (e.g. Dynamics 365 → "https://yourorg.crm.dynamics.com").
     */
    instanceUrlLabel?: string;
    instanceUrlPlaceholder?: string;
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
  salesforce: {
    docsUrl:
      "https://help.salesforce.com/s/articleView?id=sf.remoteaccess_oauth_web_server_flow.htm",
    oauth: {
      startPath: "/api/integrations/salesforce/oauth/start",
    },
  },
  dynamics365: {
    docsUrl:
      "https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/overview",
    oauth: {
      startPath: "/api/integrations/dynamics365/oauth/start",
      instanceUrlLabel: "Your Dynamics 365 org URL",
      instanceUrlPlaceholder: "https://yourorg.crm.dynamics.com",
    },
  },
  outlook_calendar: {
    docsUrl:
      "https://learn.microsoft.com/en-us/graph/api/resources/calendar?view=graph-rest-1.0",
    oauth: {
      startPath: "/api/integrations/outlook_calendar/oauth/start",
    },
  },
};
