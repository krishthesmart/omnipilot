# Security policy

OmniPilot runs on your own computer and is designed so that nothing outside it
can use it: the server listens on `127.0.0.1` only, rejects requests from other
websites and foreign `Host` headers, and only lets the Watcher extension reach
the two Watcher endpoints it needs.

## Reporting a vulnerability

Please **don't open a public issue** for security problems. Instead, use
GitHub's private vulnerability reporting (the **Security** tab → **Report a
vulnerability**) on this repository. Include what you found, how to reproduce
it, and what an attacker could do with it.

You'll get a reply within a week. Once a fix is released, you'll be credited in
the changelog unless you'd rather not be.

## Areas we especially care about

- Anything that lets another website, device or user reach the API
- Escapes from CodePilot's code sandbox (`server/src/lib/sandbox.ts`)
- Ways around WatcherPilot's parent PIN or the extension's blocking
- Leaks of integration tokens or the PIN hash
