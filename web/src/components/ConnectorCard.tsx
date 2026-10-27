import { useEffect, useState } from "react";
import { KeyRound, Link2, Unlink, ShieldCheck } from "lucide-react";
import { connectConnector, disconnectConnector, fetchConnectors, startDriveSignIn, ConnectorError } from "../api";
import type { Connector } from "../types";

export interface ConnectorEntry {
  name: string;
  status: string;
  kind?: string;
  verification?: "token" | "oauth";
  accountLabel?: string | null;
}

export function ConnectorCard({ name, status, kind, verification, accountLabel, onChanged }: ConnectorEntry & { onChanged?: (updated: Connector) => void }) {
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState("");
  const [account, setAccount] = useState("");
  const isGmail = name === "Gmail";
  const isOauth = verification === "oauth";
  const [secret, setSecret] = useState("");
  const [waiting, setWaiting] = useState(false);

  // After opening Google's sign-in, watch for the connection to complete (up to 5 minutes).
  useEffect(() => {
    if (!waiting) return;
    let tries = 0;
    const timer = setInterval(async () => {
      tries++;
      const c = (await fetchConnectors().catch(() => [])).find((x) => x.name === name);
      if (c?.status === "connected") {
        setWaiting(false);
        setShowTokenInput(false);
        onChanged?.(c);
      } else if (tries > 150) setWaiting(false);
    }, 2000);
    return () => clearInterval(timer);
  }, [waiting, name, onChanged]);

  async function signIn() {
    setError(null);
    setBusy(true);
    try {
      const url = await startDriveSignIn(token, secret);
      window.open(url, "_blank", "noopener");
      setWaiting(true);
    } catch (err) {
      setError(err instanceof ConnectorError ? err.message : "Couldn't start the sign-in");
    } finally {
      setBusy(false);
    }
  }
  const [error, setError] = useState<string | null>(null);
  const [showTokenInput, setShowTokenInput] = useState(false);
  const connected = status === "connected";
  const isTokenConnector = verification === "token";

  async function handleConnect() {
    setError(null);
    if (isOauth) {
      if (!showTokenInput) setShowTokenInput(true);
      else await signIn();
      return;
    }
    if (isTokenConnector && !showTokenInput) {
      setShowTokenInput(true);
      return;
    }
    setBusy(true);
    try {
      const updated = await connectConnector(name, isTokenConnector ? token : undefined, isGmail ? account : undefined);
      setToken("");
      setShowTokenInput(false);
      onChanged?.(updated);
    } catch (err) {
      setError(err instanceof ConnectorError ? err.message : "Connection failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleDisconnect() {
    setBusy(true);
    try {
      const updated = await disconnectConnector(name);
      onChanged?.(updated);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`connector-card ${connected ? "connected" : "not-connected"}`}>
      <div className="connector-main">
        <span className="connector-name">{name}</span>
        {kind && <span className="connector-kind">{kind.replace(/_/g, " ")}</span>}
        <span className={`connector-status-pill ${connected ? "status-success" : "status-warn"}`}>
          {connected ? `Connected${accountLabel ? ` as ${accountLabel}` : ""}` : "Not connected"}
        </span>
        <span className="verification-pill token">
          <ShieldCheck size={10} style={{ verticalAlign: "-1px" }} />{" "}
          {connected ? "verified" : isOauth ? "Google sign-in" : isGmail ? "app password" : name === "Google Calendar" ? "calendar link" : "token"}
        </span>
      </div>

      {!connected && (
        <div className="connector-actions">
          {showTokenInput && isGmail && (
            <>
              <p className="connector-help">
                Read-only, free: turn on 2-Step Verification in your Google Account, then create an{" "}
                <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer">app password</a> and paste it here. OmniPilot only reads mail
                (it never marks it read, moves or deletes it) and saves drafts only when you approve.
              </p>
              <input className="connector-token-input" type="email" placeholder="you@gmail.com" value={account} onChange={(e) => setAccount(e.target.value)} autoFocus />
            </>
          )}
          {showTokenInput && isOauth && (
            <>
              <p className="connector-help">
                One-time setup (free): in{" "}
                <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer">
                  Google Cloud
                </a>{" "}
                create a project, enable the <b>Google Drive API</b>, set up the OAuth consent screen (External, add yourself as a test user), then
                create an <b>OAuth client ID</b> of type <b>Desktop app</b> and paste its ID and secret here. OmniPilot reads your files and can create new
                docs only when you approve; it never changes or deletes your files.
              </p>
              <input className="connector-token-input" placeholder="Client ID (…apps.googleusercontent.com)" value={token} onChange={(e) => setToken(e.target.value)} autoFocus />
              <input className="connector-token-input" type="password" placeholder="Client secret" value={secret} onChange={(e) => setSecret(e.target.value)} />
            </>
          )}
          {showTokenInput && !isOauth && (
            <input
              className="connector-token-input"
              type="password"
              placeholder={isGmail ? "16-letter app password" : `Paste ${name} token…`}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoFocus={!isGmail}
            />
          )}
          <button className="connector-connect-btn" disabled={busy || waiting || (showTokenInput && (!token.trim() || (isGmail && !account.trim()) || (isOauth && !secret.trim())))} onClick={handleConnect}>
            {showTokenInput ? <KeyRound size={13} /> : <Link2 size={13} />}
            {waiting ? "Waiting for Google…" : busy ? "Connecting…" : isOauth ? "Sign in with Google" : showTokenInput ? "Verify & Connect" : isGmail ? "Connect Gmail" : name === "Google Calendar" ? "Connect calendar" : "Connect with token"}
          </button>
        </div>
      )}
      {connected && (
        <button className="connector-disconnect-btn" disabled={busy} onClick={handleDisconnect}>
          <Unlink size={13} /> Disconnect
        </button>
      )}
      {error && <div className="connector-error">{error}</div>}
    </div>
  );
}

/** Pulls connector cards out of an agent's evidence (InfraPilot tags entries as "connector:<name>"). */
export function extractConnectorEntries(evidence: { source: string; detail: string }[]): ConnectorEntry[] {
  return evidence
    .filter((e) => e.source.startsWith("connector:"))
    .map((e) => {
      try {
        const parsed = JSON.parse(e.detail);
        return { name: parsed.name, status: parsed.status, kind: parsed.kind, verification: parsed.verification, accountLabel: parsed.accountLabel };
      } catch {
        return { name: e.source.replace("connector:", ""), status: "not_connected" };
      }
    });
}
