import assert from "node:assert/strict";
import { after, test } from "node:test";
import { Engine } from "../src/engine.js";
import { cleanup, repository, sh } from "./helpers.js";

const roots: string[] = [];
after(() => cleanup(...roots));

test("repositories whose snapshots are consistently slow fall back to command parsing, once, with a notice", async () => {
  const root = await repository({ "a.txt": "a\n" });
  roots.push(root);
  const notices: string[] = [];
  const engine = new Engine((message) => notices.push(message), { slowSnapshotMs: 0 });
  try {
    const first = await engine.start("echo b > a.txt", root);
    assert.equal(first.mode, "git");
    sh("echo b > a.txt", root);
    assert.equal((await first.finish()).length, 1, "the capture in flight still completes");
    const next = await engine.start("echo c > a.txt", root);
    assert.equal(next.mode, "targeted");
    sh("echo c > a.txt", root);
    assert.equal((await next.finish()).length, 1);
    await engine.start("true", root);
    assert.equal(notices.length, 1);
    assert.match(notices[0]!, /Git snapshots average \d+ms here; showing diffs only for files commands name directly/);
    assert.equal(engine.status()[0]!.mode, "targeted");
  } finally {
    await engine.dispose();
  }
});

test("a snapshot that times out lets the command run and switches modes", async () => {
  const root = await repository({ "a.txt": "a\n" });
  roots.push(root);
  const notices: string[] = [];
  const engine = new Engine((message) => notices.push(message), { snapshotTimeoutMs: 1 });
  try {
    const capture = await engine.start("echo b > a.txt", root);
    assert.equal(capture.mode, "targeted");
    assert.match(notices[0]!, /took over/);
  } finally {
    await engine.dispose();
  }
});
