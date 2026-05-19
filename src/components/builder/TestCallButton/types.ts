export type View = "menu" | "outbound";

export type TranscriptLine = { role: "agent" | "user"; text: string; ts: number };
