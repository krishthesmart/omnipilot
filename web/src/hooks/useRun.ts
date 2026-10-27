import { useEffect, useRef, useState } from "react";
import { subscribeToRun } from "../api";
import type { RunEvent, RunViewState } from "../types";

function initialState(runId: string, request: string): RunViewState {
  return { runId, request, phase: "planning", agents: {}, audit: [] };
}

function reduce(state: RunViewState, evt: RunEvent): RunViewState {
  switch (evt.type) {
    case "run_started":
      return state;
    case "followup_resolved":
      return { ...state, standalone: evt.standalone };
    case "router_plan":
      return {
        ...state,
        phase: "running_agents",
        plan: evt.plan,
        agents: Object.fromEntries(evt.plan.selectedAgents.map((a) => [a, { status: "queued" as const, retries: 0 }])),
      };
    case "coordinator_plan":
      return {
        ...state,
        steps: evt.steps,
        agents: { ...Object.fromEntries(evt.steps.map((s) => [s.agent, { status: "queued" as const, retries: 0 }])), ...state.agents },
      };
    case "coordinator_followup":
      return {
        ...state,
        steps: [...(state.steps ?? []).filter((s) => s.agent !== evt.step.agent), evt.step],
        agents: { ...state.agents, [evt.step.agent]: { status: "queued" as const, retries: 0 } },
      };
    case "agent_start":
      return { ...state, agents: { ...state.agents, [evt.agent]: { status: "running" as any, startedAt: Date.now(), retries: state.agents[evt.agent]?.retries ?? 0 } } };
    case "agent_retry":
      return { ...state, agents: { ...state.agents, [evt.agent]: { ...state.agents[evt.agent], retries: evt.attempt } } };
    case "agent_complete":
      return {
        ...state,
        agents: { ...state.agents, [evt.result.agent]: { status: evt.result.status, startedAt: state.agents[evt.result.agent]?.startedAt, result: evt.result, retries: evt.result.retries } },
      };
    case "synthesizer_start":
      return { ...state, phase: "synthesizing" };
    case "answer_delta":
      return { ...state, streamingAnswer: (state.streamingAnswer ?? "") + evt.delta };
    case "synthesizer_draft":
      return { ...state, draft: evt.draft };
    case "router_review_start":
      return { ...state, phase: "reviewing" };
    case "router_review":
      return { ...state, review: evt.review };
    case "clarification_needed":
      return { ...state, phase: "clarification_needed", clarifyingQuestion: evt.question };
    case "final_response":
      return { ...state, phase: "done", finalResponse: evt.response };
    case "audit":
      return { ...state, audit: [...state.audit, evt.entry] };
    case "run_failed":
      return { ...state, phase: "failed", error: evt.error };
    case "run_cancelled":
      return { ...state, phase: "cancelled" };
    default:
      return state;
  }
}

export function useRun(runId: string, request: string) {
  const [state, setState] = useState<RunViewState>(() => initialState(runId, request));
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    setState(initialState(runId, request));
    const unsubscribe = subscribeToRun(runId, (evt) => {
      setState((prev) => reduce(prev, evt));
    });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  return state;
}
