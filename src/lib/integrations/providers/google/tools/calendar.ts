import type { ProviderRuntimeToolSpec } from "../../types";

/**
 * Google Calendar tool specs. Two in-call tools:
 *
 *   - check_availability — POST /calendar/v3/freeBusy. Returns BUSY intervals
 *     for the requested calendars; the agent computes free slots from those.
 *   - book_meeting — POST /calendar/v3/calendars/primary/events with
 *     ?conferenceDataVersion=1 baked into the path so a Google Meet link is
 *     attached when the body includes a conferenceData.createRequest.
 *
 * Both tools target the user's primary calendar by default (most realistic
 * for sales/scheduling agents). check_availability accepts an explicit
 * `items` array so the agent can query teammate calendars when the user
 * shares them.
 */
export const GOOGLE_CALENDAR_TOOLS: ProviderRuntimeToolSpec[] = [
  {
    key: "check_availability",
    name: "google_calendar_check_availability",
    description:
      "Check busy intervals on one or more Google Calendars between two times. " +
      "Returns Google's freeBusy response with a `calendars` map, each entry holding `busy: [{start, end}]`. " +
      "The agent must compute FREE slots by subtracting these busy ranges from the requested window. " +
      "timeMin/timeMax are RFC3339 timestamps (e.g. '2026-05-25T09:00:00-07:00'). " +
      "Pass `items` as `[{ id: 'primary' }]` to check the user's own calendar, or substitute another shared calendar id.",
    phase: "in_call",
    method: "POST",
    path: "/calendar/v3/freeBusy",
    category: "Calendar",
    body_schema: {
      type: "object",
      properties: {
        timeMin: {
          type: "string",
          description:
            "Start of the window to check, as an RFC3339 timestamp with offset (e.g. '2026-05-25T09:00:00-07:00').",
        },
        timeMax: {
          type: "string",
          description:
            "End of the window to check, as an RFC3339 timestamp with offset (e.g. '2026-05-25T17:00:00-07:00').",
        },
        timeZone: {
          type: "string",
          description:
            "IANA time-zone for the response (e.g. 'America/Los_Angeles'). Defaults to UTC when omitted.",
        },
        items: {
          type: "array",
          description:
            "Calendars to check. Use [{ id: 'primary' }] for the connected user's main calendar.",
          items: {
            type: "object",
            properties: {
              id: {
                type: "string",
                description:
                  "Calendar id. 'primary' = connected user's calendar; otherwise an email-style shared calendar id.",
              },
            },
            required: ["id"],
          },
        },
      },
      required: ["timeMin", "timeMax", "items"],
    },
  },
  {
    key: "book_meeting",
    name: "google_calendar_book_meeting",
    description:
      "Book an event on the connected user's PRIMARY Google Calendar. " +
      "Invitations are sent to all attendees automatically (sendUpdates=all). " +
      "Include `conferenceData.createRequest` with a unique `requestId` to auto-generate a Google Meet link " +
      "(this endpoint is registered with conferenceDataVersion=1 so the link is created on save). " +
      "start/end use { dateTime, timeZone } — dateTime is RFC3339, timeZone is an IANA name. " +
      "Returns the created event including `htmlLink` (calendar URL) and `hangoutLink` (Meet URL) when a Meet was requested.",
    phase: "in_call",
    method: "POST",
    path: "/calendar/v3/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all",
    category: "Calendar",
    body_schema: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description: "Event title shown on the calendar and in the invite.",
        },
        description: {
          type: "string",
          description:
            "Body of the invite. Plain text or limited HTML — Google strips most tags.",
        },
        start: {
          type: "object",
          description: "Event start. Use { dateTime, timeZone }.",
          properties: {
            dateTime: {
              type: "string",
              description:
                "RFC3339 start time with offset (e.g. '2026-05-25T14:00:00-07:00').",
            },
            timeZone: {
              type: "string",
              description: "IANA time-zone (e.g. 'America/Los_Angeles').",
            },
          },
          required: ["dateTime", "timeZone"],
        },
        end: {
          type: "object",
          description: "Event end. Same shape as `start`.",
          properties: {
            dateTime: {
              type: "string",
              description: "RFC3339 end time with offset.",
            },
            timeZone: {
              type: "string",
              description: "IANA time-zone.",
            },
          },
          required: ["dateTime", "timeZone"],
        },
        attendees: {
          type: "array",
          description:
            "People to invite. Each entry needs at least `email`. Optional `displayName` shows in the calendar UI.",
          items: {
            type: "object",
            properties: {
              email: { type: "string", description: "Invitee email." },
              displayName: { type: "string", description: "Human-readable name." },
              optional: {
                type: "boolean",
                description: "True if this attendee is optional.",
              },
            },
            required: ["email"],
          },
        },
        location: {
          type: "string",
          description: "Free-text location (address, room name, or 'Google Meet').",
        },
        conferenceData: {
          type: "object",
          description:
            "Set this to auto-create a Google Meet link. Shape: { createRequest: { requestId: '<unique-string>', conferenceSolutionKey: { type: 'hangoutsMeet' } } }. Omit entirely to skip Meet.",
          properties: {
            createRequest: {
              type: "object",
              properties: {
                requestId: {
                  type: "string",
                  description:
                    "Idempotency key for this conference creation. Use a fresh random id per booking.",
                },
                conferenceSolutionKey: {
                  type: "object",
                  properties: {
                    type: {
                      type: "string",
                      description: "Always 'hangoutsMeet' for Google Meet.",
                    },
                  },
                  required: ["type"],
                },
              },
              required: ["requestId", "conferenceSolutionKey"],
            },
          },
        },
      },
      required: ["summary", "start", "end"],
    },
  },
];
