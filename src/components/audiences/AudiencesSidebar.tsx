"use client";

import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { useState } from "react";
import type {
  AudienceChatSidebarItem,
  AudiencesSidebarItem,
} from "@/app/audiences/layout";
import { appFetch } from "@/lib/apiClient";

export function AudiencesSidebar({
  items,
  chats,
}: {
  items: AudiencesSidebarItem[];
  chats: AudienceChatSidebarItem[];
}) {
  const pathname = usePathname();
  const router = useRouter();

  // /audiences/build with no further segment = the "new chat" hero.
  const isNewChat =
    pathname === "/audiences" || pathname === "/audiences/build";

  // /audiences/build/<sessionId> → highlight the matching chat row.
  const activeChatId = (() => {
    const m = pathname.match(/^\/audiences\/build\/([^/]+)/);
    return m ? m[1] : null;
  })();

  // /audiences/<id> (NOT /audiences/build/<id>) → highlight the audience row.
  const activeAudienceId = (() => {
    if (activeChatId !== null) return null;
    const m = pathname.match(/^\/audiences\/([^/]+)/);
    if (!m || m[1] === "build") return null;
    return m[1];
  })();

  return (
    <aside className="flex w-64 shrink-0 flex-col gap-2 overflow-y-auto px-3 py-4">
      <Link
        href="/audiences/build"
        className={`flex items-center gap-2 rounded-xl px-3 py-2 text-sm transition ${
          isNewChat
            ? "bg-(--color-accent) text-(--color-accent-foreground) shadow-sm"
            : "text-(--color-foreground) hover:bg-(--color-panel-soft)"
        }`}
      >
        <span aria-hidden>＋</span>
        New chat
      </Link>

      {chats.length > 0 && (
        <>
          <div className="mt-5 px-3 text-[10px] font-semibold uppercase tracking-[0.15em] text-(--color-muted)">
            Chats
          </div>
          <ul className="space-y-0.5">
            {chats.map((c) => (
              <ChatRow
                key={c.id}
                chat={c}
                active={activeChatId === c.id}
                onDelete={async () => {
                  const res = await appFetch(
                    `/api/audiences/sessions/${c.id}`,
                    { method: "DELETE" },
                  );
                  if (res.ok) {
                    // If we deleted the active chat, drop the user back on
                    // the hero so the next render finds a valid route.
                    if (activeChatId === c.id) {
                      router.push("/audiences/build");
                    } else {
                      router.refresh();
                    }
                  }
                }}
              />
            ))}
          </ul>
        </>
      )}

      <div className="mt-5 px-3 text-[10px] font-semibold uppercase tracking-[0.15em] text-(--color-muted)">
        Lists
      </div>

      {items.length === 0 ? (
        <p className="px-3 py-2 text-xs text-(--color-muted)">
          No audiences yet. Use New chat →
        </p>
      ) : (
        <ul className="space-y-0.5">
          {items.map((a) => {
            const active = activeAudienceId === a.id;
            return (
              <li key={a.id}>
                <Link
                  href={`/audiences/${a.id}`}
                  className={`block rounded-xl px-3 py-2 text-sm transition ${
                    active
                      ? "bg-(--color-accent-soft) text-(--color-foreground-strong)"
                      : "text-(--color-foreground) hover:bg-(--color-panel-soft)"
                  }`}
                >
                  <div className="truncate font-medium">{a.name}</div>
                  <div className="text-[11px] text-(--color-muted)">
                    {a.prospect_count} prospect
                    {a.prospect_count === 1 ? "" : "s"}
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}

function ChatRow({
  chat,
  active,
  onDelete,
}: {
  chat: AudienceChatSidebarItem;
  active: boolean;
  onDelete: () => Promise<void>;
}) {
  const [hovering, setHovering] = useState(false);
  const [confirming, setConfirming] = useState(false);
  return (
    <li
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => {
        setHovering(false);
        setConfirming(false);
      }}
      className="relative"
    >
      <Link
        href={`/audiences/build/${chat.id}`}
        className={`block rounded-xl px-3 py-2 pr-9 text-sm transition ${
          active
            ? "bg-(--color-accent-soft) text-(--color-foreground-strong)"
            : "text-(--color-foreground) hover:bg-(--color-panel-soft)"
        }`}
      >
        <div className="truncate">{chat.title || "New audience chat"}</div>
      </Link>
      {(hovering || confirming) && (
        <button
          type="button"
          aria-label={confirming ? "Confirm delete chat" : "Delete chat"}
          title={confirming ? "Click again to confirm" : "Delete chat"}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!confirming) {
              setConfirming(true);
              return;
            }
            void onDelete();
          }}
          className={`absolute right-1.5 top-1/2 -translate-y-1/2 grid h-7 w-7 place-items-center rounded-md text-xs transition ${
            confirming
              ? "bg-(--color-danger)/15 text-(--color-danger)"
              : "text-(--color-muted) hover:bg-(--color-panel-soft) hover:text-(--color-foreground-strong)"
          }`}
        >
          {confirming ? "✓" : "×"}
        </button>
      )}
    </li>
  );
}
