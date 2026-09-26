import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import readableEdits from "../src/index.js";
import type { EditCardData } from "../src/render.js";
import { cleanup, directory, piTheme, plain, repository, sh } from "./helpers.js";

type Handler = (event: any, ctx: any) => unknown;

/** Loads the extension into a minimal stand-in for Pi's extension runtime. */
function load() {
  const handlers = new Map<string, Handler[]>();
  const appended: Array<{ customType: string; data: unknown }> = [];
  const notices: string[] = [];
  let renderer: ((entry: any, options: any, theme: Theme) => any) | undefined;
  let command: ((args: string, ctx: any) => Promise<void>) | undefined;
  readableEdits({
    on: (event: string, handler: Handler) => { handlers.set(event, [...(handlers.get(event) ?? []), handler]); return () => {}; },
    registerEntryRenderer: (_type: string, fn: typeof renderer) => { renderer = fn; },
    registerCommand: (_name: string, options: { handler: typeof command }) => { command = options.handler; },
    appendEntry: (customType: string, data: unknown) => appended.push({ customType, data }),
  } as any);
  const emit = async (event: string, payload: object, ctx: object) => {
    let result: unknown;
    for (const handler of handlers.get(event) ?? []) result = await handler({ type: event, ...payload }, ctx);
    return result;
  };
  return { emit, appended, notices, render: () => renderer!, command: () => command! };
}

function context(cwd: string, notices: string[] = [], mode = "tui") {
  return { cwd, mode, hasUI: true, ui: { notify: (message: string) => notices.push(message) } };
}

/** Runs one shell tool call through the same event sequence Pi uses. */
async function bash(pi: ReturnType<typeof load>, ctx: object & { cwd: string }, id: string, command: string, fail = false) {
  await pi.emit("tool_execution_start", { toolCallId: id, toolName: "bash", args: { command } }, ctx);
  await pi.emit("tool_call", { toolCallId: id, toolName: "bash", input: { command } }, ctx);
  sh(command, ctx.cwd);
  await pi.emit("tool_execution_end", { toolCallId: id, toolName: "bash", result: {}, isError: fail }, ctx);
}

const roots: string[] = [];
let theme: Theme;
before(async () => { theme = await piTheme(); });
after(() => cleanup(...roots));

test("a bash edit becomes a card appended after the turn's tool results, chained with other extensions' entries", async () => {
  const root = await repository({ "src/app.ts": "const port = 3000;\n" });
  roots.push(root);
  const pi = load();
  const ctx = context(root);
  await pi.emit("session_start", { reason: "startup" }, ctx);
  await bash(pi, ctx, "call-1", "sed -i.bak 's/3000/8080/' src/app.ts && rm src/app.ts.bak");
  const other = { type: "custom", customType: "someone-else", data: {} };
  const result = await pi.emit("turn_end", { entries: [other] }, ctx) as { entries: any[] };
  assert.equal(result.entries[0], other);
  const card = result.entries[1].data as EditCardData;
  assert.equal(result.entries[1].customType, "readable-edits");
  assert.deepEqual(card.files.map((file) => [file.path, file.added, file.removed]), [["src/app.ts", 1, 1]]);
  assert.equal(card.mode, "git");

  const lines = plain(pi.render()({ data: card }, { expanded: false }, theme).render(90));
  assert.ok(lines.some((line) => line.startsWith("✎ Edited src/app.ts  +1 −1")));
  assert.ok(lines.includes("-1 const port = 3000;") && lines.includes("+1 const port = 8080;"));
  assert.equal(await pi.emit("turn_end", { entries: [] }, ctx), undefined, "cards are delivered once");
});

test("read-only commands are not snapshotted, and print mode is never observed", async () => {
  const root = await repository({ "a.txt": "a\n" });
  roots.push(root);
  const pi = load();
  const notices: string[] = [];
  await bash(pi, context(root), "read", "cat a.txt && git status --short");
  assert.equal(await pi.emit("turn_end", { entries: [] }, context(root)), undefined);
  await pi.command()("status", context(root, notices));
  assert.match(notices[0]!, /No shell commands observed yet/);
  const print = context(root, [], "print");
  await bash(pi, print, "print", "echo b > a.txt");
  assert.equal(await pi.emit("turn_end", { entries: [] }, print), undefined);
});

test("outside Git, files the command names are still diffed", async () => {
  const root = await directory({ "notes.md": "Teh plan\n" });
  roots.push(root);
  const pi = load();
  const ctx = context(root);
  await bash(pi, ctx, "c", "cat <<'EOF' > notes.md\nThe plan\nEOF");
  const result = await pi.emit("turn_end", { entries: [] }, ctx) as { entries: any[] };
  const card = result.entries[0].data as EditCardData;
  assert.equal(card.mode, "targeted");
  assert.deepEqual(card.files.map((file) => file.path), ["notes.md"]);
});

test("a run that ends without turn_end still records its card", async () => {
  const root = await repository({ "a.txt": "a\n" });
  roots.push(root);
  const pi = load();
  const ctx = context(root);
  await pi.emit("tool_call", { toolCallId: "x", toolName: "bash", input: { command: "echo b > a.txt" } }, ctx);
  sh("echo b > a.txt", root);
  await pi.emit("agent_end", { messages: [] }, ctx);
  assert.equal(pi.appended.length, 1);
  assert.equal(pi.appended[0]!.customType, "readable-edits");
});

test("the command toggles observation and reports how each repository is watched", async () => {
  const root = await repository({ "a.txt": "a\n" });
  roots.push(root);
  const pi = load();
  const notices: string[] = [];
  const ctx = context(root, notices);
  await pi.command()("off", ctx);
  await bash(pi, ctx, "1", "echo b > a.txt");
  assert.equal(await pi.emit("turn_end", { entries: [] }, ctx), undefined);
  await pi.command()("on", ctx);
  await bash(pi, ctx, "2", "echo c > a.txt");
  await pi.command()("", ctx);
  assert.match(notices.at(-1)!, /Readable edits: on\n.*: Git snapshots, 2 taken, \d+ms average/);
});
