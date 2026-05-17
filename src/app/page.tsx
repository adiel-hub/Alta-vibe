import Image from "next/image";
import { DescribeAgentForm } from "@/components/DescribeAgentForm";

const FEATURES = [
  {
    num: "01",
    label: "Workflow",
    sub: "Branches, conditions, and tool calls assembled from your description.",
  },
  {
    num: "02",
    label: "Voice",
    sub: "Cast a voice — language, cadence, accent — across 32 languages.",
  },
  {
    num: "03",
    label: "Knowledge",
    sub: "Upload docs or paste URLs; Alta indexes and grounds every reply.",
  },
  {
    num: "04",
    label: "Telephony",
    sub: "Assigned number, hours of operation, and live call routing.",
  },
];

export default function Home() {
  return (
    <main className="hero-shell">
      <div className="hero-glow" aria-hidden />
      <div className="hero-spectrum" aria-hidden />

      <header className="hero-masthead">
        <div className="hero-brand">
          <span className="hero-logo" aria-hidden>
            <Image src="/alex.avif" alt="" width={32} height={32} priority />
          </span>
          <span className="hero-wordmark">Alta</span>
        </div>
        <nav className="hero-nav" aria-label="Primary">
          <a href="#features">Features</a>
          <a href="#voices">Voices</a>
          <a href="#docs">Docs</a>
        </nav>
        <div className="hero-status" aria-live="polite">
          <span className="hero-pulse" aria-hidden />
          Live
        </div>
      </header>

      <section className="hero-stage">
        <span className="hero-eyebrow">Voice Agent Studio · v0.4</span>

        <h1 className="hero-title">
          Describe the agent.
          <br />
          <span className="hero-title-soft">Alta builds it live.</span>
        </h1>

        <p className="hero-lede">
          One paragraph in — a complete voice agent out. Workflow, voice,
          knowledge, and a phone number, assembled live in front of you.
        </p>

        <div className="hero-form-shell">
          <DescribeAgentForm />
        </div>

        <ol
          id="features"
          className="hero-pipeline"
          aria-label="What Alta assembles"
        >
          {FEATURES.map((step) => (
            <li key={step.num} className="hero-step">
              <span className="hero-step-num">{step.num}</span>
              <span className="hero-step-label">{step.label}</span>
              <span className="hero-step-sub">{step.sub}</span>
            </li>
          ))}
        </ol>
      </section>

      <footer className="hero-foot">
        <span>Calibrated voice engine</span>
        <span aria-hidden>·</span>
        <span>Live monitoring & transcripts</span>
        <span aria-hidden>·</span>
        <span>SOC-2 ready infrastructure</span>
      </footer>
    </main>
  );
}
