# Agent Result Contract

Every specialist agent must return a structured `AgentResult`:

- `agent`: the specialist's name
- `status`: one of success, partial_success, needs_connection,
  missing_permissions, timeout, unreachable, failed_safe, needs_approval
- `findings`: plain-language findings, no fabrication
- `evidence`: sources/citations backing each finding
- `confidence`: 0..1, calibrated to how certain the agent is
- `limitations`: anything the agent could not verify or access
- `proposedActions`: any write/external actions, tagged with risk level

Agents must be read-only by default and must never silently invent data to
fill a gap. If a capability isn't implemented yet, return status
`failed_safe` (or the most specific status) with a finding that literally
says "Not implemented."
