import assert from "node:assert/strict";
import { before, test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describeChanges, type RawChange } from "../src/changes.js";
import { type EditCardData, renderCard } from "../src/render.js";
import { piTheme, plain } from "./helpers.js";

let theme: Theme;
before(async () => { theme = await piTheme(); });

const text = (value: string) => ({ kind: "text" as const, text: value });
const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n") + "\n";

function card(raw: RawChange[], extra: Partial<EditCardData> = {}): EditCardData {
  return { v: 1, commands: ["sed -i s/a/b/ file"], ...describeChanges(raw, "/w"), ...extra };
}

function render(data: EditCardData, expanded: boolean, width = 80): string[] {
  const rendered = renderCard(data, expanded, theme).render(width);
  for (const line of rendered) assert.ok(visibleWidth(line) <= width, `line exceeds ${width}: ${JSON.stringify(line)}`);
  return plain(rendered);
}

test("a single small edit shows its title, stats, command and whole diff", () => {
  const out = render(card([{ path: "/w/src/app.ts", before: text("a\nb\n"), after: text("a\nc\n") }]), false);
  assert.match(out[1]!, /✎ Edited src\/app\.ts {2}\+1 −1 +\$ sed -i s\/a\/b\/ file$/);
  assert.ok(out.includes("-2 b") && out.includes("+2 c"));
  assert.ok(!out.some((line) => line.includes("to expand")));
});

test("long diffs collapse to a preview with an expand hint; expanded shows everything", () => {
  const data = card([{ path: "/w/big.txt", before: text(lines(40)), after: text(lines(40).replace(/line (\d*[05])\n/g, "LINE $1\n")) }]);
  const collapsed = render(data, false);
  assert.ok(collapsed.some((line) => /more diff lines .*to expand/.test(line)));
  const expanded = render(data, true);
  assert.ok(expanded.includes("+40 LINE 40"));
  assert.ok(expanded.length > collapsed.length);
});

test("multi-file cards list every file with a status letter and counts", () => {
  const out = render(card([
    { path: "/w/a.ts", before: text("a\n"), after: text("b\n") },
    { path: "/w/b.ts", before: { kind: "absent" }, after: text("new\n") },
    { path: "/w/c.ts", before: text("c\n"), after: { kind: "absent" } },
    { path: "/w/.env", before: text("K=1\n"), after: text("K=2\n") },
  ]), false);
  assert.match(out[1]!, /Changed 4 files {2}\+3 −3/);
  assert.ok(out.some((line) => /^ {2}M {2}\.env +\+1 −1 .*contents hidden/.test(line)));
  assert.ok(out.some((line) => /^ {2}A {2}b\.ts +\+1/.test(line)));
  assert.ok(out.some((line) => /^ {2}D {2}c\.ts +−1/.test(line)));
  assert.ok(!out.join("\n").includes("K=2"));
});

test("narrow terminals clip rather than overflow", () => {
  const data = card([{ path: "/w/a/very/deeply/nested/directory/structure/with/a/long/file-name.ts",
    before: text("x".repeat(300) + "\n"), after: text("y".repeat(300) + "\n") }], { commands: ["z".repeat(400)] });
  render(data, true, 30);
  render(data, false, 44);
});

test("failures, parallel commands and edit-tool overlaps are called out", () => {
  const data = card([{ path: "/w/a.ts", before: text("a\n"), after: text("b\n") }],
    { commands: ["one", "two"], failed: true, shownElsewhere: ["README.md"] });
  const out = render(data, true, 100).join("\n");
  assert.match(out, /failed 2 parallel commands/);
  assert.match(out, /\$ one\n.*\$ two/);
  assert.match(out, /Pi's edit tool, with its own diff: README\.md/);
});

test("wrapped diff lines keep every word and indent under the gutter", () => {
  const words = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau";
  const out = render(card([{ path: "/w/a.md", before: text("x\n"), after: text(`${words}\n`) }]), true, 30);
  const start = out.findIndex((line) => line.startsWith("+1 "));
  const wrapped = out.slice(start, out.findIndex((line, i) => i > start && !line.startsWith("   ")));
  assert.ok(wrapped.length >= 3);
  assert.equal(wrapped.map((line) => line.slice(3).trim()).join(" "), words);
});
