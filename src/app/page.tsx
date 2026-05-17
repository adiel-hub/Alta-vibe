import Image from "next/image";
import { DescribeAgentForm } from "@/components/DescribeAgentForm";

export default function Home() {
  return (
    <main className="welcome-shell">
      <div className="welcome-glow" aria-hidden />

      <section className="welcome-main">
        <div className="welcome-hero welcome-hero-centered">
          <div className="welcome-avatar" aria-hidden>
            <Image
              src="/alex.avif"
              alt=""
              width={120}
              height={120}
              priority
            />
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
      </section>
    </main>
  );
}
