import { DescribeAgentForm } from "@/components/DescribeAgentForm";

export default function Home() {
  return (
    <main className="welcome-shell">
      <div className="welcome-glow" aria-hidden />

      <header className="welcome-bar">
        <div className="welcome-brand">
          <div className="welcome-sparkle" aria-hidden>
            <SparkleGlyph />
          </div>
          <span className="welcome-wordmark">Alta</span>
          <span className="welcome-crumb">VIBE BUILD</span>
        </div>
      </header>

      <section className="welcome-main">
        <div className="welcome-hero">
          <div className="welcome-eyebrow">
            <SparkleGlyph small />
            VIBE-CODE YOUR VOICE AGENT
          </div>

          <h1 className="welcome-h1">
            Describe the agent.
            <br />
            <span className="welcome-h1-soft">Alta builds it live.</span>
          </h1>

          <p className="welcome-sub">
            One paragraph in, full voice agent out — workflow, voice, knowledge,
            and a phone number. Watch it assemble itself, then test it with a
            web call.
          </p>

          <DescribeAgentForm />
        </div>

        <div className="welcome-marquee">
          <span className="welcome-marquee-label">BUILT WITH</span>
          <div className="welcome-marquee-row">
            <span>ElevenLabs · voice</span>
            <span>Firecrawl · knowledge</span>
            <span>Claude · agent</span>
          </div>
        </div>
      </section>
    </main>
  );
}

function SparkleGlyph({ small = false }: { small?: boolean }) {
  const size = small ? 14 : 18;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
    >
      <path
        d="M12 2 L13.6 9.5 L21 12 L13.6 14.5 L12 22 L10.4 14.5 L3 12 L10.4 9.5 Z"
        fill="currentColor"
      />
    </svg>
  );
}
