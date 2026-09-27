import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { extractTargets } from "../src/targets.js";
import { isReadOnly } from "./readonly.js";
import { family, type Call } from "./corpus.js";

/**
 * Draws a stratified, per-model-family labeling sample from a private corpus.
 *
 * Read-only commands (by the strict classifier) are assumed not to edit. The
 * rest split into "flagged" (the current parser or a broad write hint fires),
 * where nearly all edits live, and "rest", sampled lightly to measure what the
 * flag misses. The eval reweights each stratum by its pool size.
 */

export interface Sampled extends Call {
  key: number;
  family: string;
  root: string;
  stratum: "flagged" | "rest";
  split: "dev" | "holdout";
}

export interface Strata {
  [family: string]: { flagged: { pool: number; sampled: number }; rest: { pool: number; sampled: number } };
}

const FLAGGED_PER_FAMILY = 300;
const REST_PER_FAMILY = 80;
const SHARD_SIZE = 110;
const FAMILIES = ["claude", "gpt", "glm", "deepseek", "kimi"];

// Only used to stratify the sample. Deliberately broad.
const WRITE_HINT = new RegExp([
  String.raw`(?:^|[^<>&0-9])\d?>>?\s*(?!&|/dev/null)\S`,
  String.raw`\b(?:sed|perl|ruby)\s[^|;&\n]*-\w*i`,
  String.raw`\btee\b`,
  String.raw`\b(?:python\d?(?:\.\d+)?|node|bun|deno|ruby|perl|php)\b[^|;&\n]*(?:\s-[ceE]\b|<<|\s\S+\.(?:py|m?js|ts|rb|pl|php)\b)`,
  String.raw`(?:^|[\s;&|(])(?:cp|mv|rm|touch|ln|install|patch|truncate|dd|ed|ex|unlink)\s`,
  String.raw`\bgit\s+(?:mv|rm|apply|checkout\s+--|restore)\b`,
].join("|"));

/** The enclosing Git worktree, or `cwd`: what labelers see as the project. */
export async function scopeRoot(cwd: string): Promise<string> {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    try { await access(join(dir, ".git")); return dir; } catch { /* try the parent */ }
    if (dir === dirname(dir)) return resolve(cwd);
  }
}

const rank = (seed: string) => createHash("sha256").update(seed).digest().readUInt32BE(0);

async function main(): Promise<void> {
  const input = process.argv[2] ?? ".local/corpus.jsonl";
  const out = process.argv[3] ?? ".local/eval";
  const calls = (await readFile(input, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Call);
  const seen = new Set<string>();
  const pools = new Map<string, Array<Omit<Sampled, "key">>>();
  for (const call of calls) {
    const group = family(call);
    const unique = `${call.cwd}\0${call.command}`;
    if (!FAMILIES.includes(group) || seen.has(unique) || !existsSync(call.cwd)) continue;
    seen.add(unique);
    if (await isReadOnly(call.command).catch(() => false)) continue;
    const root = await scopeRoot(call.cwd);
    const parsed = (await extractTargets(call.command, call.cwd).catch(() => [])).length > 0;
    const stratum = parsed || WRITE_HINT.test(call.command) ? "flagged" : "rest";
    // Split by session so fixes tuned on dev sessions are scored on unseen ones.
    const split = rank(`split:${call.session}`) % 2 ? "holdout" : "dev";
    const pool = `${group}:${stratum}`;
    if (!pools.has(pool)) pools.set(pool, []);
    pools.get(pool)!.push({ ...call, family: group, root, stratum, split });
  }
  const strata: Strata = {};
  const sample: Sampled[] = [];
  for (const group of FAMILIES) {
    strata[group] = { flagged: { pool: 0, sampled: 0 }, rest: { pool: 0, sampled: 0 } };
    for (const stratum of ["flagged", "rest"] as const) {
      const pool = pools.get(`${group}:${stratum}`) ?? [];
      const size = stratum === "flagged" ? FLAGGED_PER_FAMILY : REST_PER_FAMILY;
      const ordered = [...pool].sort((a, b) => rank(`${a.session}:${a.id}`) - rank(`${b.session}:${b.id}`));
      // GPT commands come from both Codex and Pi; take them evenly so Pi's harness is represented.
      const bySource = [...new Set(ordered.map((call) => call.source))];
      const picked: typeof ordered = [];
      for (let i = 0; picked.length < Math.min(size, ordered.length); i++) {
        for (const source of bySource) {
          const next = ordered.filter((call) => call.source === source)[i];
          if (next && picked.length < size) picked.push(next);
        }
      }
      strata[group][stratum] = { pool: pool.length, sampled: picked.length };
      for (const call of picked) sample.push({ ...call, key: sample.length });
    }
  }
  await mkdir(join(out, "shards"), { recursive: true, mode: 0o700 });
  await mkdir(join(out, "labels"), { recursive: true, mode: 0o700 });
  // Shuffle across families so each labeler sees a mix and cannot key on the model.
  const shuffled = [...sample].sort((a, b) => rank(`shard:${a.key}`) - rank(`shard:${b.key}`));
  for (let i = 0; i * SHARD_SIZE < shuffled.length; i++) {
    const shard = shuffled.slice(i * SHARD_SIZE, (i + 1) * SHARD_SIZE)
      .map(({ key, cwd, root, command }) => ({ key, cwd, root, command }));
    await writeFile(join(out, "shards", `shard-${String(i).padStart(2, "0")}.jsonl`),
      shard.map((item) => JSON.stringify(item)).join("\n") + "\n", { mode: 0o600 });
  }
  await writeFile(join(out, "set.jsonl"), sample.map((item) => JSON.stringify(item)).join("\n") + "\n", { mode: 0o600 });
  await writeFile(join(out, "strata.json"), JSON.stringify(strata, null, 2) + "\n", { mode: 0o600 });
  console.table(Object.fromEntries(Object.entries(strata).map(([group, s]) =>
    [group, { flaggedPool: s.flagged.pool, flagged: s.flagged.sampled, restPool: s.rest.pool, rest: s.rest.sampled }])));
  console.log(`Sampled ${sample.length} calls into ${Math.ceil(sample.length / SHARD_SIZE)} shards under ${out} (private).`);
}

if (process.argv[1]?.endsWith("sample.ts")) await main();
