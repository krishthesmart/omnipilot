"""Sending email with Resend. Every send needs the user's approval first (args["approved"]); the
sender must be an address on a domain verified in Resend (until then Resend only allows its test
address onboarding@resend.dev, which can only send to the account owner's own email)."""
from __future__ import annotations

from ..base import ToolError, http
from ... import envfiles
from . import Provider


class Resend(Provider):
    name, label, env, kinds = "resend", "Resend (email sending)", ("RESEND_API_KEY",), ("send_email",)
    cost = {"send_email": 0.0}
    docs = "https://resend.com/docs/api-reference/emails/send-email"

    def _headers(self):
        return {"Authorization": f"Bearer {envfiles.secret('RESEND_API_KEY')}", "Content-Type": "application/json"}

    async def run(self, kind, args, budget, timeout):
        if not args.get("approved"):
            raise ToolError(self.name, "sending email needs your approval first", code="needs_approval", retry_elsewhere=False)
        payload = {"from": args.get("from") or "OmniPilot <onboarding@resend.dev>", "to": args["to"] if isinstance(args["to"], list) else [args["to"]], "subject": args["subject"][:300], "text": args["text"][:100_000]}
        res = await http(self.name, "POST", "https://api.resend.com/emails", timeout=timeout, retries=0, headers=self._headers(), json=payload)
        return {"sent": True, "id": res.json().get("id")}

    async def verify(self, timeout):
        try:
            res = await http(self.name, "GET", "https://api.resend.com/domains", timeout=timeout, retries=0, headers=self._headers())
        except ToolError as err:
            # A sending-only key can't list domains, but Resend says so by name: the key itself is valid.
            if err.code == "auth" and "restricted" in str(err).lower():
                return "key accepted (sending-only key)"
            raise
        domains = res.json().get("data") or []
        verified = [d.get("name") for d in domains if d.get("status") == "verified"]
        return f"key accepted ({len(verified)} verified sending domain{'s' if len(verified) != 1 else ''}{': ' + ', '.join(verified) if verified else '; until you verify one, only test emails to your own address work'})"
