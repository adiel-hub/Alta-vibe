import { DescribeAgentForm } from "@/components/DescribeAgentForm";

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-10 px-6 py-20">
      <div className="flex max-w-2xl flex-col items-center gap-4 text-center animate-slide-up">
        <span className="rounded-full border border-(--color-border) bg-(--color-panel) px-3 py-1 text-xs font-medium uppercase tracking-wider text-(--color-muted)">
          Alta
        </span>
        <h1 className="text-5xl font-semibold tracking-tight">
          Describe your voice agent.
        </h1>
        <p className="text-lg text-(--color-muted)">
          Then shape it by chat. Voice, knowledge, tools, phone — all from the conversation.
        </p>
      </div>
      <div className="w-full max-w-2xl animate-slide-up" style={{ animationDelay: "100ms" }}>
        <DescribeAgentForm />
      </div>
    </main>
  );
}
