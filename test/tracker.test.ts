import assert from "node:assert/strict";
import { test } from "node:test";
import type { Capture } from "../src/capture.js";
import type { RawChange } from "../src/changes.js";
import type { EditCardData } from "../src/render.js";
import { EditTracker, summarizeCommand } from "../src/tracker.js";

/** A fake capture source: each capture reports whatever the test queued while it was open. */
function harness() {
  const cards: EditCardData[] = [];
  const log: string[] = [];
  let changes: RawChange[] = [];
  const source = {
    async start(command: string): Promise<Capture> {
      log.push(`start ${command}`);
      return {
        mode: "git" as const,
        async include(joined: string) { log.push(`include ${joined}`); },
        async finish() { log.push("finish"); const result = changes; changes = []; return result; },
      };
    },
  };
  const tracker = new EditTracker(source, (card) => cards.push(card));
  const edit = (path: string): void => {
    changes.push({ path: `/w/${path}`, before: { kind: "text", text: "a\n" }, after: { kind: "text", text: "b\n" } });
  };
  return { tracker, cards, log, edit };
}

test("sequential commands each get their own card", async () => {
  const { tracker, cards, edit } = harness();
  await tracker.shellStarting("1", "sed -i s/a/b/ one.txt", "/w");
  edit("one.txt");
  await tracker.toolEnded("1", false);
  await tracker.shellStarting("2", "echo b > two.txt", "/w");
  edit("two.txt");
  await tracker.toolEnded("2", false);
  assert.deepEqual(cards.map((card) => [card.commands, card.files.map((file) => file.path)]), [
    [["sed -i s/a/b/ one.txt"], ["one.txt"]],
    [["echo b > two.txt"], ["two.txt"]],
  ]);
});

test("overlapping commands share one capture and one card", async () => {
  const { tracker, cards, log, edit } = harness();
  await tracker.shellStarting("1", "first", "/w");
  await tracker.shellStarting("2", "second", "/w");
  edit("a.txt");
  await tracker.toolEnded("1", false);
  assert.equal(cards.length, 0, "the capture stays open until every member finishes");
  edit("b.txt");
  await tracker.toolEnded("2", true);
  assert.deepEqual(log, ["start first", "include second", "finish"]);
  assert.deepEqual(cards[0]!.commands, ["first", "second"]);
  assert.deepEqual(cards[0]!.files.map((file) => file.path), ["a.txt", "b.txt"]);
  assert.equal(cards[0]!.failed, true);
});

test("files edited concurrently by Pi's edit and write tools are left to their own diffs", async () => {
  const { tracker, cards, edit } = harness();
  tracker.toolStarted("e1", "edit", { path: "README.md" }, "/w");
  await tracker.shellStarting("1", "sed -i s/a/b/ a.txt", "/w");
  tracker.toolStarted("w1", "write", { path: "new.md" }, "/w");
  edit("README.md");
  edit("new.md");
  edit("a.txt");
  await tracker.toolEnded("e1", false);
  await tracker.toolEnded("w1", false);
  await tracker.toolEnded("1", false);
  assert.deepEqual(cards[0]!.files.map((file) => file.path), ["a.txt"]);
  assert.deepEqual(cards[0]!.shownElsewhere, ["README.md", "new.md"]);
});

test("commands that change nothing produce no card; unknown tool ends are ignored", async () => {
  const { tracker, cards } = harness();
  await tracker.toolEnded("never-started", false);
  await tracker.shellStarting("1", "ls", "/w");
  await tracker.toolEnded("1", false);
  assert.equal(cards.length, 0);
});

test("flush closes a capture whose end event never arrived", async () => {
  const { tracker, cards, edit } = harness();
  await tracker.shellStarting("1", "long-running", "/w");
  edit("a.txt");
  await tracker.flush();
  assert.equal(cards.length, 1);
});

test("a capture that fails to start never blocks the command", async () => {
  const cards: EditCardData[] = [];
  const errors: unknown[] = [];
  const tracker = new EditTracker({ start: async () => { throw new Error("boom"); } }, (card) => cards.push(card),
    (error) => errors.push(error));
  await tracker.shellStarting("1", "echo", "/w");
  await tracker.toolEnded("1", false);
  assert.equal(cards.length, 0);
  assert.equal(errors.length, 1);
});

test("stored commands keep only the first line", () => {
  assert.equal(summarizeCommand("python3 - <<'PY'\nprint(1)\nPY"), "python3 - <<'PY' …");
  assert.equal(summarizeCommand("x".repeat(500)).length, 240);
});
