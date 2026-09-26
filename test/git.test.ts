import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { GitCapture } from "../src/capture.js";
import { describeChanges, type RawChange } from "../src/changes.js";
import { findRepository, GitSnapshots, parseRawDiff } from "../src/git.js";
import { cleanup, repository, sh, writeFiles } from "./helpers.js";

const roots: string[] = [];
after(() => cleanup(...roots));

/** Snapshots, runs `command`, and returns what changed, relative to the repository root. */
async function observe(root: string, command: string): Promise<RawChange[]> {
  const repo = (await findRepository(root))!;
  const snapshots = await GitSnapshots.open(repo);
  try {
    const take = () => snapshots.snapshot({ timeoutMs: 10_000 });
    const capture = new GitCapture(snapshots, await take(), take);
    sh(command, root);
    return (await capture.finish()).map((change) => ({
      ...change,
      path: change.path.slice(repo.root.length + 1),
      ...(change.oldPath ? { oldPath: change.oldPath.slice(repo.root.length + 1) } : {}),
    }));
  } finally {
    await snapshots.dispose();
  }
}

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await repository(files);
  roots.push(root);
  return root;
}

async function fingerprint(root: string): Promise<string> {
  const hash = createHash("sha1");
  hash.update(await readFile(join(root, ".git/index")));
  const objects = await readdir(join(root, ".git/objects"), { recursive: true });
  hash.update(objects.sort().join("\n"));
  return hash.digest("hex");
}

test("captures modifications, creations, deletions and renames across the worktree", async () => {
  const root = await fixture({ "a.txt": "one\ntwo\n", "gone.txt": "bye\n", "old.txt": "moved content\n".repeat(5) });
  const changes = await observe(root, "printf 'one\\nTWO\\n' > a.txt; echo new > new.txt; rm gone.txt; mv old.txt renamed.txt");
  const byPath = new Map(changes.map((change) => [change.path, change]));
  assert.deepEqual([...byPath.keys()].sort(), ["a.txt", "gone.txt", "new.txt", "renamed.txt"]);
  assert.deepEqual(byPath.get("a.txt")!.after, { kind: "text", text: "one\nTWO\n" });
  assert.deepEqual(byPath.get("new.txt")!.before, { kind: "absent" });
  assert.deepEqual(byPath.get("gone.txt")!.after, { kind: "absent" });
  assert.equal(byPath.get("renamed.txt")!.oldPath, "old.txt");
});

test("only the command's own changes appear when the worktree was already dirty", async () => {
  const root = await fixture({ "a.txt": "base\n", "b.txt": "base\n" });
  await writeFiles(root, { "a.txt": "edited by the user earlier\n", "scratch.txt": "untracked before\n" });
  const changes = await observe(root, "echo more >> a.txt");
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0]!.before, { kind: "text", text: "edited by the user earlier\n" });
  assert.deepEqual(changes[0]!.after, { kind: "text", text: "edited by the user earlier\nmore\n" });
});

test("ignored files, unchanged files and no-op commands produce nothing", async () => {
  const root = await fixture({ ".gitignore": "dist/\n*.log\n", "a.txt": "a\n" });
  assert.deepEqual(await observe(root, "mkdir -p dist && echo built > dist/app.js && echo x > debug.log && touch a.txt"), []);
  assert.deepEqual(await observe(root, "true"), []);
});

test("the user's index and object store are never written", async () => {
  const root = await fixture({ "a.txt": "a\n" });
  await writeFiles(root, { "untracked.txt": "u\n" });
  const before = await fingerprint(root);
  await observe(root, "echo b > a.txt && echo c > another.txt");
  assert.equal(await fingerprint(root), before);
  assert.equal(sh("git status --porcelain", root), " M a.txt\n?? another.txt\n?? untracked.txt\n");
});

test("binary and oversized files are summarized, symlinks report their targets", async () => {
  const root = await fixture({ "image.bin": "\0\x01\x02", "link-target.txt": "t\n" });
  const changes = await observe(root,
    "printf '\\0\\3\\4\\5' > image.bin && head -c 1100000 /dev/zero | tr '\\0' 'a' > big.txt && ln -s link-target.txt link");
  const byPath = new Map(changes.map((change) => [change.path, change]));
  assert.equal(byPath.get("image.bin")!.after.kind, "binary");
  assert.equal(byPath.get("big.txt")!.after.kind, "large");
  assert.deepEqual(byPath.get("link")!.after, { kind: "link", target: "link-target.txt" });
});

test("a failing required clean filter (like an absent Git LFS) does not break snapshots", async () => {
  const root = await fixture({ ".gitattributes": "*.dat filter=broken\n", "data.dat": "v1\n" });
  sh("git config filter.broken.clean false && git config filter.broken.required true", root);
  const changes = await observe(root, "echo v2 > data.dat");
  assert.deepEqual(changes.map((change) => change.path), ["data.dat"]);
  assert.deepEqual(changes[0]!.after, { kind: "text", text: "v2\n" });
});

test("CRLF-only changes are described as line-ending changes", async () => {
  const root = await fixture({ "a.txt": "one\ntwo\n" });
  sh("git config core.autocrlf false", root);
  const { files } = describeChanges(
    (await observe(root, "printf 'one\\r\\ntwo\\r\\n' > a.txt")).map((change) => ({ ...change, path: join(root, change.path) })),
    root);
  assert.equal(files[0]!.summary, "eol");
});

test("generated attributes and lockfile names mark files as generated", async () => {
  const root = await fixture({ ".gitattributes": "gen/** linguist-generated\n", "gen/api.ts": "a\n", "pnpm-lock.yaml": "a\n" });
  const changes = await observe(root, "echo b > gen/api.ts && echo b > pnpm-lock.yaml");
  assert.equal(changes.find((change) => change.path === "gen/api.ts")!.generated, true);
  const { files } = describeChanges(changes.map((change) => ({ ...change, path: join(root, change.path) })), root);
  assert.deepEqual(files.map((file) => file.generated), [true, true]);
});

test("subdirectories resolve to the enclosing worktree; plain directories are not repositories", async () => {
  const root = await fixture({ "pkg/a.txt": "a\n" });
  assert.equal((await findRepository(join(root, "pkg")))?.root, sh("git rev-parse --show-toplevel", root).trim());
  assert.equal(await findRepository("/"), undefined);
});

test("raw diff parsing handles renames, copies and NUL-separated paths with spaces", () => {
  const z = "0".repeat(40), a = "a".repeat(40), b = "b".repeat(40);
  const out = Buffer.from([
    `:100644 100644 ${a} ${b} M`, "dir with space/file.ts",
    `:100644 100644 ${a} ${a} R100`, "old name.ts", "new name.ts",
    `:000000 100644 ${z} ${b} A`, "added.ts",
    `:100644 100644 ${a} ${b} C075`, "source.ts", "copy.ts",
    "",
  ].join("\0"));
  assert.deepEqual(parseRawDiff(out).map((entry) => [entry.status, entry.oldPath ?? "", entry.path]), [
    ["M", "", "dir with space/file.ts"],
    ["R", "old name.ts", "new name.ts"],
    ["A", "", "added.ts"],
    ["A", "", "copy.ts"],
  ]);
});

test("edits made by a program the command writes and runs elsewhere are still captured", async () => {
  const root = await fixture({ "config.json": '{"debug": false}\n', "run.sh": "echo hi\n" });
  const script = join(root, "..", `${root.split("/").pop()}-fix.py`);
  roots.push(script);
  const changes = await observe(root,
    `printf 'import json\\np = "config.json"\\nd = json.load(open(p))\\nd["debug"] = True\\njson.dump(d, open(p, "w"))\\n' > ${script} && python3 ${script} && chmod +x run.sh`);
  const byPath = new Map(changes.map((change) => [change.path, change]));
  assert.deepEqual(byPath.get("config.json")!.after, { kind: "text", text: '{"debug": true}' });
  assert.deepEqual([byPath.get("run.sh")!.oldMode, byPath.get("run.sh")!.newMode], ["100644", "100755"]);
});
