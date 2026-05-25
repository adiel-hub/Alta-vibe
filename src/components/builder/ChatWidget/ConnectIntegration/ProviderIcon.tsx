function HubspotMark() {
  // Simplified HubSpot mark — keeps brand recognition without shipping the
  // full SVG. Colored via the brand orange so it pops against our panel.
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
      className="text-[#FF7A59]"
    >
      <path d="M18.2 8.1V5.6a1.7 1.7 0 1 0-1.4 0V8a5.6 5.6 0 0 0-2.4.9L7.8 3.6l.2-.6a1.7 1.7 0 1 0-1 .8L13.5 9a5.6 5.6 0 1 0 6.6 1.5l1.7-1.7a1.4 1.4 0 1 0-1-1L18.6 9a5.5 5.5 0 0 0-.4-.9zM15 17a2.6 2.6 0 1 1 0-5.2 2.6 2.6 0 0 1 0 5.2z" />
    </svg>
  );
}

function GoogleCalendarMark() {
  // eslint-disable-next-line @next/next/no-img-element -- matches twilio/hubspot pattern (plain <img>)
  return (
    <img
      src="/integrations/google-calendar.png"
      alt=""
      width={14}
      height={14}
      className="h-[14px] w-[14px] object-contain"
    />
  );
}

export function ProviderIcon({ provider }: { provider: string }) {
  if (provider === "hubspot") return <HubspotMark />;
  if (provider === "google_calendar") return <GoogleCalendarMark />;
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-(--color-accent)"
      aria-hidden
    >
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.72-1.71" />
    </svg>
  );
}
