import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { shellCall } from "../src/index.js";
import { extractTargets } from "../src/targets.js";
import { family } from "./corpus.js";

/**
 * How often models edit files through the shell instead of an edit tool, in
 * local Claude Code and Pi transcripts. Shell edits are commands the parser
 * finds targets in, so this slightly undercounts them.
 *
 * usage: tsx scripts/share.ts
 */

const CLAUDE_EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const PI_EDIT_TOOLS = new Set(["edit", "write", "apply_patch"]);

async function files(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true }).catch(() => []);
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl")).map((entry) => join(entry.parentPath, entry.name));
}

const edits = async (command: string, cwd: string) =>
  (await extractTargets(command, cwd, { directoryExists: () => true }).catch(() => [])).length > 0;

async function main(): Promise<void> {
  const counts = new Map<string, { tool: number; shell: number }>();
  const count = (key: string) => counts.get(key) ?? counts.set(key, { tool: 0, shell: 0 }).get(key)!;
  const seen = new Set<string>();
  for (const file of await files(join(homedir(), ".claude/projects"))) {
    for await (const line of createInterface({ input: createReadStream(file) })) {
      if (!line.includes('"tool_use"')) continue;
      let entry: any;
      try { entry = JSON.parse(line); } catch { continue; }
      for (const block of entry.message?.content ?? []) {
        if (block.type !== "tool_use" || seen.has(block.id)) continue;
        seen.add(block.id);
        if (CLAUDE_EDIT_TOOLS.has(block.name)) count("claude (Claude Code)").tool++;
        else if (block.name === "Bash" && typeof block.input?.command === "string" &&
          await edits(block.input.command, entry.cwd ?? homedir())) count("claude (Claude Code)").shell++;
      }
    }
  }
  for (const file of await files(join(homedir(), ".pi/agent/sessions"))) {
    let cwd = homedir();
    for await (const line of createInterface({ input: createReadStream(file) })) {
      if (!line.includes('"toolCall"') && !line.includes('"type":"session"')) continue;
      let entry: any;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry.type === "session") cwd = entry.cwd ?? cwd;
      const message = entry.message;
      if (entry.type !== "message" || message?.role !== "assistant") continue;
      const key = `${family({ source: "pi", model: `${message.provider}/${message.model}` })} (Pi)`;
      for (const block of message.content ?? []) {
        if (block.type !== "toolCall") continue;
        if (PI_EDIT_TOOLS.has(block.name)) count(key).tool++;
        const shell = shellCall(block.name, block.arguments, cwd);
        if (shell && await edits(shell.command, shell.cwd)) count(key).shell++;
      }
    }
  }
  console.table(Object.fromEntries([...counts].map(([key, { tool, shell }]) => [key, {
    "edit tool calls": tool, "shell edits": shell, "shell share": `${Math.round(100 * shell / Math.max(1, tool + shell))}%`,
  }])));
}

await main();
