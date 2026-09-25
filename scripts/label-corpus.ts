import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { scopeRoot } from "../src/targets.js";
import type { Call } from "./corpus.js";

type Kind = "edit" | "other" | "uncertain";
type Label = { key: number; kind: Kind; paths: string[] };
type Shard = { file: string; keys: number[] };
type Manifest = { sha256: string; occurrences: number; unique: number; shards: Shard[] };

const corpusPath = process.argv[3] ?? ".local/luna-corpus.jsonl";
const directory = process.argv[4] ?? ".local/labeling";
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

async function corpus(): Promise<{ raw: string; calls: Call[] }> {
  const raw = await readFile(corpusPath, "utf8");
  const calls = raw.trim().split("\n").map((line) => JSON.parse(line) as Call);
  if (!calls.length || calls.some((call) => !call.cwd || !call.command)) throw new Error("Invalid corpus");
  return { raw, calls };
}

async function prepare(): Promise<void> {
  const { raw, calls } = await corpus();
  try {
    const existing = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as Manifest;
    if (existing.sha256 !== digest(raw)) {
      throw new Error("A different corpus is already labeled here; choose a new output directory");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const roots = new Map<string, string>();
  for (const cwd of new Set(calls.map((call) => call.cwd))) roots.set(cwd, await scopeRoot(cwd));
  const seen = new Set<string>();
  const shards: Shard[] = [];
  let lines: string[] = [];
  let keys: number[] = [];
  let bytes = 0;
  await mkdir(join(directory, "shards"), { recursive: true });
  await mkdir(join(directory, "labels"), { recursive: true });
  async function flush(): Promise<void> {
    if (!keys.length) return;
    const file = `shard-${String(shards.length).padStart(3, "0")}.jsonl`;
    shards.push({ file, keys });
    await writeFile(join(directory, "shards", file), lines.join("\n") + "\n", { mode: 0o600 });
    lines = []; keys = []; bytes = 0;
  }
  for (const [key, call] of calls.entries()) {
    const identity = JSON.stringify([call.cwd, call.command]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    const line = JSON.stringify({ key, root: roots.get(call.cwd), cwd: call.cwd, command: call.command });
    if (keys.length && (bytes + line.length > 36_000 || keys.length >= 90)) await flush();
    lines.push(line); keys.push(key); bytes += line.length;
  }
  await flush();
  const manifest: Manifest = { sha256: digest(raw), occurrences: calls.length, unique: seen.size, shards };
  await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
  console.log(`Prepared ${manifest.unique} unique commands from ${calls.length} calls in ${shards.length} shards (${manifest.sha256}).`);
  for (const [index, shard] of shards.entries()) console.log(`${index} ${shard.file}: ${shard.keys.length} calls`);
}

async function assemble(): Promise<void> {
  const { raw, calls } = await corpus();
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as Manifest;
  if (manifest.sha256 !== digest(raw) || manifest.occurrences !== calls.length) throw new Error("Corpus changed; labels are invalid");
  const labels = new Map<number, Label>();
  const missing: string[] = [];
  for (const shard of manifest.shards) {
    let parsed: unknown;
    try { parsed = JSON.parse(await readFile(join(directory, "labels", shard.file.replace(".jsonl", ".json")), "utf8")); }
    catch { missing.push(shard.file); continue; }
    if (!Array.isArray(parsed)) throw new Error(`Expected JSON array for ${shard.file}`);
    const local = new Set<number>();
    for (const label of parsed as Label[]) {
      if (!shard.keys.includes(label.key) || local.has(label.key) || labels.has(label.key)) {
        throw new Error(`Unexpected or duplicate key ${label.key} in ${shard.file}`);
      }
      if (!["edit", "other", "uncertain"].includes(label.kind) || !Array.isArray(label.paths) ||
        label.paths.some((path) => typeof path !== "string" || !path || /[*?]/.test(path) || isAbsolute(path) ||
          path.split("/").some((part) => !part || part === "." || part === ".." || part === ".git" || part === "node_modules" || part === ".local")) ||
        (label.kind === "other" && label.paths.length) || (label.kind === "edit" && !label.paths.length)) {
        throw new Error(`Invalid label ${label.key} in ${shard.file}`);
      }
      local.add(label.key);
      labels.set(label.key, label);
    }
    if (local.size !== shard.keys.length) missing.push(`${shard.file} (${shard.keys.length - local.size} labels missing)`);
  }
  if (missing.length) throw new Error(`Incomplete labels: ${missing.join(", ")}`);
  if (labels.size !== manifest.unique) throw new Error(`Wrong unique count: ${labels.size}/${manifest.unique}`);
  const byIdentity = new Map<string, Label>();
  for (const [key, call] of calls.entries()) {
    const label = labels.get(key);
    if (label) byIdentity.set(JSON.stringify([call.cwd, call.command]), label);
  }
  const output = calls.map((call, index) => {
    const label = byIdentity.get(JSON.stringify([call.cwd, call.command]));
    if (!label) throw new Error(`Missing call ${index}`);
    return { index, id: call.id, session: call.session, kind: label.kind, paths: [...new Set(label.paths)].sort() };
  });
  await writeFile(join(directory, "all-labels.json"), JSON.stringify(output, null, 2) + "\n", { mode: 0o600 });
  console.log(`Validated ${labels.size} unique labels; expanded to all ${output.length} occurrences (${output.filter((x) => x.kind === "edit").length} edits, ${output.filter((x) => x.kind === "uncertain").length} uncertain).`);
}

/** Mechanical cleanup of outside-root paths. Every correction is recorded for review. */
async function normalize(): Promise<void> {
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as Manifest;
  const corrections: Array<{ shard: string; key: number; before: Label; after: Label }> = [];
  try {
    corrections.push(...JSON.parse(await readFile(join(directory, "path-corrections.json"), "utf8")) as typeof corrections);
  } catch { /* first pass */ }
  const previously = corrections.length;
  for (const shard of manifest.shards) {
    const labelFile = join(directory, "labels", shard.file.replace(".jsonl", ".json"));
    let rows: Label[];
    try { rows = JSON.parse(await readFile(labelFile, "utf8")) as Label[]; }
    catch { continue; }
    const input = (await readFile(join(directory, "shards", shard.file), "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as { key: number; root: string });
    const roots = new Map(input.map((row) => [row.key, row.root]));
    let dirty = false;
    const updated = rows.map((row) => {
      const root = roots.get(row.key);
      if (!root || !Array.isArray(row.paths)) return row;
      const paths = row.paths.flatMap((path) => {
        if (typeof path !== "string") return [];
        if (!isAbsolute(path)) return [path];
        const rel = relative(root, path).split("\\").join("/");
        if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) return [];
        return [rel];
      });
      const after = { ...row, paths, kind: row.kind === "edit" && !paths.length ? "other" as const : row.kind };
      if (JSON.stringify(row) !== JSON.stringify(after)) {
        dirty = true;
        corrections.push({ shard: shard.file, key: row.key, before: row, after });
      }
      return after;
    });
    if (dirty) {
      await writeFile(labelFile, JSON.stringify(updated, null, 2) + "\n", { mode: 0o600 });
    }
  }
  await writeFile(join(directory, "path-corrections.json"), JSON.stringify(corrections, null, 2) + "\n", { mode: 0o600 });
  console.log(`Normalized ${corrections.length - previously} outside-root/absolute labels (${corrections.length} total); review ${join(directory, "path-corrections.json")}.`);
}

if (process.argv[2] === "prepare") await prepare();
else if (process.argv[2] === "assemble") await assemble();
else if (process.argv[2] === "normalize") await normalize();
else throw new Error("Usage: tsx scripts/label-corpus.ts prepare|normalize|assemble [corpus] [output-dir]");
