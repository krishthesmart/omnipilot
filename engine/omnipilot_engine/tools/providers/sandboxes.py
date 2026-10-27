"""Running commands in throwaway cloud machines: E2B (first choice) and Daytona (backup). Never on the
user's computer. Each job gets a fresh sandbox with a lifetime limit, and it's always deleted."""
from __future__ import annotations

import asyncio

from ..base import ToolError
from ... import envfiles
from . import Provider

PROJECT_DIR = "/home/user/project"


def _out(command: str, exit_code: int, stdout: str, stderr: str) -> dict:
    tail = lambda s: s[-6000:] if s else ""
    return {"command": command, "exit_code": exit_code, "stdout": tail(stdout), "stderr": tail(stderr)}


class E2B(Provider):
    name, label, env, kinds = "e2b", "E2B", ("E2B_API_KEY",), ("run_code",)
    cost = {"run_code": 0.002}
    docs = "https://e2b.dev/docs"

    async def run(self, kind, args, budget, timeout):
        """args: commands (list), files ({path: text})."""
        from e2b import AsyncSandbox

        sbx = None
        try:
            sbx = await AsyncSandbox.create(timeout=int(min(timeout + 30, 900)), api_key=envfiles.secret("E2B_API_KEY"))
            for path, text in (args.get("files") or {}).items():
                await sbx.files.write(f"{PROJECT_DIR}/{path}", text)
            await sbx.commands.run(f"mkdir -p {PROJECT_DIR}")
            runs = []
            for cmd in args["commands"]:
                try:
                    r = await sbx.commands.run(cmd, cwd=PROJECT_DIR, timeout=int(min(timeout, 300)))
                    runs.append(_out(cmd, r.exit_code, r.stdout, r.stderr))
                except Exception as err:  # a non-zero exit arrives as an error carrying the output
                    runs.append(_out(cmd, getattr(err, "exit_code", 1) or 1, getattr(err, "stdout", "") or "", getattr(err, "stderr", "") or str(err)))
            return {"runs": runs}
        except ToolError:
            raise
        except Exception as err:
            msg = str(err)
            raise ToolError(self.name, f"E2B failed: {msg[:160]}", code="auth" if "401" in msg or "nauthor" in msg else "failed")
        finally:
            if sbx is not None:
                try:
                    await asyncio.wait_for(sbx.kill(), timeout=15)
                except Exception:
                    pass  # E2B ends it when its lifetime runs out

    async def verify(self, timeout):
        r = await self.run("run_code", {"commands": ["echo verified"]}, None, timeout)
        return f"sandbox ran a command (output: {r['runs'][0]['stdout'].strip()})"


class Daytona(Provider):
    name, label, env, kinds = "daytona", "Daytona", ("DAYTONA_API_KEY",), ("run_code",)
    cost = {"run_code": 0.003}
    docs = "https://www.daytona.io/docs"

    def _client(self):
        from daytona import AsyncDaytona, DaytonaConfig

        return AsyncDaytona(DaytonaConfig(api_key=envfiles.secret("DAYTONA_API_KEY")))

    async def run(self, kind, args, budget, timeout):
        client = self._client()
        sandbox = None
        try:
            sandbox = await client.create(timeout=min(timeout, 120))
            for path, text in (args.get("files") or {}).items():
                await sandbox.fs.upload_file(text.encode(), f"{PROJECT_DIR}/{path}")
            runs = []
            for cmd in args["commands"]:
                r = await sandbox.process.exec(cmd, cwd=PROJECT_DIR if args.get("files") else None, timeout=int(min(timeout, 300)))
                runs.append(_out(cmd, r.exit_code, r.result or "", ""))
            return {"runs": runs}
        except Exception as err:
            raise ToolError(self.name, f"Daytona failed: {type(err).__name__}: {str(err)[:160]}")
        finally:
            if sandbox is not None:
                try:
                    await asyncio.wait_for(client.delete(sandbox), timeout=30)
                except Exception:
                    pass
            try:
                await client.close()
            except Exception:
                pass

    async def verify(self, timeout):
        # Free check: listing sandboxes proves the key without starting one.
        client = self._client()
        try:
            n = 0
            async for _ in client.list():
                n += 1
                if n >= 1:
                    break
            return "key accepted (sandbox list readable)"
        except Exception as err:
            raise ToolError(self.name, f"Daytona rejected the request: {type(err).__name__}: {str(err)[:140]}", code="auth")
        finally:
            try:
                await client.close()
            except Exception:
                pass
