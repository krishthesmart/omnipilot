import { useState } from "react";
import { LogIn } from "lucide-react";
import { OmniMark } from "./OmniMark";

/** Shown only when OmniPilot is hosted on a server and this browser hasn't signed in yet. */
export function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.message ?? "Couldn't sign in.");
      onSignedIn();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="signin">
      <form className="signin-card" onSubmit={submit}>
        <OmniMark size={40} />
        <h1>Sign in to OmniPilot</h1>
        <p>This OmniPilot runs on a server. Enter its password (OMNIPILOT_PASSWORD) to continue.</p>
        <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" autoFocus required />
        {error && (
          <p className="page-error" role="alert">
            {error}
          </p>
        )}
        <button className="pill-btn primary" disabled={busy || !password}>
          <LogIn size={14} /> {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
