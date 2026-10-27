import { useEffect, useState } from "react";
import { History, Trash2, X } from "lucide-react";
import { deleteConversation, fetchConversations, type ConversationSummary } from "../api";

function when(iso: string): string {
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days === 0) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (days === 1) return "Yesterday";
  if (days < 7) return d.toLocaleDateString([], { weekday: "long" });
  return d.toLocaleDateString();
}

/** Past conversations, kept on this computer. */
export function HistoryPanel({
  open,
  onClose,
  currentId,
  onOpen,
  onDeleted,
}: {
  open: boolean;
  onClose: () => void;
  currentId: string;
  onOpen: (id: string) => void;
  onDeleted: (id: string) => void;
}) {
  const [list, setList] = useState<ConversationSummary[] | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setConfirming(null);
    fetchConversations().then(setList);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  async function remove(id: string) {
    await deleteConversation(id);
    setList((l) => (l ?? []).filter((c) => c.id !== id));
    setConfirming(null);
    onDeleted(id);
  }

  return (
    <div className="integrations-overlay history-overlay" onClick={onClose}>
      <aside className="history-panel" role="dialog" aria-label="Chat history" onClick={(e) => e.stopPropagation()}>
        <div className="integrations-header">
          <h3>
            <History size={17} /> Chats
          </h3>
          <button className="close-btn" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <p className="integrations-sub">Saved on this computer only.</p>
        <div className="history-list">
          {list === null && <p className="model-meta">Loading…</p>}
          {list?.length === 0 && <p className="model-meta">No chats yet.</p>}
          {list?.map((c) => (
            <div key={c.id} className={c.id === currentId ? "history-item current" : "history-item"}>
              <button className="history-open" onClick={() => onOpen(c.id)}>
                <span className="history-title">{c.title}</span>
                <span className="history-meta">
                  {when(c.updatedAt)} · {c.turns} {c.turns === 1 ? "message" : "messages"}
                </span>
              </button>
              {confirming === c.id ? (
                <button className="pill-btn danger" onClick={() => remove(c.id)}>
                  Delete
                </button>
              ) : (
                <button className="icon-btn" onClick={() => setConfirming(c.id)} aria-label={`Delete chat: ${c.title}`} title="Delete">
                  <Trash2 size={14} />
                </button>
              )}
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}
