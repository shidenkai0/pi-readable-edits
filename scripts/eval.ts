import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { extractTargets, scopeRoot } from "../src/targets.js";
import type { Call } from "./corpus.js";

interface Label {
  id: string;
  session: string;
  /** Hand gold uses cwd-relative paths; full-corpus labels use Git-root-relative paths. */
  paths: string[];
  index?: number;
  kind?: "edit" | "other" | "uncertain";
}

// Used only to queue calls for human labeling; never used to extract targets.
const REVIEW_HINT = /\b(?:sed\s+-i|perl\s+-\S*i|tee\s+|write_text\s*\(|write_bytes\s*\(|writeFile(?:Sync)?\s*\(|open\s*\(|cat\s*(?:>|>>)|printf\b[^\n]*(?:>|>>))|(?:^|[;&\n])[^;\n]{0,90}\s(?:>|>>)\s*[^\s&]/i;

async function main(): Promise<void> {
  const corpusPath = process.argv[2] ?? ".local/corpus.jsonl";
  const goldPath = process.argv[3] ?? ".local/gold.json";
  const content = (await readFile(corpusPath, "utf8")).trim();
  if (!content) {
    console.error("No Bash calls found. Point CORPUS_SESSIONS at sessions with Bash tool calls, then run task eval.");
    process.exitCode = 1;
    return;
  }
  const calls = content.split("\n").map((line) => JSON.parse(line) as Call);
  let gold: Label[] = [];
  try { gold = JSON.parse(await readFile(goldPath, "utf8")) as Label[]; }
  catch { console.log(`No ${goldPath}; reporting corpus coverage without labeled accuracy.`); }
  const full = gold.length > 0 && gold.every((label) => label.index !== undefined && label.kind !== undefined);
  const labels = new Map(gold.map((label) => [`${label.session}:${label.id}`, label]));
  const foundLabels = new Set<string | number>();
  let recognized = 0;
  let suggested = 0;
  let positives = 0;
  let exact = 0;
  let negatives = 0;
  let falsePositives = 0;
  let uncertain = 0;
  let trueTargets = 0;
  let predictedTargets = 0;
  let matchingTargets = 0;
  let missesWithoutCandidates = 0;
  let errors = 0;
  const misses: Array<{ id: string; session: string; want: string[]; got: string[] }> = [];
  const review: Array<{ id: string; session: string; got: string[]; command: string }> = [];
  const start = performance.now();
  for (const [index, call] of calls.entries()) {
    let got: string[] = [];
    try {
      const root = await scopeRoot(call.cwd);
      got = (await extractTargets(call.command, call.cwd, root))
        .map((path) => relative(resolve(full ? root : call.cwd), path).split("\\").join("/")).sort();
    } catch { errors++; }
    if (got.length) recognized++;
    const hinted = REVIEW_HINT.test(call.command);
    if (hinted) suggested++;
    const key = `${call.session}:${call.id}`;
    const label = full ? gold[index] : labels.get(key);
    if (full && (label?.index !== index || label.id !== call.id || label.session !== call.session)) {
      throw new Error(`Misaligned full-corpus label at call ${index}`);
    }
    // Curated hand labels identify a command in a session, not every repetition.
    if (!full && foundLabels.has(key)) continue;
    if (label) {
      foundLabels.add(full ? index : key);
      if (label.kind === "uncertain") {
        uncertain++;
        continue;
      }
      const want = [...label.paths].sort();
      if (full && ((label.kind === "edit") !== !!want.length)) throw new Error(`Invalid kind at ${index}`);
      trueTargets += want.length;
      predictedTargets += got.length;
      matchingTargets += got.filter((path) => want.includes(path)).length;
      if (want.length) {
        positives++;
        if (JSON.stringify(want) === JSON.stringify(got)) exact++;
        else {
          if (!got.length) missesWithoutCandidates++;
          misses.push({ id: call.id, session: call.session, want, got });
        }
      } else {
        negatives++;
        if (got.length) falsePositives++;
      }
    } else if (hinted && review.length < 80) {
      review.push({ id: call.id, session: call.session, got, command: call.command.slice(0, 130).replace(/\n/g, " ↵ ") });
    }
  }
  const seconds = (performance.now() - start) / 1000;
  console.log(`Corpus: ${calls.length} Bash calls; ${recognized} resolved ≥1 project path; ${suggested} review hints; ${errors} errors.`);
  console.log(`Extraction: ${seconds.toFixed(2)}s total, ${(seconds * 1000 / calls.length).toFixed(2)}ms/call average.`);
  console.log(`${full ? "Model reference" : "Gold"}: ${foundLabels.size}/${gold.length} labels present; ${exact}/${positives} positive exact target sets; ${falsePositives}/${negatives} negative false positives.${full ? ` ${uncertain} uncertain excluded.` : ""}`);
  if (full) {
    const pct = (num: number, den: number) => den ? `${(100 * num / den).toFixed(2)}%` : "n/a";
    console.log(`Against model labels (not verified ground truth): ${missesWithoutCandidates}/${positives} edit calls with zero candidates; target precision ${matchingTargets}/${predictedTargets} (${pct(matchingTargets, predictedTargets)}), recall ${matchingTargets}/${trueTargets} (${pct(matchingTargets, trueTargets)}); positive exact ${pct(exact, positives)}.`);
  }
  for (const miss of misses.slice(0, 30)) console.log("MISS", JSON.stringify(miss));
  if (process.argv.includes("--review")) {
    for (const item of review) console.log("REVIEW", JSON.stringify(item));
  }
  if (gold.length && (foundLabels.size !== gold.length || (!full && (misses.length || falsePositives)))) process.exitCode = 1;
}

await main();
