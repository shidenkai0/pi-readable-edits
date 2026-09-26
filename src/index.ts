import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Engine } from "./engine.js";
import { sweepStaleState } from "./git.js";
import { isReadOnly } from "./targets.js";
import { CARD_TYPE, type EditCardData, renderCard } from "./render.js";
import { EditTracker } from "./tracker.js";

/** Tools that run arbitrary shell commands, and so may edit files without showing a diff. */
const SHELL_TOOLS = new Set(["bash", "powershell"]);

/**
 * Shows a diff card after shell commands that change files.
 *
 * Nothing about the shell tool itself changes: it is observed through tool
 * events, so any bash implementation (sandboxed, remote, custom-rendered)
 * keeps working. Cards are custom session entries, rendered for the user and
 * never included in model context.
 */
export default function readableEdits(pi: ExtensionAPI): void {
  let enabled = true;
  let ui: ExtensionContext["ui"] | undefined;
  const pending: EditCardData[] = [];
  const engine = new Engine((message) => ui?.notify(`Readable edits: ${message}`, "warning"));
  const tracker = new EditTracker(engine, (card) => pending.push(card));

  const watching = (ctx: ExtensionContext) => enabled && (ctx.mode === "tui" || ctx.mode === "rpc");

  pi.registerEntryRenderer<EditCardData>(CARD_TYPE, (entry, { expanded }, theme) =>
    entry.data?.v === 1 && entry.data.files.length ? renderCard(entry.data, expanded, theme) : undefined);

  pi.on("session_start", async (_event, ctx) => {
    ui = ctx.ui;
    tracker.reset();
    pending.length = 0;
    void sweepStaleState();
  });

  pi.on("tool_execution_start", (event, ctx) => {
    if (watching(ctx)) tracker.toolStarted(event.toolCallId, event.toolName, event.args, ctx.cwd);
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!watching(ctx) || !SHELL_TOOLS.has(event.toolName)) return;
    const command = (event.input as { command?: unknown }).command;
    if (typeof command !== "string") return;
    // Most agent commands only read; skipping their snapshots keeps the shell fast.
    if (event.toolName === "bash" && await isReadOnly(command).catch(() => false)) return;
    // A tool_call handler that throws would block the command, so never let one escape.
    await tracker.shellStarting(event.toolCallId, command, ctx.cwd).catch(() => {});
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
    await engine.dispose();
  });

  pi.registerCommand("readable-edits", {
    description: "Show or toggle diff cards for shell edits (on, off, status)",
    getArgumentCompletions: (prefix) => ["on", "off", "status"]
      .filter((option) => option.startsWith(prefix.trim()))
      .map((option) => ({ value: option, label: option })),
    handler: async (args, ctx) => {
      const choice = args.trim().toLowerCase();
      if (choice === "on" || choice === "off") {
        enabled = choice === "on";
        if (!enabled) tracker.reset();
        ctx.ui.notify(`Readable edits ${enabled ? "on" : "off"}`, "info");
        return;
      }
      const repositories = engine.status();
      const lines = [`Readable edits: ${enabled ? "on" : "off"}`];
      if (!repositories.length) lines.push("No shell commands observed yet in this session.");
      for (const repo of repositories) {
        lines.push(repo.mode === "git"
          ? `${repo.root}: Git snapshots, ${repo.snapshots} taken, ${repo.averageMs}ms average`
          : `${repo.root}: command parsing (${repo.reason})`);
      }
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
