// OmniPilot for VS Code. Everything goes to the OmniPilot server on this computer
// (omnipilot.serverUrl); nothing is sent anywhere else by the extension itself.
// Code changes are never written silently: you see a diff and choose Apply or Discard.
const vscode = require("vscode");
const crypto = require("crypto");

const PROPOSED = "omnipilot-proposed";
const proposals = new Map(); // uri path -> proposed text
let diagnostics;

const serverUrl = () => (vscode.workspace.getConfiguration("omnipilot").get("serverUrl") || "http://localhost:8899").replace(/\/+$/, "");

async function api(path, body, timeoutMs = 400_000) {
  let res;
  try {
    res = await fetch(serverUrl() + path, {
      method: body ? "POST" : "GET",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new Error(`Can't reach OmniPilot at ${serverUrl()}. Start it with "npm start" in the OmniPilot folder (or change omnipilot.serverUrl). ${e && e.name === "TimeoutError" ? "(timed out)" : ""}`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `OmniPilot answered HTTP ${res.status}`);
  return data;
}

/** The selection, or the whole file if nothing is selected. */
function target(editor) {
  const doc = editor.document;
  const sel = editor.selection;
  const range = sel.isEmpty ? new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)) : new vscode.Range(sel.start, sel.end);
  return { doc, range, code: doc.getText(range), whole: sel.isEmpty, version: doc.version };
}

function needEditor() {
  const e = vscode.window.activeTextEditor;
  if (!e) vscode.window.showWarningMessage("Open a file first.");
  return e;
}

async function withProgress(title, fn) {
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: false }, fn);
}

/** Shows OmniPilot's proposed code as a diff, then applies it only if the user says so. */
async function reviewAndApply(t, result, label) {
  const id = crypto.randomUUID();
  const uri = vscode.Uri.from({ scheme: PROPOSED, path: `/${id}/${t.doc.fileName.split(/[\\/]/).pop()}` });
  const proposedFull = t.whole ? result.code : t.doc.getText(new vscode.Range(t.doc.positionAt(0), t.range.start)) + result.code + t.doc.getText(new vscode.Range(t.range.end, t.doc.positionAt(t.doc.getText().length)));
  proposals.set(uri.path, proposedFull);
  await vscode.commands.executeCommand("vscode.diff", t.doc.uri, uri, `OmniPilot: ${label} (proposed)`, { preview: true });
  const warnings = [...(result.checks?.syntax || []).map((s) => `Syntax: ${s}`), ...(result.checks?.newIssues || []).map((s) => `New security issue: ${s}`)];
  const msg = `${result.summary || "OmniPilot proposed a change."}${warnings.length ? `\n\n⚠️ ${warnings.join("; ")}` : "\n\n✓ Parses, and adds no new security issues."}`;
  const choice = await vscode.window.showInformationMessage(msg, { modal: true }, "Apply", "Discard");
  proposals.delete(uri.path);
  await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  if (choice !== "Apply") return;
  if (t.doc.version !== t.version) {
    vscode.window.showWarningMessage("The file changed while OmniPilot was working, so the change wasn't applied. Run it again.");
    return;
  }
  const edit = new vscode.WorkspaceEdit();
  edit.replace(t.doc.uri, t.range, result.code);
  await vscode.workspace.applyEdit(edit);
  vscode.window.setStatusBarMessage("OmniPilot: change applied (Undo with Cmd/Ctrl+Z)", 5000);
}

async function assist(mode, instruction) {
  const editor = needEditor();
  if (!editor) return;
  const t = target(editor);
  if (!t.code.trim()) return vscode.window.showWarningMessage("There's no code to work on.");
  const body = { mode, file: vscode.workspace.asRelativePath(t.doc.uri), language: t.doc.languageId, code: t.code, context: t.whole ? undefined : t.doc.getText().slice(0, 120_000), instruction };
  try {
    const label = { explain: "Explaining", fix: "Finding and fixing bugs", improve: "Improving", tests: "Writing tests", custom: "Making the change" }[mode];
    const result = await withProgress(`OmniPilot: ${label}…`, () => api("/api/code/assist", body));
    if (mode === "explain") {
      chatProvider.show(`**Explain** \`${body.file}\`${t.whole ? "" : " (selection)"}`, result.text);
    } else if (mode === "tests") {
      const doc = await vscode.workspace.openTextDocument({ language: t.doc.languageId, content: result.code });
      await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
      vscode.window.showInformationMessage(`${result.summary || "Tests written."} Save the file next to your code to keep it.`);
    } else {
      await reviewAndApply(t, result, { fix: "fix bugs", improve: "improve", custom: instruction }[mode]);
    }
  } catch (e) {
    vscode.window.showErrorMessage(String(e.message || e));
  }
}

async function scan(doc, quiet) {
  if (!/^(javascript|typescript|javascriptreact|typescriptreact|python|go)$/.test(doc.languageId)) {
    if (!quiet) vscode.window.showInformationMessage("OmniPilot scans JavaScript, TypeScript, Python and Go files.");
    return;
  }
  try {
    const { findings } = await api("/api/code/scan-text", { file: vscode.workspace.asRelativePath(doc.uri), content: doc.getText() }, 20_000);
    const sev = { critical: vscode.DiagnosticSeverity.Error, high: vscode.DiagnosticSeverity.Error, medium: vscode.DiagnosticSeverity.Warning, low: vscode.DiagnosticSeverity.Information };
    diagnostics.set(
      doc.uri,
      findings.map((f) => {
        const line = doc.lineAt(Math.max(0, Math.min(doc.lineCount - 1, f.line - 1)));
        const d = new vscode.Diagnostic(line.range, `${f.title}. Fix: ${f.fix}`, sev[f.severity] ?? vscode.DiagnosticSeverity.Warning);
        d.source = "OmniPilot";
        d.code = f.rule;
        return d;
      })
    );
    if (!quiet) vscode.window.showInformationMessage(findings.length ? `OmniPilot found ${findings.length} issue(s); see the Problems panel.` : "OmniPilot: no issues found.");
  } catch (e) {
    if (!quiet) vscode.window.showErrorMessage(String(e.message || e));
  }
}

// --- the chat panel ---
class ChatProvider {
  constructor(context) {
    this.context = context;
    this.view = null;
    this.conversationId = `vscode-${crypto.randomUUID()}`;
    this.pending = [];
  }
  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    const nonce = crypto.randomBytes(16).toString("hex");
    view.webview.html = chatHtml(nonce, view.webview.cspSource);
    view.webview.onDidReceiveMessage(async (m) => {
      if (m.type === "ask") await this.ask(m.text);
      if (m.type === "new") this.conversationId = `vscode-${crypto.randomUUID()}`;
      if (m.type === "open") vscode.env.openExternal(vscode.Uri.parse(serverUrl()));
    });
    for (const p of this.pending) view.webview.postMessage(p);
    this.pending = [];
  }
  post(msg) {
    if (this.view) this.view.webview.postMessage(msg);
    else this.pending.push(msg);
  }
  show(question, answer) {
    vscode.commands.executeCommand("omnipilot.chat.focus");
    this.post({ type: "turn", question, answer });
  }
  async ask(text) {
    this.post({ type: "thinking", question: text });
    try {
      // The SDK endpoint keeps this panel's conversation, so follow-ups work.
      const r = await api("/api/ask", { message: text.slice(0, 4000), conversationId: this.conversationId, textOnly: true });
      const extra = (r.agents || []).length ? `\n\n<small>${r.agents.map((a) => a.agent).join(" · ")}${r.status === "needs_approval" ? " · has an action waiting for approval: open OmniPilot in the browser to approve it" : ""}</small>` : "";
      this.post({ type: "answer", answer: (r.answer || "(no answer)") + extra });
    } catch (e) {
      this.post({ type: "answer", answer: `⚠️ ${e.message || e}` });
    }
  }
}

function chatHtml(nonce, csp) {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);padding:0;margin:0;display:flex;flex-direction:column;height:100vh}
#log{flex:1;overflow:auto;padding:10px}
.q{background:var(--vscode-input-background);border-radius:8px;padding:6px 9px;margin:10px 0 6px;white-space:pre-wrap}
.a{line-height:1.5}
.a pre{background:var(--vscode-textCodeBlock-background);padding:8px;border-radius:6px;overflow:auto}
.a code{font-family:var(--vscode-editor-font-family)}
.thinking{opacity:.7;font-style:italic}
form{display:flex;gap:6px;padding:8px;border-top:1px solid var(--vscode-panel-border)}
textarea{flex:1;resize:none;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,transparent);border-radius:6px;padding:6px;font:inherit}
button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;border-radius:6px;padding:0 12px;cursor:pointer}
.bar{display:flex;gap:8px;padding:6px 10px;font-size:11px;opacity:.8}.bar a{cursor:pointer;text-decoration:underline}
</style></head><body>
<div class="bar"><a id="new">New chat</a><a id="open">Open OmniPilot in the browser</a></div>
<div id="log"><p class="a">Ask OmniPilot anything: code, school, research, your files. Right-click code for Explain, Fix, Improve and Tests.</p></div>
<form id="f"><textarea id="t" rows="2" placeholder="Ask OmniPilot…"></textarea><button>Send</button></form>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const log = document.getElementById("log");
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
// A small, safe Markdown renderer: code blocks, inline code, bold, lists, links, line breaks.
function md(s) {
  const blocks = [];
  s = s.replace(/(\`\`\`|~~~)[\\w-]*\\n([\\s\\S]*?)\\1/g, (_, f, code) => { blocks.push("<pre><code>" + esc(code) + "</code></pre>"); return "\\u0000" + (blocks.length - 1) + "\\u0000"; });
  s = esc(s).replace(/&lt;small&gt;([\\s\\S]*?)&lt;\\/small&gt;/g, "<small>$1</small>");
  s = s.replace(/\`([^\`]+)\`/g, "<code>$1</code>").replace(/\\*\\*([^*]+)\\*\\*/g, "<b>$1</b>")
       .replace(/\\[([^\\]]+)\\]\\((https?:[^)\\s]+)\\)/g, '<a href="$2">$1</a>')
       .replace(/^\\s*[-*] (.*)$/gm, "• $1").replace(/\\n/g, "<br>");
  return s.replace(/\\u0000(\\d+)\\u0000/g, (_, i) => blocks[i]);
}
function add(cls, html) { const d = document.createElement("div"); d.className = cls; d.innerHTML = html; log.appendChild(d); log.scrollTop = log.scrollHeight; return d; }
let thinking = null;
window.addEventListener("message", (e) => {
  const m = e.data;
  if (m.type === "thinking") { add("q", esc(m.question)); thinking = add("a thinking", "OmniPilot is working…"); }
  if (m.type === "answer") { if (thinking) thinking.remove(); thinking = null; add("a", md(m.answer)); }
  if (m.type === "turn") { add("q", md(m.question)); add("a", md(m.answer)); }
});
const t = document.getElementById("t");
document.getElementById("f").addEventListener("submit", (e) => { e.preventDefault(); const v = t.value.trim(); if (!v) return; t.value = ""; vscode.postMessage({ type: "ask", text: v }); });
t.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); document.getElementById("f").requestSubmit(); } });
document.getElementById("new").onclick = () => { log.innerHTML = ""; vscode.postMessage({ type: "new" }); };
document.getElementById("open").onclick = () => vscode.postMessage({ type: "open" });
</script></body></html>`;
}

let chatProvider;

function activate(context) {
  diagnostics = vscode.languages.createDiagnosticCollection("omnipilot");
  chatProvider = new ChatProvider(context);
  context.subscriptions.push(
    diagnostics,
    vscode.window.registerWebviewViewProvider("omnipilot.chat", chatProvider, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.workspace.registerTextDocumentContentProvider(PROPOSED, { provideTextDocumentContent: (uri) => proposals.get(uri.path) ?? "" }),
    vscode.commands.registerCommand("omnipilot.explain", () => assist("explain")),
    vscode.commands.registerCommand("omnipilot.fix", () => assist("fix")),
    vscode.commands.registerCommand("omnipilot.improve", () => assist("improve")),
    vscode.commands.registerCommand("omnipilot.tests", () => assist("tests")),
    vscode.commands.registerCommand("omnipilot.edit", async () => {
      const instruction = await vscode.window.showInputBox({ prompt: "What should change?", placeHolder: "e.g. add input validation and a docstring" });
      if (instruction) await assist("custom", instruction);
    }),
    vscode.commands.registerCommand("omnipilot.scan", () => {
      const e = needEditor();
      if (e) scan(e.document, false);
    }),
    vscode.commands.registerCommand("omnipilot.askSelection", async () => {
      const e = needEditor();
      if (!e) return;
      const t = target(e);
      const q = await vscode.window.showInputBox({ prompt: "Your question about this code" });
      if (!q) return;
      vscode.commands.executeCommand("omnipilot.chat.focus");
      const fence = "```";
      await chatProvider.ask(`${q}\n\n${fence}${t.doc.languageId}\n${t.code.slice(0, 3500)}\n${fence}`);
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (vscode.workspace.getConfiguration("omnipilot").get("scanOnSave")) scan(doc, true);
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => diagnostics.delete(doc.uri))
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
