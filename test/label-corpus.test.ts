import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("labels cover every occurrence, reject omissions, and exclude outside-root paths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "readable-labels-"));
  try {
    const corpus = join(dir, "corpus.jsonl");
    const output = join(dir, "labels");
    const calls = [
      { id: "one", session: "s1", source: "codex", cwd: dir, command: "printf x > one.ts" },
      { id: "one", session: "s2", source: "codex", cwd: dir, command: "printf x > one.ts" },
      { id: "two", session: "s2", source: "claude", cwd: dir, command: "echo x > /tmp/external" },
    ];
    await writeFile(corpus, calls.map((call) => JSON.stringify(call)).join("\n") + "\n");
    const run = (mode: string) => spawnSync(process.execPath,
      ["--import", "tsx", "scripts/label-corpus.ts", mode, corpus, output],
      { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(run("prepare").status, 0);
    const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8"));
    assert.equal(manifest.occurrences, 3);
    assert.equal(manifest.unique, 2);
    assert.notEqual(run("assemble").status, 0);
    const shard = manifest.shards[0].file.replace(".jsonl", ".json");
    await writeFile(join(output, "labels", shard), JSON.stringify([
      { key: 0, kind: "edit", paths: ["one.ts"] },
      { key: 2, kind: "edit", paths: ["/tmp/external"] },
    ]));
    assert.notEqual(run("assemble").status, 0);
    assert.equal(run("normalize").status, 0);
    assert.equal(run("assemble").status, 0);
    const labeled = JSON.parse(await readFile(join(output, "all-labels.json"), "utf8"));
    assert.equal(labeled.length, 3);
    assert.deepEqual(labeled.map((item: { paths: string[] }) => item.paths), [["one.ts"], ["one.ts"], []]);
    assert.deepEqual(labeled.map((item: { kind: string }) => item.kind), ["edit", "edit", "other"]);
    assert.equal(run("prepare").status, 0);
    await writeFile(corpus, JSON.stringify({ ...calls[0], command: "printf y > changed.ts" }) + "\n");
    assert.notEqual(run("prepare").status, 0);
    const hand = join(dir, "hand.json");
    await writeFile(corpus, [calls[0], calls[0]].map((call) => JSON.stringify(call)).join("\n") + "\n");
    await writeFile(hand, JSON.stringify([{ id: "one", session: "s1", paths: ["one.ts"] }]));
    const evaluated = spawnSync(process.execPath,
      ["--import", "tsx", "scripts/eval.ts", corpus, hand],
      { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(evaluated.status, 0);
    assert.match(evaluated.stdout, /1\/1 positive exact target sets/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
