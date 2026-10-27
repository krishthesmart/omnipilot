import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { fetchStatus, type AppStatus } from "../api";

/** Tells people, in plain words, when the AI (Groq) or the server itself isn't available, and how to fix it. */
export function StatusBanner() {
  const [status, setStatus] = useState<AppStatus | null | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    const load = () => fetchStatus().then((s) => alive && setStatus(s));
    load();
    const t = setInterval(load, 20_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (status === undefined) return null;
  if (status === null) {
    return (
      <div className="status-banner error" role="alert">
        <AlertTriangle size={15} /> Can't reach the OmniPilot server. Start it with <code>npm start</code>, then reload this page.
      </div>
    );
  }
  if (!status.ai.configured) {
    return (
      <div className="status-banner" role="status">
        <AlertTriangle size={15} /> One more step: OmniPilot's AI runs on Groq. Get a free key at{" "}
        <a href="https://console.groq.com/keys" target="_blank" rel="noreferrer">console.groq.com/keys</a> and add <code>GROQ_API_KEY=...</code> to <code>server/.env</code>, then restart.
      </div>
    );
  }
  if (!status.ai.reachable) {
    return (
      <div className="status-banner" role="status">
        <AlertTriangle size={15} /> The AI isn't available right now ({status.ai.problem ?? "can't reach Groq"}), so answers are limited to built-in knowledge.
      </div>
    );
  }
  // Running low on (or out of) Groq's free daily allowance: say so before a big job fails.
  if (status.ai.budgetWarning) {
    return (
      <div className="status-banner" role="status">
        <AlertTriangle size={15} /> {status.ai.budgetWarning}
      </div>
    );
  }
  return null;
}
