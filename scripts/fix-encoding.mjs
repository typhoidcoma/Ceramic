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
let changed = 0;
for (const file of files) {
  const buf = fs.readFileSync(file);
  const hadBom = hasUtf8Bom(buf);
  let text = hadBom ? buf.subarray(3).toString("utf8") : buf.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }
  if (hadBom || text !== buf.toString("utf8")) {
    fs.writeFileSync(file, text, "utf8");
    changed += 1;
  }
}

console.log(`Encoding fix complete. Updated ${changed} files.`);