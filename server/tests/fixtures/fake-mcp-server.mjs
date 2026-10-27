// A tiny MCP server over stdio for tests: one read-only tool and one that changes things.
import readline from "node:readline";
const notes = ["buy milk"];
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
console.error("fake server starting"); // stderr noise must be ignored
process.stdout.write("not json, a stray log line\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "notes", version: "1.0" } } });
  else if (msg.method === "tools/list")
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        tools: [
          { name: "list_notes", description: "List all notes", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
          { name: "add_note", description: "Add a note", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
        ],
      },
    });
  else if (msg.method === "tools/call") {
    if (msg.params.name === "list_notes") send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: notes.join("\n") }] } });
    else if (msg.params.name === "add_note") {
      notes.push(msg.params.arguments.text);
      send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: `added (${notes.length} notes)` }] } });
    } else send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "unknown tool" } });
  } else if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no" } });
});
