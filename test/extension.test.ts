import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import readableEdits from "../src/index.js";

let work: string;
let tool: ToolDefinition<any, any>;
const context = () => ({
  cwd: process.cwd(),
  sessionManager: { getSessionId: () => "test", getSessionFile: () => undefined },
});
before(async () => {
  await mkdir("test", { recursive: true });
  work = await mkdtemp(join(process.cwd(), "test", ".scratch-"));
  readableEdits({
    registerTool(definition: ToolDefinition<any, any>) { tool = definition; },
  } as unknown as ExtensionAPI);
});
after(async () => { await rm(work, { recursive: true, force: true }); });

test("wrapped Bash executes normally and attaches an actual diff outside model content", async () => {
  const file = join(work, "edit.ts");
  await writeFile(file, "old\n");
  const command = `printf 'new\\n' > test/${work.split("/").pop()}/edit.ts; echo done`;
  const result = await tool.execute("test-call", { command }, undefined, undefined, context() as any);
  assert.equal(await readFile(file, "utf8"), "new\n");
  assert.match(JSON.stringify(result.content), /done/);
  assert.doesNotMatch(JSON.stringify(result.content), /-old/);
  assert.match(result.details.edits[0].patch, /-old/);
  assert.match(result.details.edits[0].patch, /\+new/);
  const rendered = tool.renderResult!(result, { expanded: true, isPartial: false },
    { fg: (_kind: string, text: string) => text } as any, { isError: false } as any).render(100).join("\n");
  assert.match(rendered, /Edits: test\/\.scratch-/);
  assert.match(rendered, /-old/);
  assert.match(rendered, /\+new/);
});

test("unrecognized command returns the normal result without an edits field", async () => {
  const result = await tool.execute("test-call-2", { command: "echo plain" }, undefined, undefined, context() as any);
  assert.match(JSON.stringify(result.content), /plain/);
  assert.equal(result.details?.edits, undefined);
});

test("finite Python mapping and direct shell commands attach only changed text diffs", async () => {
  const folder = `test/${work.split("/").pop()}`;
  await writeFile(join(work, "a.md"), "before a\n");
  await writeFile(join(work, "b.md"), "before b\n");
  const python = `python3 - <<'PY'
fixes = {'${folder}/a.md': 'after a\\n', '${folder}/b.md': 'after b\\n'}
for path, content in fixes.items():
    open(path, 'w').write(content)
PY`;
  const edited = await tool.execute("test-mapping", { command: python }, undefined, undefined, context() as any);
  assert.deepEqual(edited.details.edits.map((entry: { path: string }) => entry.path), [
    `${folder}/a.md`, `${folder}/b.md`,
  ]);
  assert.doesNotMatch(JSON.stringify(edited.content), /before a/);
  await writeFile(join(work, "gone.md"), "remove me\n");
  const moved = await tool.execute("test-file-ops", {
    command: `cp ${folder}/a.md ${folder}/copy.md && rm ${folder}/gone.md`,
  }, undefined, undefined, context() as any);
  assert.deepEqual(moved.details.edits.map((entry: { path: string }) => entry.path), [
    `${folder}/copy.md`, `${folder}/gone.md`,
  ]);
});
