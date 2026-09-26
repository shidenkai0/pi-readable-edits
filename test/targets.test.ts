import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { extractTargets, isReadOnly } from "../src/targets.js";

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

test("Python dictionaries preserve keys through .items(), .keys() and direct iteration", async () => {
  const command = `python3 - <<'PY'
from pathlib import Path
fixes = {'course/lessons/01.html': [('old', 'new')], 'course/lessons/02.html': []}
for path, replacements in fixes.items():
    Path(path).write_text('new')
for path in fixes.keys():
    open(path, 'w').write('new')
for path in fixes:
    open(path, 'a').write('more')
PY`;
  assert.deepEqual(await targets(command), ["course/lessons/01.html", "course/lessons/02.html"]);
});

test("Python list variables preserve tuple pairing in loops", async () => {
  assert.deepEqual(await targets(`python3 - <<'PY'
pairs = [('one', 'a.md'), ('two', 'b.md')]
for name, path in pairs:
    open('course/' + path, 'w').write(name)
PY`), ["course/a.md", "course/b.md"]);
});

test("absolute right-hand Path operand replaces the base directory", async () => {
  assert.deepEqual(await targets(`python3 -c 'from pathlib import Path; (Path("course") / "/tmp/not-project.txt").write_text("x")'`), []);
});

test("nested Python tuple patterns keep dictionary keys attached to their values", async () => {
  assert.deepEqual(await targets(`python3 - <<'PY'
base='course/lessons/'
spec={'01.html': (['a'], None), '02.html': (['b'], {'open': 'x'})}
for name,(parts,optional) in spec.items():
    open(base+name,'w').write('new')
PY`), ["course/lessons/01.html", "course/lessons/02.html"]);
});

test("Bash finite assignments, arrays and loops resolve redirected files", async () => {
  assert.deepEqual(await targets(`dir=course
files=(one.md two.md)
for file in "\${files[@]}"; do
  out="\${dir}/\${file}"
  printf hello > "$out"
done`), ["course/one.md", "course/two.md"]);
  assert.deepEqual(await targets(`for file in a.md b.md; do tee "$file" >/dev/null; done`), ["a.md", "b.md"]);
  assert.deepEqual(await targets(`for file in course/lessons/*.html; do echo hi > "$file"; done`), [
    "course/lessons/01.html", "course/lessons/02.html",
  ]);
  assert.deepEqual(await targets(`out=other.md; (out=inner.md; echo hi > "$out"); echo hi > "$out"`), [
    "inner.md", "other.md",
  ]);
  assert.deepEqual(await targets(`for part in course; do cd "$part"; done; echo hi > afterward.md`), [
    "course/afterward.md",
  ]);
  assert.deepEqual(await targets(`if test -d course; then cd course; echo hi > conditional.md; fi; echo hi > root.md`), [
    "course/conditional.md", "root.md",
  ]);
});

test("direct copy, move and remove operations name destination and removed source", async () => {
  assert.deepEqual(await targets("cp course/lessons/01.html course/copied.html"), ["course/copied.html"]);
  assert.deepEqual(await targets("cp course/lessons/01.html course/lessons/02.html course/"), [
    "course/01.html", "course/02.html",
  ]);
  assert.deepEqual(await targets("mv course/lessons/01.html course/moved.html"), [
    "course/lessons/01.html", "course/moved.html",
  ]);
  assert.deepEqual(await targets("git mv course/lessons/01.html course/moved.html"), [
    "course/lessons/01.html", "course/moved.html",
  ]);
  assert.deepEqual(await targets("rm -f course/lessons/*.html"), [
    "course/lessons/01.html", "course/lessons/02.html",
  ]);
  assert.deepEqual(await targets("rm -rf course/lessons"), []);
  assert.deepEqual(await targets("cp -t course/ course/lessons/01.html"), []);
  assert.deepEqual(await targets("cp -Rv course/lessons course/copied/"), []);
});

test("dynamic shell and Python expressions never guess file paths", async () => {
  assert.deepEqual(await targets(`out=$(printf x); printf hi > "$out"`), []);
  assert.deepEqual(await targets(`for file in "$UNSET"; do echo hi > "$file"; done`), []);
  assert.deepEqual(await targets(`files=(a.md b.md); echo hi > "\${files[@]}.bak"`), []);
  assert.deepEqual(await targets(`python3 - <<'PY'
fixes = {get_path(): 'a'}
for p in fixes:
    open(p, 'w').write('x')
PY`), []);
  assert.deepEqual(await targets(`python3 - <<'PY'
if unknown_condition:
    path='course/lessons/01.html'
open(path,'w').write('x')
PY`), []);
});

test("quoted shell paths preserve backslashes and failed cd stays in the original cwd", async () => {
  assert.deepEqual(await targets("echo hi > 'a\\nb'"), ["a\\nb"]);
  assert.deepEqual(await targets('echo hi > "course/lessons/*.html"'), ["course/lessons/*.html"]);
  assert.deepEqual(await targets("cd definitely-not-here; echo hi > still-here.txt"), ["still-here.txt"]);
  assert.deepEqual(await targets("mkdir -p new-dir && cd new-dir && echo hi > new.md"), ["new-dir/new.md"]);
});

test("recursive or unbounded globs are not scanned for speculative targets", async () => {
  assert.deepEqual(await targets("rm -f course/**/*.html"), []);
  assert.deepEqual(await targets(`python3 - <<'PY'
import glob
for p in glob.glob('course/**/*.html'):
    open(p, 'w').write('x')
PY`), []);
});

test("unknown targets, builds and out-of-project paths keep ordinary shell display", async () => {
  assert.deepEqual(await targets("python3 build.py"), []);
  assert.deepEqual(await targets("python3 -c 'import os; open(os.environ[\"DEST\"], \"w\").write(\"x\")'"), []);
  assert.deepEqual(await targets("cat > ../outside.txt <<'EOF'\nx\nEOF"), []);
  assert.deepEqual(await targets("cat > /tmp/outside.txt <<'EOF'\nx\nEOF"), []);
  assert.deepEqual(await targets("cd /tmp && cat > outside.txt <<'EOF'\nx\nEOF"), []);
});

test("heredocs before redirects or pipes still resolve their destinations", async () => {
  assert.deepEqual(await targets("cat <<'EOF' > new.ts\nhello\nEOF"), ["new.ts"]);
  assert.deepEqual(await targets("cat << EOF | tee piped.ts\nhello\nEOF"), ["piped.ts"]);
  assert.deepEqual(await targets("cat <<'EOF' > a.ts && echo x > b.ts\nhello\nEOF"), ["a.ts", "b.ts"]);
});

test("sed and perl in-place flags work in any position, with bundled or unresolved programs", async () => {
  assert.deepEqual(await targets("sed -e 's/a/b/' -i course/lessons/01.html"), ["course/lessons/01.html"]);
  assert.deepEqual(await targets("sed -n 's/a/b/p' course/lessons/01.html"), []);
  assert.deepEqual(await targets("perl -i -pe 's/a/b/' course/lessons/01.html"), ["course/lessons/01.html"]);
  assert.deepEqual(await targets("ruby -i -pe 'gsub(/a/, \"b\")' course/lessons/02.html"), ["course/lessons/02.html"]);
  assert.deepEqual(await targets(`sed -i '' 's/it/it'"'"'s/' course/lessons/01.html`), ["course/lessons/01.html"]);
  assert.deepEqual(await targets(`sed -i "s/$(date)/x/" course/lessons/02.html`), ["course/lessons/02.html"]);
});

test("read-only classification skips only commands that provably cannot write", async () => {
  const readers = [
    "ls -la", "rg -n foo src | head -20", "git status --short && git diff --stat", "cat a.txt 2>/dev/null || echo missing",
    "sed -n '1,20p' file.ts", "cd src && grep -rn x .", "git log --oneline -5 2>&1", "echo $(git rev-parse HEAD)",
    "find . -name '*.ts' -not -path './node_modules/*'", "wc -l < file.txt", "git branch --show-current",
    "cat <<'EOF'\nhello\nEOF",
  ];
  const writers = [
    "echo hi > out.txt", "sed -i 's/a/b/' f", "find . -delete", "find . -exec rm {} +", "sort -o out.txt in.txt",
    "git checkout -- f", "git branch new-feature", "xargs rm < list", "cat a | tee b", "python3 script.py", "npm test",
    "echo $(rm -rf x)", "awk '{print > \"out\"}' f", "git config user.name x", "$EDITOR file", "uniq in out",
    "cat <<'EOF' > f\nx\nEOF", "ls; touch x",
  ];
  for (const command of readers) assert.equal(await isReadOnly(command), true, command);
  for (const command of writers) assert.equal(await isReadOnly(command), false, command);
});
