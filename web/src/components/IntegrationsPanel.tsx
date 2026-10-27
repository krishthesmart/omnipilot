import { useEffect, useState } from "react";
import { Plug, X } from "lucide-react";
import { fetchConnectors } from "../api";
import { ConnectorCard } from "./ConnectorCard";
import type { Connector } from "../types";

export function IntegrationsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    fetchConnectors()
      .then(setConnectors)
      .finally(() => setLoading(false));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  function applyUpdate(updated: Connector) {
    setConnectors((prev) => prev.map((c) => (c.name === updated.name ? updated : c)));
  }

  if (!open) return null;

  return (
    <div className="integrations-overlay" onClick={onClose}>
      <div className="integrations-panel" onClick={(e) => e.stopPropagation()}>
        <div className="integrations-header">
          <h3>
            <Plug size={17} /> Integrations
          </h3>
          <button className="close-btn" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <p className="integrations-sub">
          Token-verified connectors call the provider's own API to confirm a real connection. Simulated connectors (no plain-token
          auth available) just flip a local flag and are labeled as such.
        </p>
        {loading && <p className="empty-note">Loading…</p>}
        <div className="integrations-list">
          {connectors.map((c) => (
            <ConnectorCard
              key={c.name}
              name={c.name}
              status={c.status}
              kind={c.kind}
              verification={c.verification}
              accountLabel={c.account_label}
              onChanged={applyUpdate}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
