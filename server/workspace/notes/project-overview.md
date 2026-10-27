# Project Overview — Internal Notes

OmniPilot is a chat-first multi-agent assistant. Current focus areas for
improvement, gathered from the last retro:

- The `Router` currently uses a keyword-based decision model; consider
  adding evaluation metrics to track mis-routes over time.
- `CodePilot`'s static scanner only covers JS/TS heuristics; Python and Go
  rules are still open work.
- Onboarding docs for new specialists (how to implement the `AgentResult`
  contract) are incomplete — see `docs/agent-contract.md`.
- Performance: parallel agent timeouts are fixed at 8s; some ScienceLab
  simulations may need longer budgets for large input sweeps.
- Security: approval flow for high-risk actions needs a UI affordance for
  "why is this risky" explanations.

## Next steps
1. Add regression tests for the orchestrator's isolation guarantees.
2. Expand Helper's search to support approved cloud folders (not just local).
3. Write user-facing docs on what "Not connected" connectors mean.
