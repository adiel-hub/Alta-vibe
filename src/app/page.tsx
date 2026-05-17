import Image from "next/image";
import { DescribeAgentForm } from "@/components/DescribeAgentForm";

const PIPELINE = [
  { num: "01", label: "Workflow", sub: "Branches, conditions, tools" },
  { num: "02", label: "Voice", sub: "Cast, cadence, language" },
  { num: "03", label: "Knowledge", sub: "Indexed & searchable" },
  { num: "04", label: "Telephony", sub: "Number, routing, hours" },
];

export default function Home() {
  return (
    <main className="hero-shell">
      <div className="hero-bg" aria-hidden>
        <div className="hero-grid" />
        <div className="hero-aurora" />
      </div>

      <header className="hero-masthead">
        <div className="hero-brand">
          <span className="hero-mark" aria-hidden>
            ✦
          </span>
          <span className="hero-wordmark">Alta</span>
          <span className="hero-divider" aria-hidden />
          <span className="hero-meta">Voice Agent Studio · v0.4</span>
        </div>
        <div className="hero-status" aria-live="polite">
          <span className="hero-pulse" aria-hidden />
          Calibrated · Ready to build
        </div>
      </header>

      <section className="hero-stage">
        <aside className="hero-portrait" aria-label="Alta">
          <div className="hero-portrait-frame">
            <Image
              src="/alex.avif"
              alt="Portrait of Alta"
              width={360}
              height={440}
              priority
            />
            <span
              className="hero-portrait-corner hero-portrait-corner-tl"
              aria-hidden
            />
            <span
              className="hero-portrait-corner hero-portrait-corner-tr"
              aria-hidden
            />
            <span
              className="hero-portrait-corner hero-portrait-corner-bl"
              aria-hidden
            />
            <span
              className="hero-portrait-corner hero-portrait-corner-br"
              aria-hidden
            />
            <span className="hero-portrait-tag">
              <span className="hero-portrait-tag-dot" aria-hidden />
              On standby
            </span>
          </div>
          <div className="hero-portrait-caption">
            <span className="hero-portrait-name">Alta</span>
            <span className="hero-portrait-role">Builder · Conductor</span>
          </div>
        </aside>

        <div className="hero-content">
          <div className="hero-eyebrow">
            <span className="hero-eyebrow-bar" aria-hidden />
            <span className="hero-eyebrow-num">№ 01</span>
            <span>Describe in plain English</span>
            <span className="hero-eyebrow-bar" aria-hidden />
          </div>

          <h1 className="hero-title">
            Describe the agent.
            <br />
            <em className="hero-title-italic">Alta builds it live.</em>
          </h1>

          <p className="hero-lede">
            One paragraph in — a complete voice agent out. Workflow, voice,
            knowledge, and a phone number, <em>assembled live</em> in front of
            you. Test it the moment it's ready.
          </p>

          <div className="hero-form-shell">
            <DescribeAgentForm />
          </div>

          <ol className="hero-pipeline" aria-label="What Alta assembles">
            {PIPELINE.map((step) => (
              <li key={step.num} className="hero-step">
                <span className="hero-step-num">{step.num}</span>
                <span className="hero-step-label">{step.label}</span>
                <span className="hero-step-sub">{step.sub}</span>
              </li>
            ))}
          </ol>

          <ul className="hero-portrait-specs" aria-label="Capabilities">
            <li>
              <span>Latency</span>
              <strong>~340 ms</strong>
            </li>
            <li>
              <span>Languages</span>
              <strong>32</strong>
            </li>
            <li>
              <span>Voices</span>
              <strong>1,800+</strong>
            </li>
          </ul>
        </div>
      </section>

      <footer className="hero-foot">
        <span className="hero-foot-em">Trusted in production</span>
        <span className="hero-foot-sep" aria-hidden>
          ◇
        </span>
        <span>ElevenLabs voice engine</span>
        <span className="hero-foot-sep" aria-hidden>
          ◇
        </span>
        <span>Live monitoring & transcripts</span>
        <span className="hero-foot-sep" aria-hidden>
          ◇
        </span>
        <span>SOC-2 ready infrastructure</span>
      </footer>
    </main>
  );
}
