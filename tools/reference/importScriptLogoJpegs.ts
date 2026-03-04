import { promises as fs } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { computeMaskStats, deriveLabelFromFilename, type GrayImage } from "../../src/benchmark/referenceExtractor";

type GithubContentItem = {
  name: string;
  path: string;
  type: "file" | "dir";
  download_url: string | null;
};

const API_URL = "https://api.github.com/repos/WolframResearch/Arrival-Movie-Live-Coding/contents/ScriptLogoJpegs";
const OUT_DIR = path.resolve(process.cwd(), "data/reference/arrival-script-logo-jpegs");
const MANIFEST_PATH = path.resolve(process.cwd(), "data/reference/manifest.json");

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

async function fetchGithubList(): Promise<GithubContentItem[]> {
  const response = await fetch(API_URL, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "ceramic-local-benchmark-importer",
    },
  });
  if (!response.ok) throw new Error(`GitHub list fetch failed: ${response.status}`);
  const data = (await response.json()) as GithubContentItem[];
  return Array.isArray(data) ? data : [];
}

async function downloadFile(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { headers: { "User-Agent": "ceramic-local-benchmark-importer" } });
  if (!response.ok) throw new Error(`Failed to download ${url}: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function decodeGray(buffer: Uint8Array): Promise<GrayImage> {
  const image = sharp(buffer);
  const { data, info } = await image
    .resize(512, 512, { fit: "inside", withoutEnlargement: true })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8Array(data) };
}

async function run(): Promise<void> {
  await ensureDir(OUT_DIR);
  await ensureDir(path.dirname(MANIFEST_PATH));
  const list = await fetchGithubList();
  const files = list.filter((item) => item.type === "file" && item.download_url && /\.jpe?g$/i.test(item.name));
  const entries: Array<{
    id: string;
    sourcePath: string;
    label: string;
    tags: string[];
    aliases: string[];
    maskStats: ReturnType<typeof computeMaskStats>;
  }> = [];

  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    try {
      const bytes = await downloadFile(file.download_url as string);
      const outPath = path.join(OUT_DIR, file.name);
      await fs.writeFile(outPath, bytes);
      const gray = await decodeGray(bytes);
      const maskStats = computeMaskStats(gray);
      const id = file.name.replace(/\.[a-z0-9]+$/i, "").toLowerCase();
      const label = deriveLabelFromFilename(file.name);
      const tokens = label
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length > 1);
      const tags = [...new Set(tokens)];
      const aliases = [id, label.toLowerCase(), label.toLowerCase().replace(/\s+/g, "_")];
      entries.push({
        id,
        sourcePath: path.relative(process.cwd(), outPath).replace(/\\/g, "/"),
        label,
        tags,
        aliases,
        maskStats,
      });
      console.log(`[import] ${i + 1}/${files.length} ${file.name}`);
    } catch (error) {
      console.warn(`[import] skipped ${file.name}`, error instanceof Error ? error.message : String(error));
    }
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    source: "WolframResearch/Arrival-Movie-Live-Coding ScriptLogoJpegs",
    entries,
  };
  await fs.writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2), "utf8");
  console.log(`[import] wrote ${entries.length} entries to ${path.relative(process.cwd(), MANIFEST_PATH)}`);
}

void run().catch((error) => {
  console.error("[import] failed", error);
  process.exit(1);
});
