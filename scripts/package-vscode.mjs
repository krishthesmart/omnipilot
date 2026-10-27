// Builds ide/vscode/omnipilot-<version>.vsix (a zip in VS Code's extension format) with no extra
// tools. Install it with: code --install-extension ide/vscode/omnipilot-<version>.vsix
// (or in VS Code: Extensions view > ... > Install from VSIX).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "ide", "vscode");
const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
const files = ["package.json", "extension.js", "README.md", "media/icon.png", "media/omnipilot.svg"].filter((f) => fs.existsSync(path.join(dir, f)));

const manifest = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="${pkg.name}" Version="${pkg.version}" Publisher="${pkg.publisher}" />
    <DisplayName>${pkg.displayName}</DisplayName>
    <Description xml:space="preserve">${pkg.description.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</Description>
    <Categories>${pkg.categories.join(",")}</Categories>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${pkg.engines.vscode}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
    </Properties>
    <Icon>extension/media/icon.png</Icon>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code" /></Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/media/icon.png" Addressable="true" />
  </Assets>
</PackageManifest>`;
const contentTypes = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".json" ContentType="application/json" /><Default Extension=".js" ContentType="application/javascript" />
  <Default Extension=".md" ContentType="text/markdown" /><Default Extension=".png" ContentType="image/png" />
  <Default Extension=".svg" ContentType="image/svg+xml" /><Default Extension=".vsixmanifest" ContentType="text/xml" />
</Types>`;

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b) => {
  let c = 0xffffffff;
  for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const entries = [
  ["extension.vsixmanifest", Buffer.from(manifest)],
  ["[Content_Types].xml", Buffer.from(contentTypes)],
  ...files.map((f) => [`extension/${f}`, fs.readFileSync(path.join(dir, f))]),
];
const parts = [];
const central = [];
let offset = 0;
for (const [name, data] of entries) {
  const n = Buffer.from(name);
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26);
  parts.push(local, n, data);
  const c = Buffer.alloc(46);
  c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt32LE(crc, 16);
  c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42);
  central.push(c, n);
  offset += 30 + n.length + data.length;
}
const cd = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
const out = path.join(dir, `omnipilot-${pkg.version}.vsix`);
fs.writeFileSync(out, Buffer.concat([...parts, cd, end]));
console.log(`wrote ${path.relative(process.cwd(), out)} (${entries.length} files)`);
