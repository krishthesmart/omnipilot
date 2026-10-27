import { useEffect, useState } from "react";
import { AlarmClock, FolderGit2, MessageSquare, Plug, ShieldAlert, Sparkles, SquarePen, Sigma, Trash2 } from "lucide-react";
import type { CodeAlert } from "../api";
import { deleteConversation, fetchConversations, type ConversationSummary } from "../api";
import { OmniMark } from "./OmniMark";

function when(iso: string): string {
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days === 0) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (days === 1) return "Yesterday";
  if (days < 7) return d.toLocaleDateString([], { weekday: "long" });
  return d.toLocaleDateString();
}

export type Page = "chat" | "routines" | "skills" | "integrations" | "workspace";

const NAV: { page: Page; label: string; icon: typeof MessageSquare }[] = [
  { page: "chat", label: "Chat", icon: MessageSquare },
  { page: "routines", label: "Routines", icon: AlarmClock },
  { page: "skills", label: "Skills & agents", icon: Sparkles },
  { page: "integrations", label: "Integrations", icon: Plug },
  { page: "workspace", label: "Workspace", icon: FolderGit2 },
];

/** The app's pages and past chats (kept on this computer). Always visible on wide screens; a drawer on phones. */
export function ChatSidebar({
  open,
  onClose,
  currentId,
  refreshKey,
  onOpen,
  onNewChat,
  onDeleted,
  newDiscoveries = 0,
  onShowDiscoveries,
  codeAlerts = [],
  onShowCodeAlerts,
  page = "chat",
  onNavigate,
  pendingCount = 0,
}: {
  page?: Page;
  onNavigate?: (page: Page) => void;
  /** Changes waiting for approval (shown on the Workspace link). */
  pendingCount?: number;
  open: boolean;
  onClose: () => void;
  currentId: string;
  /** Changes whenever a message is sent, so new chats and titles show up. */
  refreshKey: number;
  onOpen: (id: string) => void;
  onNewChat: () => void;
  onDeleted: (id: string) => void;
  /** New identities MathPilot's background search found since the user last looked. */
  newDiscoveries?: number;
  onShowDiscoveries?: () => void;
  /** New issues from CodePilot's always-on check. */
  codeAlerts?: CodeAlert[];
  onShowCodeAlerts?: () => void;
}) {
  const [list, setList] = useState<ConversationSummary[] | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  useEffect(() => {
    fetchConversations().then(setList);
    // Routines add chats on their own, so check for new ones now and then.
    const id = setInterval(() => fetchConversations().then(setList), 60_000);
    return () => clearInterval(id);
  }, [refreshKey, currentId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  async function remove(id: string) {
    await deleteConversation(id);
    setList((l) => (l ?? []).filter((c) => c.id !== id));
    setConfirming(null);
    onDeleted(id);
  }

  return (
    <>
      {open && <div className="sidebar-scrim" onClick={onClose} />}
      <aside className={open ? "chat-sidebar open" : "chat-sidebar"} aria-label="Chat history">
        <div className="sidebar-brand">
          <OmniMark size={26} />
          <span className="app-title">OmniPilot</span>
        </div>
        <button className="new-chat-btn" onClick={onNewChat}>
          <SquarePen size={15} /> New chat
        </button>
        <nav className="side-nav" aria-label="Pages">
          {NAV.map(({ page: p, label, icon: Icon }) => (
            <button key={p} className={p === page ? "side-nav-item current" : "side-nav-item"} aria-current={p === page ? "page" : undefined} onClick={() => onNavigate?.(p)}>
              <Icon size={15} /> <span>{label}</span>
              {p === "workspace" && pendingCount > 0 && <span className="side-nav-badge" title="Waiting for your approval">{pendingCount}</span>}
            </button>
          ))}
        </nav>
        {codeAlerts.length > 0 && onShowCodeAlerts && (
          <button className="discovery-note code-alert" onClick={onShowCodeAlerts} title={codeAlerts.map((a) => `${a.severity}: ${a.title} (${a.file}:${a.line})`).join("\n")}>
            <ShieldAlert size={14} /> CodePilot found {codeAlerts.length} new issue{codeAlerts.length === 1 ? "" : "s"} in {Array.from(new Set(codeAlerts.map((a) => a.file))).join(", ")}
          </button>
        )}
        {newDiscoveries > 0 && onShowDiscoveries && (
          <button className="discovery-note" onClick={onShowDiscoveries}>
            <Sigma size={14} /> MathPilot found {newDiscoveries} new formula{newDiscoveries === 1 ? "" : "s"}
          </button>
        )}
        <div className="history-heading">Recent chats</div>
        <div className="history-list">
          {list === null && <p className="history-meta">Loading…</p>}
          {list?.length === 0 && <p className="history-meta">No chats yet.</p>}
          {list?.map((c) => (
            <div key={c.id} className={c.id === currentId && page === "chat" ? "history-item current" : "history-item"}>
              <button className="history-open" onClick={() => onOpen(c.id)} title={c.id.startsWith("routine-") ? "Routine results" : undefined}>
                <span className="history-title">
                  {c.id.startsWith("routine-") && <AlarmClock size={11} className="history-routine" aria-label="Routine" />} {c.title}
                </span>
                <span className="history-meta">{when(c.updatedAt)}</span>
              </button>
              {confirming === c.id ? (
                <button className="pill-btn danger" onClick={() => remove(c.id)}>
                  Delete
                </button>
              ) : (
                <button className="history-delete" onClick={() => setConfirming(c.id)} aria-label={`Delete chat: ${c.title}`} title="Delete">
                  <Trash2 size={14} />
                </button>
              )}
            </div>
          ))}
        </div>
      </aside>
    </>
  );
}
