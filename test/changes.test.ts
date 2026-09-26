import assert from "node:assert/strict";
import { test } from "node:test";
import { describeChanges, isSensitive, type RawChange } from "../src/changes.js";

const text = (value: string) => ({ kind: "text" as const, text: value });
const absent = { kind: "absent" as const };
const describe = (raw: RawChange[]) => describeChanges(raw, "/w");

test("text edits carry Pi's display diff and accurate line counts", () => {
  const { files } = describe([{ path: "/w/src/a.ts", before: text("a\nb\nc\n"), after: text("a\nB\nc\nd\n") }]);
  assert.equal(files[0]!.path, "src/a.ts");
  assert.equal(files[0]!.status, "modified");
  assert.deepEqual([files[0]!.added, files[0]!.removed], [2, 1]);
  assert.match(files[0]!.diff!, /^-2 b$/m);
  assert.match(files[0]!.diff!, /^\+2 B$/m);
});

test("creation, deletion and renames are classified", () => {
  const { files } = describe([
    { path: "/w/new.md", before: absent, after: text("hi\n") },
    { path: "/w/old.md", before: text("bye\n"), after: absent },
    { path: "/w/b.md", oldPath: "/w/a.md", before: text("same\n"), after: text("same\n") },
  ]);
  assert.deepEqual(files.map((file) => [file.path, file.status]), [
    ["b.md", "renamed"], ["new.md", "added"], ["old.md", "deleted"],
  ]);
  assert.equal(files[0]!.oldPath, "a.md");
  assert.equal(files[0]!.diff, undefined);
});

test("secret files keep counts but never their contents", () => {
  const { files } = describe([{ path: "/w/.env", before: text("TOKEN=old\n"), after: text("TOKEN=hunter2\n") }]);
  assert.equal(files[0]!.summary, "sensitive");
  assert.deepEqual([files[0]!.added, files[0]!.removed], [1, 1]);
  assert.doesNotMatch(JSON.stringify(files), /hunter2|TOKEN/);
  for (const name of [".env.production", "id_ed25519", "server.pem", "credentials.json", ".npmrc", "prod.tfvars"]) {
    assert.equal(isSensitive(`/w/${name}`), true, name);
  }
  assert.equal(isSensitive("/w/environment.ts"), false);
});

test("unchanged pairs are dropped and mode-only changes are described", () => {
  const same = text("x\n");
  const { files } = describe([
    { path: "/w/same.txt", before: same, after: same },
    { path: "/w/run.sh", before: same, after: same, oldMode: "100644", newMode: "100755" },
  ]);
  assert.deepEqual(files.map((file) => [file.path, file.summary, file.detail]), [["run.sh", "mode", "mode 100644 → 100755"]]);
});

test("binary changes summarize sizes instead of diffing", () => {
  const { files } = describe([{ path: "/w/logo.png", before: { kind: "binary", size: 2048 }, after: { kind: "binary", size: 4096 } }]);
  assert.equal(files[0]!.summary, "binary");
  assert.equal(files[0]!.detail, "binary · 2.0 KB → 4.0 KB");
});

test("stored diffs are capped per file and per card, with the remainder counted", () => {
  const many = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join("\n") + "\n";
  const { files } = describe([
    { path: "/w/a.txt", before: absent, after: text(many) },
    { path: "/w/b.txt", before: absent, after: text(many) },
    { path: "/w/c.txt", before: absent, after: text(many) },
    { path: "/w/d.txt", before: absent, after: text(many) },
    { path: "/w/e.txt", before: absent, after: text(many) },
  ]);
  const stored = files.reduce((sum, file) => sum + (file.diff?.split("\n").length ?? 0), 0);
  assert.equal(stored, 2400);
  assert.equal(files[0]!.omittedLines, 1400);
  assert.equal(files[4]!.diff, undefined);
  assert.equal(files[4]!.added, 2000, "counts stay accurate even when the diff is not stored");
});
