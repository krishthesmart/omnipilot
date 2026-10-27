import { useMemo, useState } from "react";
import { Copy, Download, FileCode2, Check } from "lucide-react";

// A project CodePilot built: browse every file before approving it, copy a file, or download the
// whole project as a .zip.

interface File {
  path: string;
  content: string;
  language: string;
}

// --- a tiny .zip writer (stored, no compression): enough for source files ---
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (b: Uint8Array) => {
  let c = 0xffffffff;
  for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

export function zipFiles(files: { path: string; content: string }[]): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.path);
    const data = enc.encode(f.content);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    chunks.push(new Uint8Array(local.buffer), name, data);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true);
    cen.setUint16(4, 20, true);
    cen.setUint16(6, 20, true);
    cen.setUint16(8, 0x0800, true);
    cen.setUint32(16, crc, true);
    cen.setUint32(20, data.length, true);
    cen.setUint32(24, data.length, true);
    cen.setUint16(28, name.length, true);
    cen.setUint32(42, offset, true);
    central.push(new Uint8Array(cen.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  const all = [...chunks, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(new ArrayBuffer(all.reduce((n, c) => n + c.length, 0)));
  let at = 0;
  for (const c of all) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

export function CodeProject({ title, folder, files, checks, run, test }: { title: string; folder: string; files: File[]; checks: string; run: string; test: string }) {
  const sorted = useMemo(() => [...files].sort((a, b) => (a.path.split("/").length - b.path.split("/").length) || a.path.localeCompare(b.path)), [files]);
  const [open, setOpen] = useState(sorted.find((f) => /readme/i.test(f.path))?.path ?? sorted[0]?.path);
  const [copied, setCopied] = useState(false);
  const file = sorted.find((f) => f.path === open);
  const lines = (file?.content ?? "").split("\n").length;

  function downloadZip() {
    const name = folder.split("/").pop() || "project";
    const blob = new Blob([zipFiles(files.map((f) => ({ path: `${name}/${f.path}`, content: f.content })))], { type: "application/zip" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name}.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <div className="code-project">
      <div className="code-project-head">
        <FileCode2 size={15} />
        <strong>{title}</strong>
        <span className="code-project-meta">
          {files.length} files · {folder}/
        </span>
        <button onClick={downloadZip} title="Download the whole project">
          <Download size={13} /> .zip
        </button>
      </div>
      <div className="code-project-body">
        <nav className="code-project-tree" aria-label="Project files">
          {sorted.map((f) => (
            <button key={f.path} className={f.path === open ? "on" : ""} onClick={() => setOpen(f.path)} style={{ paddingLeft: 8 + 10 * (f.path.split("/").length - 1) }}>
              {f.path.split("/").pop()}
              {f.path.includes("/") && <span className="code-project-dir">{f.path.split("/").slice(0, -1).join("/")}/</span>}
            </button>
          ))}
        </nav>
        <div className="code-project-file">
          <div className="code-project-file-head">
            <span>
              {open} · {lines} lines
            </span>
            <button
              onClick={() => {
                navigator.clipboard?.writeText(file?.content ?? "");
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              }}
            >
              {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <pre>
            <code>{file?.content}</code>
          </pre>
        </div>
      </div>
      <div className="code-project-foot">
        <span>{checks}</span>
        {run && (
          <span>
            Run: <code>{run}</code>
            {test ? (
              <>
                {" "}
                · Test: <code>{test}</code>
              </>
            ) : null}
          </span>
        )}
      </div>
    </div>
  );
}
