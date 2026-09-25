import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import ts from "typescript";

export interface Call {
  id: string;
  source: "claude" | "codex";
  session: string;
  cwd: string;
  command: string;
}

const idFor = (command: string) => createHash("sha256").update(command).digest("hex").slice(0, 16);

async function walk(dir: string): Promise<string[]> {
  try {
    const children = await readdir(dir, { withFileTypes: true });
    const entries = await Promise.all(children.map(async (entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return walk(path);
      return entry.isFile() && entry.name.endsWith(".jsonl") ? [path] : [];
    }));
    return entries.flat();
  } catch {
    return [];
  }
}

function property(node: ts.ObjectLiteralExpression, key: string): ts.Expression | undefined {
  const match = node.properties.find((item) => ts.isPropertyAssignment(item) && item.name.getText() === key);
  return match && ts.isPropertyAssignment(match) ? match.initializer : undefined;
}

function string(node: ts.Expression | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

/** Parse Codex's JS tool wrapper; extract only static exec_command arguments. */
export function codexCommands(input: string, defaultCwd: string): Array<{ command: string; cwd: string }> {
  const tree = ts.createSourceFile("call.ts", input, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const results: Array<{ command: string; cwd: string }> = [];
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && node.expression.getText(tree).endsWith(".exec_command")) {
      const arg = node.arguments[0];
      if (arg && ts.isObjectLiteralExpression(arg)) {
        const command = string(property(arg, "cmd")) ?? string(property(arg, "command"));
        if (command) results.push({ command, cwd: string(property(arg, "workdir")) ?? defaultCwd });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return results;
}

async function extract(file: string, source: Call["source"]): Promise<Call[]> {
  const calls: Call[] = [];
  const seen = new Set<string>();
  let cwd = "";
  for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
    // Stream the JSONL, but do not parse reasoning, tool output or large encrypted payloads.
    if (source === "claude" && !line.includes('"tool_use"')) continue;
    if (source === "codex" && !line.includes('"session_meta"') &&
      !line.includes('"custom_tool_call"') && !line.includes('"function_call"')) continue;
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }
    if (source === "claude") {
      if (entry.type !== "assistant") continue;
      const blocks = entry.message?.content;
      if (!Array.isArray(blocks)) continue;
      for (const block of blocks) {
        if (block.type !== "tool_use" || block.name !== "Bash" || seen.has(block.id)) continue;
        seen.add(block.id);
        const command = block.input?.command;
        if (typeof command !== "string") continue;
        calls.push({ id: idFor(command), source, session: basename(file), cwd: entry.cwd ?? "", command });
      }
    } else {
      if (entry.type === "session_meta") cwd = entry.payload?.cwd ?? "";
      const payload = entry.payload;
      if (entry.type !== "response_item" || !payload) continue;
      let commands: Array<{ command: string; cwd: string }> = [];
      if (payload.type === "custom_tool_call" && typeof payload.input === "string") {
        commands = codexCommands(payload.input, cwd);
      } else if (payload.type === "function_call" && /^(?:exec_command|shell_command)$/.test(payload.name)) {
        try {
          const args = JSON.parse(payload.arguments);
          commands = [{ command: args.cmd ?? args.command, cwd: args.workdir ?? cwd }];
        } catch { /* unparseable arguments */ }
      }
      for (const { command, cwd: workdir } of commands) {
        if (typeof command === "string") calls.push({ id: idFor(command), source, session: basename(file), cwd: workdir, command });
      }
    }
  }
  return calls;
}

async function main(): Promise<void> {
  const out = process.argv[2] ?? ".local/corpus.jsonl";
  const maxPerSource = Number(process.env.CORPUS_SESSIONS ?? 12);
  const sources = [
    ["claude", join(homedir(), ".claude/projects")],
    ["codex", join(homedir(), ".codex/sessions")],
  ] as const;
  let required = new Set<string>();
  try {
    const gold = JSON.parse(await readFile(".local/gold.json", "utf8")) as Array<{ session: string }>;
    required = new Set(gold.map((label) => label.session));
  } catch { /* no local labels yet */ }
  const all: Call[] = [];
  for (const [source, dir] of sources) {
    const files = await walk(dir);
    const ranked = (await Promise.all(files.map(async (path) => ({ path, time: (await stat(path)).mtimeMs }))))
      .sort((a, b) => b.time - a.time);
    const recent = ranked.filter((item, index) => index < maxPerSource || required.has(basename(item.path)));
    for (const { path } of recent) all.push(...await extract(path, source));
    console.log(`${source}: ${recent.length} sessions, ${all.filter((call) => call.source === source).length} Bash calls`);
  }
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, all.map((call) => JSON.stringify(call)).join("\n") + "\n", { mode: 0o600 });
  console.log(`Saved ${all.length} Bash calls to ${out} (private; keep gitignored).`);
}

if (process.argv[1]?.endsWith("corpus.ts")) await main();
