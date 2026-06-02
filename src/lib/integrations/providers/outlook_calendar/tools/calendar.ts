import type { ProviderRuntimeToolSpec } from "../../types";

/**
 * Microsoft Outlook Calendar (Microsoft Graph v1.0) tool specs. Mirrors the
 * Google Calendar pair in spirit — two in-call tools the agent drives per
 * conversation, no pre-call enrichment:
 *
 *   - check_availability — POST /v1.0/me/calendar/getSchedule. Returns a
 *     `value[]` of scheduleInformation, each with `availabilityView` (a
 *     per-interval busy code string) and `scheduleItems: [{ status, start, end }]`.
 *     The agent computes FREE slots by subtracting busy items from the window.
 *   - book_meeting — POST /v1.0/me/events. Creates an event on the connected
 *     user's default calendar, optionally as a Microsoft Teams online meeting
 *     (isOnlineMeeting + onlineMeetingProvider:"teamsForBusiness"). Invites are
 *     sent to attendees automatically on create.
 *
 * Graph's dateTimeTimeZone shape is { dateTime, timeZone } where `dateTime`
 * is an ISO-8601 local datetime WITHOUT offset (e.g. "2026-05-25T09:00:00")
 * and `timeZone` is a Windows or IANA time-zone name (e.g. "Pacific Standard
 * Time" or "America/Los_Angeles"). This differs from Google's RFC3339-with-
 * offset convention, so the schema descriptions spell it out for the LLM.
 */
export const OUTLOOK_CALENDAR_TOOLS: ProviderRuntimeToolSpec[] = [
  {
    key: "check_availability",
    name: "outlook_calendar_check_availability",
    description:
      "Check free/busy availability for one or more people on Microsoft Outlook / Office 365 calendars over a time window. " +
      "Pass `schedules` as an array of SMTP email addresses (the connected user's own address, teammates, or room/equipment resources). " +
      "Returns Graph's getSchedule response: `value[]`, one entry per schedule, each holding `availabilityView` " +
      "(a string of per-interval codes: 0 free, 1 tentative, 2 busy, 3 out-of-office, 4 working-elsewhere) and " +
      "`scheduleItems: [{ status, start, end }]` with the actual busy blocks. " +
      "The agent must compute FREE slots by subtracting the busy/tentative/oof items from the requested window. " +
      "startTime/endTime use { dateTime, timeZone } — `dateTime` is a local ISO-8601 datetime WITHOUT offset " +
      "(e.g. '2026-05-25T09:00:00'), `timeZone` is a Windows or IANA zone name (e.g. 'Pacific Standard Time' or 'America/Los_Angeles'). " +
      "availabilityViewInterval is the slot size in minutes (default 30, min 5, max 1440).",
    phase: "in_call",
    method: "POST",
    path: "/v1.0/me/calendar/getSchedule",
    category: "Calendar",
    body_schema: {
      type: "object",
      properties: {
        schedules: {
          type: "array",
          description:
            "SMTP email addresses of users, distribution lists, or room/equipment resources to check. " +
            "Include the connected user's own address to check their calendar.",
          items: {
            type: "string",
            description: "An SMTP email address (e.g. 'alice@contoso.com').",
          },
        },
        startTime: {
          type: "object",
          description: "Start of the window to check. Use { dateTime, timeZone }.",
          properties: {
            dateTime: {
              type: "string",
              description:
                "Local ISO-8601 datetime WITHOUT offset (e.g. '2026-05-25T09:00:00').",
            },
            timeZone: {
              type: "string",
              description:
                "Windows or IANA time-zone name (e.g. 'Pacific Standard Time' or 'America/Los_Angeles').",
            },
          },
          required: ["dateTime", "timeZone"],
        },
        endTime: {
          type: "object",
          description: "End of the window to check. Same shape as `startTime`.",
          properties: {
            dateTime: {
              type: "string",
              description:
                "Local ISO-8601 datetime WITHOUT offset (e.g. '2026-05-25T17:00:00').",
            },
            timeZone: {
              type: "string",
              description:
                "Windows or IANA time-zone name (e.g. 'Pacific Standard Time' or 'America/Los_Angeles').",
            },
          },
          required: ["dateTime", "timeZone"],
        },
        availabilityViewInterval: {
          type: "integer",
          description:
            "Duration in minutes of each slot in the returned availabilityView string. Default 30, minimum 5, maximum 1440.",
        },
      },
      required: ["schedules", "startTime", "endTime"],
    },
  },
  {
    key: "book_meeting",
    name: "outlook_calendar_book_meeting",
    description:
      "Create an event on the connected user's default Outlook / Office 365 calendar. " +
      "Meeting invitations are sent to all attendees automatically when the event is created. " +
      "Set `isOnlineMeeting: true` with `onlineMeetingProvider: 'teamsForBusiness'` to auto-generate a Microsoft Teams join link " +
      "(returned on the response as `onlineMeeting.joinUrl`). " +
      "start/end use { dateTime, timeZone } — `dateTime` is a local ISO-8601 datetime WITHOUT offset (e.g. '2026-05-25T14:00:00'), " +
      "`timeZone` is a Windows or IANA zone name (e.g. 'Pacific Standard Time'). " +
      "Each attendee is { emailAddress: { address, name }, type } where type is 'required', 'optional', or 'resource'. " +
      "Returns the created event including `id`, `webLink` (calendar URL), and `onlineMeeting.joinUrl` when a Teams meeting was requested.",
    phase: "in_call",
    method: "POST",
    path: "/v1.0/me/events",
    category: "Calendar",
    body_schema: {
      type: "object",
      properties: {
        subject: {
          type: "string",
          description: "Event title shown on the calendar and in the invite.",
        },
        body: {
          type: "object",
          description:
            "Event body / description. Use { contentType, content } where contentType is 'HTML' or 'Text'.",
          properties: {
            contentType: {
              type: "string",
              description: "'HTML' or 'Text'. Defaults to 'HTML' when omitted.",
            },
            content: {
              type: "string",
              description: "The body text or HTML shown in the invite.",
            },
          },
          required: ["content"],
        },
        start: {
          type: "object",
          description: "Event start. Use { dateTime, timeZone }.",
          properties: {
            dateTime: {
              type: "string",
              description:
                "Local ISO-8601 start datetime WITHOUT offset (e.g. '2026-05-25T14:00:00').",
            },
            timeZone: {
              type: "string",
              description:
                "Windows or IANA time-zone name (e.g. 'Pacific Standard Time').",
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
              description:
                "Local ISO-8601 end datetime WITHOUT offset (e.g. '2026-05-25T15:00:00').",
            },
            timeZone: {
              type: "string",
              description:
                "Windows or IANA time-zone name (e.g. 'Pacific Standard Time').",
            },
          },
          required: ["dateTime", "timeZone"],
        },
        attendees: {
          type: "array",
          description:
            "People to invite. Each entry is { emailAddress: { address, name }, type }.",
          items: {
            type: "object",
            properties: {
              emailAddress: {
                type: "object",
                description: "The attendee's email and display name.",
                properties: {
                  address: { type: "string", description: "Attendee email address." },
                  name: { type: "string", description: "Human-readable display name." },
                },
                required: ["address"],
              },
              type: {
                type: "string",
                description:
                  "Attendee role: 'required', 'optional', or 'resource'. Defaults to 'required'.",
              },
            },
            required: ["emailAddress"],
          },
        },
        location: {
          type: "object",
          description:
            "Free-text location. Use { displayName } (e.g. { displayName: 'Microsoft Teams Meeting' }).",
          properties: {
            displayName: {
              type: "string",
              description: "Location name shown on the event (address, room, or 'Microsoft Teams Meeting').",
            },
          },
        },
        isOnlineMeeting: {
          type: "boolean",
          description:
            "Set true to attach an online meeting. Pair with onlineMeetingProvider:'teamsForBusiness' to generate a Teams link.",
        },
        onlineMeetingProvider: {
          type: "string",
          description:
            "Online meeting provider. Use 'teamsForBusiness' for a Microsoft Teams meeting. Only meaningful when isOnlineMeeting is true.",
        },
      },
      required: ["subject", "start", "end"],
    },
  },
];
