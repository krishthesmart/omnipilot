# OmniPilot for VS Code

Use OmniPilot from your editor. The extension talks only to the OmniPilot server running on your
own computer (`omnipilot.serverUrl`, default `http://localhost:8899`).

- **Chat panel** (OmniPilot icon in the activity bar): every OmniPilot agent, with follow-ups.
- **Right-click code > OmniPilot**: Explain, Fix bugs, Improve, Change as I describe (Cmd/Ctrl+Alt+O),
  Write tests, Security scan, Ask about the selection.
- **Nothing changes without you**: fixes and changes open as a diff, checked first (the new code must
  parse and add no new security issue), and are applied only when you click **Apply** (undo with Cmd/Ctrl+Z).
- **Security scan on save** for JavaScript, TypeScript, Python and Go: results in the Problems panel.

## Install

1. Start OmniPilot (`npm start` in the OmniPilot folder).
2. Build the package: `node scripts/package-vscode.mjs`
3. Install it: `code --install-extension ide/vscode/omnipilot-1.3.0.vsix`
   (or Extensions view > `...` > **Install from VSIX...**).
