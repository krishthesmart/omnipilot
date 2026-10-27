"""Service adapters. Each declares the environment variable(s) it needs, the kinds of jobs it does, a
rough cost per call, how to do a job, and the cheapest call that proves its key works (verify)."""
from __future__ import annotations

from ..base import Budget
from ... import envfiles


class Provider:
    name: str = ""
    label: str = ""
    env: tuple[str, ...] = ()
    kinds: tuple[str, ...] = ()
    # Rough cost per call in USD, for the shared budget (free-tier usage still counts, to avoid waste).
    cost: dict[str, float] = {}
    docs: str = ""

    def configured(self) -> bool:
        return all(envfiles.is_set(e) for e in self.env)

    def missing(self) -> list[str]:
        return [e for e in self.env if not envfiles.is_set(e)]

    def accepts(self, kind: str, args: dict) -> bool:
        """Whether this service can do this particular job (e.g. the tool name is in its format)."""
        return True

    def est_cost(self, kind: str) -> float:
        return self.cost.get(kind, self.cost.get("*", 0.001))

    async def run(self, kind: str, args: dict, budget: Budget, timeout: float) -> dict:
        raise NotImplementedError

    async def verify(self, timeout: float) -> str:
        """Returns a short description of what worked; raises ToolError if it didn't."""
        raise NotImplementedError
