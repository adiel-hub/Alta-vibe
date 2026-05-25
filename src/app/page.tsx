import Image from "next/image";
import Link from "next/link";
import { DescribeAgentForm } from "@/components/DescribeAgentForm";
import { AgentList, type AgentListItem } from "@/components/AgentList";
import { agentsCol } from "@/lib/mongodb";

export const dynamic = "force-dynamic";

export default async function Home() {
  const items = await loadAgents();

  return (
    <main className="hero-shell">
      <div className="hero-glow" aria-hidden />

      <header className="hero-masthead">
        <a href="/" className="hero-brand" aria-label="Alta — home">
          <Image
            src="/alta-logo.svg"
            alt="Alta"
            width={194}
            height={84}
            className="hero-logo-mark"
            priority
          />
        </a>
        <nav className="ml-auto flex gap-4 text-sm">
          <span className="font-semibold text-(--color-foreground-strong)">
            Agents
          </span>
          <Link
            href="/audiences"
            className="text-(--color-muted) hover:text-(--color-foreground-strong)"
          >
            Audiences
          </Link>
        </nav>
      </header>

      <section className="hero-stage">
        <div className="hero-avatar" aria-hidden>
          <Image
            src="/alta-avatar.png"
            alt=""
            width={112}
            height={112}
            priority
          />
        </div>

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
      </section>

      {items.length > 0 && (
        <section className="hero-agents">
          <header className="hero-agents-head">
            <h2 className="hero-agents-title">Your agents</h2>
            <p className="hero-agents-sub">
              {items.length} agent{items.length === 1 ? "" : "s"} in this
              workspace. Click any to keep building, or remove the ones you
              don't need.
            </p>
          </header>
          <AgentList initial={items} />
        </section>
      )}
    </main>
  );
}

async function loadAgents(): Promise<AgentListItem[]> {
  try {
    const col = await agentsCol();
    const docs = await col
      // Hide the workspace-internal audience_builder agent from the
      // user-facing list. {$ne} also matches docs with no `kind` field.
      .find({ kind: { $ne: "audience_builder" } })
      .sort({ updated_at: -1 })
      .limit(50)
      .project({
        elevenlabs_agent_id: 1,
        name: 1,
        description: 1,
        "config_cache.name": 1,
        "config_cache.first_message": 1,
        "config_cache.language": 1,
        created_at: 1,
        updated_at: 1,
      })
      .toArray();
    return docs.map((d) => ({
      id: d._id.toHexString(),
      name:
        (d.config_cache as { name?: string } | undefined)?.name ??
        (d.name as string | undefined) ??
        "Untitled agent",
      first_message:
        ((d.config_cache as { first_message?: string } | undefined)
          ?.first_message ?? "") as string,
      language:
        ((d.config_cache as { language?: string } | undefined)?.language ??
          "en") as string,
      description: (d.description as string | undefined) ?? "",
      updated_at: (d.updated_at as Date).toISOString(),
    }));
  } catch {
    // Mongo unreachable — render the welcome screen without the list rather
    // than 500 the whole page.
    return [];
  }
}
