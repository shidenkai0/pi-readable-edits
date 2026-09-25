import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { scopeRoot } from "../src/targets.js";
import type { Call } from "./corpus.js";

type Label = { index: number; kind: "edit" | "other" | "uncertain" };
const calls = (await readFile(".local/luna-corpus.jsonl", "utf8")).trim().split("\n")
  .map((line) => JSON.parse(line) as Call);
const labels = JSON.parse(await readFile(".local/labeling/all-labels.json", "utf8")) as Label[];
if (labels.length !== calls.length) throw new Error("Incomplete reference labels");
const hint = /(?:^|[\s;&])(sed\s+-i|perl\s+-\S*i|tee\s+|cat\s*>|cp\s+|mv\s+|rm\s+-|printf[^\n]*>|echo[^\n]*>)|\b(?:open|write_text|write_bytes|writeFile(?:Sync)?)\s*\(/i;
const score = (index: number) => createHash("sha256").update(`audit-v1:${index}:${calls[index].id}`).digest("hex");
function pick(kind: Label["kind"], count: number, hinted?: boolean): number[] {
  return labels.filter((label) => label.kind === kind && (hinted === undefined || hint.test(calls[label.index].command) === hinted))
    .map((label) => label.index).sort((a, b) => score(a).localeCompare(score(b))).slice(0, count);
}
const selected = [...new Set([
  ...pick("other", 40, true),
  ...pick("other", 40, false),
  ...pick("edit", 20),
  ...pick("uncertain", 10),
])];
const roots = new Map<string, string>();
const out = ".local/labeling/audit";
await mkdir(out, { recursive: true });
const partitions: number[][] = Array.from({ length: 4 }, () => []);
selected.forEach((index, position) => partitions[position % partitions.length].push(index));
for (const [number, keys] of partitions.entries()) {
  const rows = [];
  for (const index of keys) {
    const call = calls[index];
    if (!roots.has(call.cwd)) roots.set(call.cwd, await scopeRoot(call.cwd));
    rows.push({ index, root: roots.get(call.cwd), cwd: call.cwd, command: call.command });
  }
  await writeFile(join(out, `sample-${number}.jsonl`), rows.map((row) => JSON.stringify(row)).join("\n") + "\n", { mode: 0o600 });
}
console.log(`Wrote ${selected.length} blinded calls to ${out}: 40 hint-other, 40 nonhint-other, 20 edit, 10 uncertain; 4 shards.`);
