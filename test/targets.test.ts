import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { extractTargets } from "../src/targets.js";

let root: string;
before(async () => {
  root = await mkdtemp(join(tmpdir(), "readable-targets-"));
  await mkdir(join(root, "course", "lessons"), { recursive: true });
  await writeFile(join(root, "course", "lessons", "01.html"), "old");
  await writeFile(join(root, "course", "lessons", "02.html"), "old");
});
after(async () => { await rm(root, { recursive: true, force: true }); });

async function targets(command: string): Promise<string[]> {
  return (await extractTargets(command, root)).map((path) => path.slice(root.length + 1));
}

test("Bash redirects, heredocs and tee resolve named destinations", async () => {
  assert.deepEqual(await targets("cat > new.ts <<'EOF'\nhello\nEOF"), ["new.ts"]);
  assert.deepEqual(await targets("printf hello | tee first.ts second.ts"), ["first.ts", "second.ts"]);
  assert.deepEqual(await targets("echo hello >> notes.md"), ["notes.md"]);
  assert.deepEqual(await targets("cd course && cat > new.ts <<'EOF'\nhello\nEOF"), ["course/new.ts"]);
});

test("subshell cd does not change the following command's working directory", async () => {
  assert.deepEqual(await targets("(cd course; printf inner > inside.ts); printf outer > outside.ts"), [
    "course/inside.ts", "outside.ts",
  ]);
  assert.deepEqual(await targets("(cd course); printf text > result.txt"), ["result.txt"]);
  assert.deepEqual(await targets("cd course | cat; printf text > root.ts"), ["root.ts"]);
  assert.deepEqual(await targets("cd course && printf alpha | tee out.ts; printf beta > tail.ts"), [
    "course/out.ts", "course/tail.ts",
  ]);
  assert.deepEqual(await targets("cd course && printf alpha 2>&1 | cat; printf beta > tail.ts"), [
    "course/tail.ts",
  ]);
});

test("redirects on cd use the old directory before cd takes effect", async () => {
  assert.deepEqual(await targets("cd course > log.txt && printf data > afterward.ts"), [
    "course/afterward.ts", "log.txt",
  ]);
});

test("BSD sed -i and globbed files resolve without interpreting the edit program", async () => {
  assert.deepEqual(await targets("cd course && sed -i '' 's/old/new/' lessons/*.html"), [
    "course/lessons/01.html", "course/lessons/02.html",
  ]);
  assert.deepEqual(await targets("sed -i -e 's/old/new/' -e 's/a/b/' course/lessons/01.html"), [
    "course/lessons/01.html",
  ]);
  assert.deepEqual(await targets(`sed -i '' "s/\\[old\\]/[new]/" course/lessons/01.html`), [
    "course/lessons/01.html",
  ]);
});

test("nested Python heredoc resolves assigned variables and multiple targets", async () => {
  const command = `cd course && python3 - <<'PY'
from pathlib import Path
p = Path('new.ts')
p.write_text('hello')
for f in ['a.md', 'b.md']:
    open(f, 'w').write('text')
PY`;
  assert.deepEqual(await targets(command), ["course/a.md", "course/b.md", "course/new.ts"]);
});

test("Python -c resolves pathlib joins and literal glob loops", async () => {
  const command = "python3 -c 'from pathlib import Path; p=Path(\"course\") / \"new.py\"; p.write_text(\"hi\")'";
  assert.deepEqual(await targets(command), ["course/new.py"]);
  const glob = `python3 - <<'PY'
import glob
for p in glob.glob('course/lessons/*.html'):
    open(p, 'w').write('changed')
PY`;
  assert.deepEqual(await targets(glob), ["course/lessons/01.html", "course/lessons/02.html"]);
});

test("string.replace content is not mistaken for a file rename", async () => {
  const command = `python3 - <<'PY'
p='src/core/app.js'
s=open(p).read().replace('old text', 'new text')
open(p,'w').write(s)
PY`;
  assert.deepEqual(await targets(command), ["src/core/app.js"]);
});

test("simple helper calls and combined glob lists resolve project files", async () => {
  const command = `cd course && python3 - <<'PY'
import glob
def edit(path):
    s=open(path).read()
    open(path,'w').write(s)
edit('lessons/01.html')
for p in glob.glob('lessons/01*.html') + glob.glob('lessons/02*.html'):
    edit(p)
PY`;
  assert.deepEqual(await targets(command), ["course/lessons/01.html", "course/lessons/02.html"]);
});

test("inline Node writeFileSync resolves literals and assigned paths", async () => {
  assert.deepEqual(await targets(`node <<'JS'
const fs=require('node:fs');
const file='package-lock.json';
fs.writeFileSync(file,'new');
JS`), ["package-lock.json"]);
  assert.deepEqual(await targets(`node -e 'const {writeFileSync}=require("fs");writeFileSync("out.js","new")'`), ["out.js"]);
});

test("tuple loops and f-strings yield finite Python write targets", async () => {
  const command = `python3 - <<'PY'
for tid,name in [('1','first'),('2','second')]:
    open(f'course/{name}.md','w').write(tid)
PY`;
  assert.deepEqual(await targets(command), ["course/first.md", "course/second.md"]);
});

test("unknown targets, builds and out-of-project paths keep ordinary shell display", async () => {
  assert.deepEqual(await targets("python3 build.py"), []);
  assert.deepEqual(await targets("python3 -c 'import os; open(os.environ[\"DEST\"], \"w\").write(\"x\")'"), []);
  assert.deepEqual(await targets("cat > ../outside.txt <<'EOF'\nx\nEOF"), []);
  assert.deepEqual(await targets("cat > /tmp/outside.txt <<'EOF'\nx\nEOF"), []);
  assert.deepEqual(await targets("cd /tmp && cat > outside.txt <<'EOF'\nx\nEOF"), []);
});
