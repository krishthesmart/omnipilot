import { useCallback, useEffect, useRef, useState } from "react";
import { Menu } from "lucide-react";
import { fetchCodeAlerts, fetchConversation, fetchDiscoveries, fetchPendingChanges, markCodeAlertsSeen, sendChat, type Attachment, type CodeAlert } from "./api";
import { ChatTurn } from "./components/ChatTurn";
import { ChatInput } from "./components/ChatInput";
import { ChatSidebar, type Page } from "./components/ChatSidebar";
import { RoutinesPage } from "./pages/RoutinesPage";
import { SkillsPage } from "./pages/SkillsPage";
import { IntegrationsPage } from "./pages/IntegrationsPage";
import { WorkspacePage } from "./pages/WorkspacePage";
import { WatcherPanel } from "./components/WatcherPanel";
import { StatusBanner } from "./components/StatusBanner";
import { Starters } from "./components/Starters";
import { useVoice } from "./hooks/useVoice";
import { SignIn } from "./components/SignIn";
import type { WatcherPolicy } from "./types";

/** Per-browser conveniences; storage can be unavailable (private windows), so every access is guarded. */
const stored = {
  get: (key: string) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set: (key: string, value: string) => {
    try {
      localStorage.setItem(key, value);
    } catch {
      // ignore
    }
  },
};

interface Turn {
  key: string;
  runId: string;
  request: string;
}

const PAGES: Page[] = ["chat", "routines", "skills", "integrations", "workspace"];
const pageFromHash = (): Page => {
  const p = window.location.hash.replace(/^#\/?/, "") as Page;
  return PAGES.includes(p) ? p : "chat";
};

function OmniPilotApp() {
  const [turns, setTurns] = useState<Turn[]>([]);
  // Pages (#/routines, #/skills...), so the browser's back button and bookmarks work.
  const [page, setPage] = useState<Page>(pageFromHash);
  useEffect(() => {
    const onHash = () => setPage(pageFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  function navigate(p: Page) {
    if (window.location.hash !== `#/${p}`) window.location.hash = `/${p}`;
    setPage(p);
    setSidebarOpen(false);
  }
  const [draft, setDraft] = useState<{ text: string; n: number }>({ text: "", n: 0 });
  // How many changes wait for approval (a badge on the Workspace link).
  const [pendingCount, setPendingCount] = useState(0);
  useEffect(() => {
    const check = () => fetchPendingChanges().then((p) => setPendingCount(p.length)).catch(() => {});
    check();
    const id = setInterval(check, 30_000);
    return () => clearInterval(id);
  }, []);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  // A focus session suggested in an answer opens the parent's confirmation form.
  const [watcher, setWatcher] = useState<{ open: boolean; prefill?: Partial<WatcherPolicy> }>({ open: false });
  // One id per chat, so follow-ups ("now in javascript") can refer to earlier turns.
  // The current chat is remembered, so a reload brings it back.
  const [conversationId, setConversationId] = useState(() => stored.get("omnipilot.conversation") ?? crypto.randomUUID());
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sent, setSent] = useState(0);
  const counter = useRef(0);
  const mainRef = useRef<HTMLDivElement>(null);
  const voice = useVoice();
  // Hands-free voice mode: each new answer is read aloud, then the mic opens for the next question.
  const [voiceMode, setVoiceMode] = useState(() => stored.get("omnipilot.voiceMode") === "1");
  const latestRun = useRef<string | null>(null);
  const sendRef = useRef<(text: string, attachment?: Attachment) => Promise<boolean>>(async () => false);
  const sendHeard = (heard: string) => sendRef.current(heard);

  useEffect(() => {
    stored.set("omnipilot.conversation", conversationId);
  }, [conversationId]);

  // MathPilot searches for new formulas in the background; the sidebar says when it finds some.
  const [mathSeen, setMathSeen] = useState(() => Number(stored.get("omnipilot.mathSeen") ?? 0));
  const [mathNew, setMathNew] = useState<{ count: number; latest: number }>({ count: 0, latest: 0 });
  useEffect(() => {
    let alive = true;
    const check = () =>
      fetchDiscoveries(mathSeen, 100).then((found) => {
        if (alive) setMathNew({ count: found.length, latest: Math.max(mathSeen, ...found.map((d) => d.id)) });
      });
    check();
    const id = setInterval(check, 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [mathSeen]);
  // CodePilot's always-on check: new issues in the workspace's code show up in the sidebar.
  const [codeAlerts, setCodeAlerts] = useState<CodeAlert[]>([]);
  useEffect(() => {
    let alive = true;
    const check = () => fetchCodeAlerts().then((a) => alive && setCodeAlerts(a));
    check();
    const id = setInterval(check, 30_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  function showCodeAlerts() {
    const files = Array.from(new Set(codeAlerts.map((a) => a.file)));
    markCodeAlertsSeen();
    setCodeAlerts([]);
    setSidebarOpen(false);
    handleSend(`Scan ${files.join(", ")} for security bugs and suggest fixes`);
  }

  function showDiscoveries() {
    setMathSeen(mathNew.latest);
    stored.set("omnipilot.mathSeen", String(mathNew.latest));
    setSidebarOpen(false);
    handleSend("MathPilot, show me your latest math discoveries");
  }

  // Reopen the chat that was on screen before the reload.
  useEffect(() => {
    fetchConversation(conversationId).then((saved) => {
      if (saved.length) setTurns(saved.map((t) => ({ key: t.runId, runId: t.runId, request: t.request })));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function openConversation(id: string) {
    voice.stopSpeaking();
    navigate("chat");
    const saved = await fetchConversation(id);
    setConversationId(id);
    setTurns(saved.map((t) => ({ key: t.runId, runId: t.runId, request: t.request })));
    setSidebarOpen(false);
  }

  useEffect(() => {
    // Only auto-scroll once there's an actual conversation.
    if (turns.length === 0 || !mainRef.current) return;
    mainRef.current.scrollTo({ top: mainRef.current.scrollHeight, behavior: "smooth" });
  }, [turns]);

  async function handleSend(text: string, attachment?: Attachment, inConversation = conversationId) {
    setSending(true);
    try {
      const { runId } = await sendChat(text, inConversation, attachment);
      latestRun.current = runId;
      counter.current += 1;
      setTurns((prev) => [...prev, { key: `${runId}-${counter.current}`, runId, request: text }]);
      setSendError(null);
      setSent((n) => n + 1);
      return true;
    } catch (err) {
      console.error(err);
      setSendError("Couldn't send that. Is the OmniPilot server still running? Your message is still in the box.");
      return false;
    } finally {
      setSending(false);
    }
  }

  sendRef.current = handleSend;

  function toggleVoiceMode() {
    const on = !voiceMode;
    setVoiceMode(on);
    stored.set("omnipilot.voiceMode", on ? "1" : "0");
    if (!on) {
      voice.stopSpeaking();
      voice.stopListening();
    } else if (voice.canListen) voice.listen(sendHeard);
  }

  // Only the answer to the question just asked is read (never older answers loaded from history).
  const onAnswer = useCallback(
    (runId: string, text: string) => {
      if (!voiceMode || runId !== latestRun.current) return;
      voice.speak(text, () => {
        if (voice.canListen) voice.listen(sendHeard);
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [voiceMode, voice.speak, voice.listen, voice.canListen]
  );

  function newChat(): string {
    voice.stopSpeaking();
    setTurns([]);
    const id = crypto.randomUUID();
    setConversationId(id);
    setSidebarOpen(false);
    navigate("chat");
    return id;
  }

  /** From a page: start a new chat and send this. */
  function sendFromPage(text: string) {
    const id = newChat();
    handleSend(text, undefined, id);
  }

  /** From a page: start a new chat with this in the box, for the user to finish. */
  function draftFromPage(text: string) {
    newChat();
    setDraft((d) => ({ text, n: d.n + 1 }));
  }

  return (
    <div className="app-layout">
      <ChatSidebar
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        currentId={conversationId}
        refreshKey={sent}
        onOpen={openConversation}
        onNewChat={newChat}
        onDeleted={(id) => id === conversationId && newChat()}
        newDiscoveries={mathNew.count}
        onShowDiscoveries={showDiscoveries}
        codeAlerts={codeAlerts}
        onShowCodeAlerts={showCodeAlerts}
        page={page}
        onNavigate={navigate}
        pendingCount={pendingCount}
      />
      <div className="app-shell">
        <button className="sidebar-toggle icon-btn" onClick={() => setSidebarOpen(true)} aria-label="Chat history">
          <Menu size={17} />
        </button>
        <StatusBanner />
        <WatcherPanel open={watcher.open} prefill={watcher.prefill} onClose={() => setWatcher({ open: false })} />

        {page === "routines" ? (
          <main className="app-main page-main">
            <RoutinesPage onOpenChat={openConversation} />
          </main>
        ) : page === "skills" ? (
          <main className="app-main page-main">
            <SkillsPage onUse={sendFromPage} />
          </main>
        ) : page === "integrations" ? (
          <main className="app-main page-main">
            <IntegrationsPage onDraft={draftFromPage} />
          </main>
        ) : page === "workspace" ? (
          <main className="app-main page-main">
            <WorkspacePage onUse={sendFromPage} onDraft={draftFromPage} onOpenChat={openConversation} codeAlerts={codeAlerts} />
          </main>
        ) : (
        <>
        <main className="app-main" ref={mainRef}>
          {turns.length === 0 && (
            <div className="welcome-panel">
              <h1>What can I help with?</h1>
              <Starters onPick={(text) => handleSend(text)} />
            </div>
          )}
          {turns.map((t) => (
            <ChatTurn key={t.key} runId={t.runId} request={t.request} onFollowUp={handleSend} onOpenWatcher={(prefill) => setWatcher({ open: true, prefill })} onAnswer={onAnswer} />
          ))}
        </main>

        <footer className="app-footer">
          {sendError && <p className="send-error" role="alert">{sendError}</p>}
          <ChatInput onSend={handleSend} disabled={sending} voice={voice} voiceMode={voiceMode} onToggleVoiceMode={toggleVoiceMode} draft={draft} />
        </footer>
        </>
        )}
      </div>
    </div>
  );
}

/** Asks for the password first when OmniPilot is hosted on a server and this browser isn't signed in. */
export default function App() {
  const [auth, setAuth] = useState<"checking" | "needed" | "ok">("checking");
  useEffect(() => {
    fetch("/api/auth")
      .then((r) => r.json())
      .then((a: { required: boolean; signedIn: boolean }) => setAuth(a.required && !a.signedIn ? "needed" : "ok"))
      .catch(() => setAuth("ok")); // the status banner explains a server that's down
  }, []);
  if (auth === "checking") return null;
  if (auth === "needed") return <SignIn onSignedIn={() => setAuth("ok")} />;
  return <OmniPilotApp />;
}
