import { useEffect, useState } from "react";
import { Plug, RefreshCw, Server, Trash2 } from "lucide-react";
import { fetchConnectors, fetchMcpServers, refreshMcpServer, removeMcpServer, type McpServerInfo } from "../api";
import { ConnectorCard } from "../components/ConnectorCard";
import type { Connector } from "../types";

// Every connection in one place: the services (all real, verified with the provider) and the MCP
// servers you've added.
export function IntegrationsPage({ onDraft }: { onDraft: (text: string) => void }) {
  const [connectors, setConnectors] = useState<Connector[] | null>(null);
  const [servers, setServers] = useState<McpServerInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = () => {
    fetchConnectors().then(setConnectors).catch((e) => setError(e.message));
    fetchMcpServers().then(setServers).catch(() => setServers([]));
  };
  useEffect(load, []);

  async function act(name: string, fn: () => Promise<unknown>) {
    setBusy(name);
    setError(null);
    try {
      await fn();
      load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  const connected = (connectors ?? []).filter((c) => c.status === "connected").length;

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>
            <Plug size={20} /> Integrations
          </h1>
          <p>
            {connectors ? `${connected} of ${connectors.length} connected. ` : ""}Every connection is real and checked with the service. Reading happens directly; anything that sends or changes something waits for your approval.
          </p>
        </div>
      </header>

      {error && (
        <p className="page-error" role="alert">
          {error}
        </p>
      )}

      <section className="page-section">
        <h3>Services</h3>
        {connectors === null ? (
          <p className="page-meta">Loading…</p>
        ) : (
          <div className="card-list">
            {connectors.map((c) => (
              <ConnectorCard
                key={c.name}
                name={c.name}
                status={c.status}
                kind={c.kind}
                verification={c.verification}
                accountLabel={c.account_label}
                onChanged={(u) => setConnectors((prev) => (prev ?? []).map((x) => (x.name === u.name ? u : x)))}
              />
            ))}
          </div>
        )}
      </section>

      <section className="page-section">
        <h3>
          <Server size={15} /> MCP servers
        </h3>
        <p className="page-meta">
          Add one in chat, for example: <code>add an MCP server called files: npx -y @modelcontextprotocol/server-filesystem ~/Documents</code>. You'll see the exact command and approve it first.
        </p>
        <button className="pill-btn fit" onClick={() => onDraft("add an MCP server called files: `npx -y @modelcontextprotocol/server-filesystem ~/Documents`")}>
          Add the files server in chat
        </button>
        <div className="card-list">
          {(servers ?? []).map((s) => (
            <div key={s.name} className="page-card">
              <div className="routine-head">
                <div>
                  <h2>{s.name}</h2>
                  <span className="page-meta">
                    {s.transport === "stdio" ? "Program on this computer" : "Web server"} · <code>{s.target.slice(0, 90)}</code>
                  </span>
                </div>
                <span className="page-actions">
                  <button className="pill-btn" disabled={busy === s.name} onClick={() => act(s.name, () => refreshMcpServer(s.name))}>
                    <RefreshCw size={13} /> Reload tools
                  </button>
                  <button className="icon-btn" onClick={() => confirm(`Remove the MCP server "${s.name}"?`) && act(s.name, () => removeMcpServer(s.name))} aria-label={`Remove ${s.name}`}>
                    <Trash2 size={14} />
                  </button>
                </span>
              </div>
              <div className="tool-list">
                {s.tools.map((t) => (
                  <span key={t.name} className="tag" title={t.description}>
                    {t.name}
                    {t.annotations?.readOnlyHint ? " · read-only" : ""}
                  </span>
                ))}
                {s.tools.length === 0 && <span className="page-meta">No tools.</span>}
              </div>
            </div>
          ))}
          {servers?.length === 0 && <p className="page-meta">No MCP servers yet.</p>}
        </div>
      </section>
    </div>
  );
}
