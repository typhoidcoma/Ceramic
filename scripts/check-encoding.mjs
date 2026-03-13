import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve("src");
const EXTENSIONS = new Set([".wgsl", ".ts", ".tsx"]);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
      continue;
    }
    if (EXTENSIONS.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

function hasUtf8Bom(buf) {
  return buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
}

const files = walk(ROOT).sort();
const offenders = [];
for (const file of files) {
  const buf = fs.readFileSync(file);
  if (hasUtf8Bom(buf)) offenders.push(file);
}

if (offenders.length > 0) {
  console.error("UTF-8 BOM detected in source files:");
  for (const file of offenders) {
    console.error(` - ${path.relative(process.cwd(), file)}`);
  }
  process.exit(1);
}

console.log(`Encoding check passed (${files.length} files scanned, no BOM).`);