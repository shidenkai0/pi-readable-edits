import { readFile } from "node:fs/promises";

type Label = { index: number; kind: "edit" | "other" | "uncertain"; paths: string[] };
const model = JSON.parse(await readFile(".local/labeling/all-labels.json", "utf8")) as Label[];
let agreements = 0;
let checked = 0;
const classes = new Map<string, { agree: number; total: number }>();
for (let shard = 0; shard < 4; shard++) {
  const input = (await readFile(`.local/labeling/audit/sample-${shard}.jsonl`, "utf8")).trim()
    .split("\n").map((line) => JSON.parse(line) as { index: number });
  const review = JSON.parse(await readFile(`.local/labeling/audit/review-${shard}.json`, "utf8")) as Label[];
  if (review.length !== input.length || review.some((row, i) => row.index !== input[i].index)) {
    throw new Error(`Incomplete or misaligned blind review ${shard}`);
  }
  for (const row of review) {
    checked++;
    const reference = model[row.index];
    const stratum = reference.kind;
    const bucket = classes.get(stratum) ?? { agree: 0, total: 0 };
    bucket.total++;
    const match = row.kind === reference.kind &&
      JSON.stringify([...row.paths].sort()) === JSON.stringify([...reference.paths].sort());
    if (match) { agreements++; bucket.agree++; }
    else console.log("REVIEW", JSON.stringify({
      index: row.index, model: { kind: reference.kind, paths: reference.paths }, blind: { kind: row.kind, paths: row.paths },
    }));
    classes.set(stratum, bucket);
  }
}
console.log(`Blind repeatability (same model, not independent ground truth): ${agreements}/${checked} full-label agreements; by model kind: ${JSON.stringify(Object.fromEntries(classes))}.`);
