import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { scopeRoot } from "../src/targets.js";
import type { Call } from "./corpus.js";

interface HandLabel { id: string; session: string; paths: string[] }
interface ModelLabel { index: number; id: string; session: string; kind: string; paths: string[] }

const corpus = (await readFile(".local/luna-corpus.jsonl", "utf8")).trim().split("\n")
  .map((line) => JSON.parse(line) as Call);
const model = JSON.parse(await readFile(".local/labeling/all-labels.json", "utf8")) as ModelLabel[];
const hand = JSON.parse(await readFile(".local/gold.json", "utf8")) as HandLabel[];
if (model.length !== corpus.length) throw new Error("Model labels do not cover corpus");

const occurrences = new Map<string, number[]>();
corpus.forEach((call, index) => {
  const key = `${call.session}:${call.id}`;
  occurrences.set(key, [...(occurrences.get(key) ?? []), index]);
});
let matched = 0;
let agreements = 0;
let unresolved = 0;
for (const label of hand) {
  const indices = occurrences.get(`${label.session}:${label.id}`) ?? [];
  if (!indices.length) continue;
  matched++;
  const index = indices[0];
  const call = corpus[index];
  const root = await scopeRoot(call.cwd);
  const expected = label.paths.map((path) => relative(root, resolve(call.cwd, path)).split("\\").join("/")).sort();
  const observed = [...model[index].paths].sort();
  if (model[index].kind === "uncertain") unresolved++;
  if (JSON.stringify(expected) === JSON.stringify(observed) && model[index].kind !== "uncertain") {
    agreements++;
  } else {
    console.log("DISAGREE", JSON.stringify({ index, id: call.id, hand: expected, model: observed, kind: model[index].kind }));
  }
}
console.log(`Curated independent audit: ${agreements}/${matched} full-path agreements; ${unresolved} uncertain; ${hand.length - matched} hand labels absent from frozen corpus.`);
