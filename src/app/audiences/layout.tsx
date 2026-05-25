import Image from "next/image";
import Link from "next/link";
import {
  audienceChatSessionsCol,
  audiencesCol,
} from "@/lib/mongodb";
import { getOrCreateAudienceBuilderAgent } from "@/lib/audiences/builderAgent";
import { AudiencesSidebar } from "@/components/audiences/AudiencesSidebar";

export const dynamic = "force-dynamic";

export type AudiencesSidebarItem = {
  id: string;
  name: string;
  prospect_count: number;
  updated_at: string;
};

export type AudienceChatSidebarItem = {
  id: string;
  title: string;
  last_message_at: string;
};

/**
 * Two-pane shell for /audiences and its children. Same hero canvas as the
 * landing page (ambient indigo/violet glow under a transparent masthead)
 * with a sidebar + main pane laid on top as soft glass panels.
 */
export default async function AudiencesLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [items, chats] = await Promise.all([
    loadSidebarItems(),
    loadChatSessions(),
  ]);

  return (
    <main className="hero-shell" style={{ height: "100vh", minHeight: "100vh" }}>
      <div className="hero-glow hero-glow--soft" aria-hidden />

      <header className="hero-masthead">
        <Link href="/" className="hero-brand" aria-label="Alta — home">
          <Image
            src="/alta-logo.svg"
            alt="Alta"
            width={194}
            height={84}
            className="hero-logo-mark"
            priority
          />
        </Link>
        <nav className="ml-auto flex gap-6 text-sm">
          <Link
            href="/"
            className="text-(--color-muted) transition hover:text-(--color-foreground-strong)"
          >
            Agents
          </Link>
          <span className="font-semibold text-(--color-foreground-strong)">
            Audiences
          </span>
        </nav>
      </header>

      <div className="relative z-[2] flex min-h-0 flex-1 gap-5 px-10 pb-8 pt-6">
        <AudiencesSidebar items={items} chats={chats} />
        <section className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {children}
        </section>
        {/* Ghost spacer that mirrors the sidebar's footprint so the section's
            mx-auto centering lands the chat column in the viewport's center
            instead of being offset to the right by the sidebar width. */}
        <div className="hidden w-64 shrink-0 lg:block" aria-hidden />
      </div>
    </main>
  );
}

async function loadSidebarItems(): Promise<AudiencesSidebarItem[]> {
  try {
    const col = await audiencesCol();
    const rows = await col.find().sort({ updated_at: -1 }).limit(200).toArray();
    return rows.map((r) => ({
      id: r._id.toHexString(),
      name: r.name,
      prospect_count: r.prospect_ids.length,
      updated_at: r.updated_at.toISOString(),
    }));
  } catch {
    return [];
  }
}

async function loadChatSessions(): Promise<AudienceChatSidebarItem[]> {
  try {
    const agent = await getOrCreateAudienceBuilderAgent();
    const col = await audienceChatSessionsCol();
    const rows = await col
      .find({ agent_id: agent._id })
      .sort({ last_message_at: -1 })
      .limit(100)
      .toArray();
    return rows.map((r) => ({
      id: r._id.toHexString(),
      title: r.title,
      last_message_at: r.last_message_at.toISOString(),
    }));
  } catch {
    return [];
  }
}
