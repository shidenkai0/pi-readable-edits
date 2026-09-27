import { statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { extractTargets, isIgnored } from "../src/targets.js";
import type { Sampled, Strata } from "./sample.js";

/**
 * Scores the parser against the private labeled sample drawn by sample.ts.
 *
 * usage: tsx scripts/eval.ts [dir=.local/eval] [--split dev|holdout] [--misses] [--false-cards]
 *
 * Each labeled call is weighted by its stratum (pool size / sampled), so
 * per-family numbers estimate that family's real non-read-only commands.
 * The headline is the macro average: every model family counts equally.
 */

interface Label {
  key: number;
  kind: "edit" | "other" | "uncertain";
  paths: string[];
  dynamic?: boolean;
  note?: string;
}

interface Tally {
  edits: number; covered: number; exact: number; dynamic: number;
  cards: number; cleanCards: number; falseCards: number; others: number;
  n: number; nEdits: number; nCovered: number;
}

const empty = (): Tally => ({
  edits: 0, covered: 0, exact: 0, dynamic: 0, cards: 0, cleanCards: 0, falseCards: 0, others: 0, n: 0, nEdits: 0, nCovered: 0,
});
/** Below this many labeled edit commands, a family's rates are noise; it's shown but not averaged. */
const MIN_EDITS = 20;
const isDirectory = (path: string) => { try { return statSync(path).isDirectory(); } catch { return false; } };
const pct = (num: number, den: number) => (den ? `${(100 * num / den).toFixed(1)}%` : "n/a");

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dir = args.find((arg) => !arg.startsWith("--") && args[args.indexOf(arg) - 1] !== "--split") ?? ".local/eval";
  const split = args.includes("--split") ? args[args.indexOf("--split") + 1] : undefined;
  const set = (await readFile(join(dir, "set.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Sampled);
  const strata = JSON.parse(await readFile(join(dir, "strata.json"), "utf8")) as Strata;
  const labels = new Map<number, Label>();
  for (const file of (await readdir(join(dir, "labels"))).filter((name) => name.endsWith(".json")).sort()) {
    for (const label of JSON.parse(await readFile(join(dir, "labels", file), "utf8")) as Label[]) labels.set(label.key, label);
  }
  // A second, blind pass over every call where the parser and first labels disagreed, and
  // every call whose label depended on the old in-project scope, replaces the first label.
  const adjudicated = await readdir(join(dir, "adjudicate")).catch(() => [] as string[]);
  for (const file of adjudicated.filter((name) => /^labels-.*\.json$/.test(name)).sort()) {
    for (const label of JSON.parse(await readFile(join(dir, "adjudicate", file), "utf8")) as Label[]) labels.set(label.key, label);
  }
  // Reviewed fixes to model labels, keyed by call: { "123": { kind, paths, why } }.
  const corrections = await readFile(join(dir, "corrections.json"), "utf8")
    .then((text) => JSON.parse(text) as Record<string, Label & { why: string }>).catch(() => ({}));
  for (const [key, fix] of Object.entries(corrections)) labels.set(Number(key), { ...fix, key: Number(key) });

  const tallies = new Map<string, Tally>();
  const misses: string[] = [];
  const falseCards: string[] = [];
  let unlabeled = 0, uncertain = 0, parsed = 0, elapsed = 0;
  for (const call of set) {
    if (split && call.split !== split) continue;
    const label = labels.get(call.key);
    if (!label) { unlabeled++; continue; }
    if (label.kind === "uncertain") { uncertain++; continue; }
    const started = performance.now();
    // Directories a command cd'd into may be gone now; they existed when it ran.
    const targets = await extractTargets(call.command, call.cwd, { directoryExists: () => true }).catch(() => []);
    // At runtime, targets that aren't files (a mkdir'd or moved directory) are skipped.
    const got = new Set(targets.filter((path) => !isDirectory(path)));
    elapsed += performance.now() - started;
    parsed++;
    const stratum = strata[call.family]![call.stratum];
    const weight = stratum.pool / stratum.sampled;
    const tally = tallies.get(call.family) ?? empty();
    tallies.set(call.family, tally);
    tally.n++;
    // The product ignores scratch files and logs by design; labels are judged the same way.
    const want = new Set(label.paths.map((path) => resolve(path)).filter((path) => !isIgnored(path)));
    const show = (paths: Set<string>) => [...paths].map((path) => relative(call.root, path)).sort().join(", ") || "∅";
    const snippet = call.command.slice(0, 160).replace(/\n/g, " ↵ ");
    const isEdit = label.kind === "edit" && (want.size > 0 || label.dynamic);
    if (isEdit) {
      tally.edits += weight;
      tally.nEdits++;
      if (label.dynamic) tally.dynamic += weight;
      const covered = want.size > 0 && [...want].every((path) => got.has(path));
      if (covered) { tally.covered += weight; tally.nCovered++; }
      if (covered && got.size === want.size) tally.exact += weight;
      if (!covered) {
        misses.push(`MISS ${call.key} [${call.family}${label.dynamic ? ", dynamic" : ""}] want: ${show(want)} | got: ${show(got)}\n     ${snippet}`);
      }
    } else {
      tally.others += weight;
    }
    if (got.size) {
      tally.cards += weight;
      const clean = isEdit && [...got].every((path) => want.has(path));
      if (clean) tally.cleanCards += weight;
      else {
        if (!isEdit) tally.falseCards += weight;
        falseCards.push(`WRONG ${call.key} [${call.family}] want: ${show(want)} | got: ${show(got)}\n     ${snippet}`);
      }
    }
  }

  const rows: Record<string, Record<string, string | number>> = {};
  const row = (tally: Tally) => ({
    "edit calls (n)": tally.nEdits,
    "card complete": pct(tally.covered, tally.edits),
    "exact files": pct(tally.exact, tally.edits),
    "dynamic edits": pct(tally.dynamic, tally.edits),
    "cards clean": pct(tally.cleanCards, tally.cards),
    "false cards / 100 writing calls": (100 * tally.falseCards / Math.max(1, tally.others)).toFixed(2),
  });
  const families = [...tallies.keys()].sort((a, b) => tallies.get(b)!.nEdits - tallies.get(a)!.nEdits);
  for (const family of families) {
    rows[tallies.get(family)!.nEdits < MIN_EDITS ? `${family} (too few)` : family] = row(tallies.get(family)!);
  }
  // Micro: pooled over real command volume. Macro: each family weighted equally.
  const micro = families.reduce((sum, family) => {
    const tally = tallies.get(family)!;
    for (const key of Object.keys(sum) as Array<keyof Tally>) sum[key] += tally[key];
    return sum;
  }, empty());
  rows["all (micro)"] = row(micro);
  const mean = (score: (tally: Tally) => number, applies: (tally: Tally) => boolean = () => true) => {
    const scored = families.map((family) => tallies.get(family)!).filter((tally) => tally.nEdits >= MIN_EDITS && applies(tally));
    return `${(100 * scored.reduce((sum, tally) => sum + score(tally), 0) / scored.length).toFixed(1)}%`;
  };
  rows["all (macro)"] = {
    "edit calls (n)": families.reduce((sum, family) =>
      sum + (tallies.get(family)!.nEdits >= MIN_EDITS ? tallies.get(family)!.nEdits : 0), 0),
    "card complete": mean((tally) => tally.covered / tally.edits),
    "exact files": mean((tally) => tally.exact / tally.edits),
    "dynamic edits": mean((tally) => tally.dynamic / tally.edits),
    "cards clean": mean((tally) => tally.cleanCards / tally.cards, (tally) => tally.cards > 0),
    "false cards / 100 writing calls": mean((tally) => tally.falseCards / Math.max(1, tally.others)).replace("%", ""),
  };
  console.log(`Parser vs model labels (a reference, not verified ground truth)${split ? `, ${split} split` : ""}:`);
  console.table(rows);
  console.log(`${parsed} labeled calls scored (${unlabeled} unlabeled, ${uncertain} uncertain skipped), ` +
    `${(elapsed / Math.max(1, parsed)).toFixed(2)}ms per call. Read-only commands are excluded from every rate.`);
  if (args.includes("--misses")) for (const line of misses) console.log(line);
  if (args.includes("--false-cards")) for (const line of falseCards) console.log(line);
}

await main();
