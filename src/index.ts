import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CARD_TYPE, type EditCardData, renderCard } from "./render.js";
import { EditTracker } from "./tracker.js";

/**
 * Reads a tool call that runs a shell command: Pi's `bash`, or the Codex
 * command tools (`exec_command`, `shell_command`) that OpenAI-compatibility
 * extensions put in its place, which take a `workdir`.
 */
export function shellCall(toolName: string, input: unknown, cwd: string): { command: string; cwd: string } | undefined {
  const args = (input ?? {}) as { command?: unknown; cmd?: unknown; workdir?: unknown };
  const command = toolName === "bash" || toolName === "shell_command" ? args.command
    : toolName === "exec_command" ? args.cmd : undefined;
  if (typeof command !== "string") return undefined;
  return { command, cwd: typeof args.workdir === "string" && args.workdir ? resolve(cwd, args.workdir) : cwd };
}

/**
 * Shows a diff card after shell commands that edit files.
 *
 * Nothing about the shell tool itself changes: it is observed through tool
 * events, so any bash implementation (sandboxed, remote, custom-rendered)
 * keeps working. Cards are custom session entries, rendered for the user and
 * never included in model context.
 */
export default function readableEdits(pi: ExtensionAPI): void {
  let enabled = true;
  const pending: EditCardData[] = [];
  const tracker = new EditTracker((card) => pending.push(card));

  const watching = (ctx: ExtensionContext) => enabled && (ctx.mode === "tui" || ctx.mode === "rpc");

  pi.registerEntryRenderer<EditCardData>(CARD_TYPE, (entry, { expanded }, theme) =>
    entry.data?.v === 1 && entry.data.files.length ? renderCard(entry.data, expanded, theme) : undefined);

  pi.on("session_start", async () => {
    tracker.reset();
    pending.length = 0;
  });

  pi.on("tool_execution_start", (event, ctx) => {
    if (watching(ctx)) tracker.toolStarted(event.toolCallId, event.toolName, event.args, ctx.cwd);
  });

  pi.on("tool_call", async (event, ctx) => {
    const shell = watching(ctx) ? shellCall(event.toolName, event.input, ctx.cwd) : undefined;
    if (!shell) return;
    // A tool_call handler that throws would block the command, so never let one escape.
    await tracker.shellStarting(event.toolCallId, shell.command, shell.cwd, ctx.cwd).catch(() => {});
  });

  pi.on("tool_execution_end", async (event) => {
    await tracker.toolEnded(event.toolCallId, event.isError);
  });

  // Tool results are persisted before turn_end, so cards land after the calls that caused them.
  pi.on("turn_end", async (event) => {
    await tracker.flush();
    if (!pending.length) return;
    const cards = pending.splice(0).map((data) => ({ type: "custom" as const, customType: CARD_TYPE, data }));
    return { entries: [...event.entries, ...cards] };
  });

  pi.on("agent_end", async () => {
    await tracker.flush();
    for (const card of pending.splice(0)) pi.appendEntry(CARD_TYPE, card);
  });

  pi.on("session_shutdown", async () => {
    tracker.reset();
  });

  pi.registerCommand("readable-edits", {
    description: "Turn diff cards for shell edits on or off",
    getArgumentCompletions: (prefix) => ["on", "off"]
      .filter((option) => option.startsWith(prefix.trim()))
      .map((option) => ({ value: option, label: option })),
    handler: async (args, ctx) => {
      const choice = args.trim().toLowerCase();
      if (choice === "on" || choice === "off") {
        enabled = choice === "on";
        if (!enabled) tracker.reset();
      }
      ctx.ui.notify(`Readable edits ${enabled ? "on" : "off"}`, "info");
    },
  });
}
