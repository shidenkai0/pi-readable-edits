import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { capture, compare } from "../src/diffs.js";

let root: string;
before(async () => { root = await mkdtemp(join(tmpdir(), "readable-diffs-")); });
after(async () => { await rm(root, { recursive: true, force: true }); });

test("modification shows only the command delta, even if file was already dirty", async () => {
  const path = join(root, "dirty.ts");
  await writeFile(path, "before\n");
  const old = await capture([path], root);
  await writeFile(path, "after\n");
  const edits = await compare(old, root);
  assert.equal(edits.length, 1);
  assert.match(edits[0].patch, /-before/);
  assert.match(edits[0].patch, /\+after/);
});

test("created, deleted, unchanged and binary files", async () => {
  const added = join(root, "added.md");
  const removed = join(root, "removed.md");
  const binary = join(root, "binary.dat");
  await writeFile(removed, "gone\n");
  await writeFile(binary, Buffer.from([0, 2, 3]));
  const old = await capture([added, removed, binary], root);
  await writeFile(added, "hello\n");
  await rm(removed);
  assert.deepEqual((await compare(old, root)).map((entry) => entry.path), ["added.md", "removed.md"]);
  assert.deepEqual(await compare(await capture([added], root), root), []);
});
