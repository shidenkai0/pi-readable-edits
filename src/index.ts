import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { capture, compare, type DiffEntry } from "./diffs.js";
import { extractTargets, scopeRoot } from "./targets.js";

interface ReadableDetails {
  edits?: DiffEntry[];
  truncation?: unknown;
  fullOutputPath?: string;
}

/**
 * Wraps Pi's normal bash tool. Recognition is intentionally best effort: an
 * unknown command runs and renders exactly like an ordinary bash command.
 */
export default function readableEdits(pi: ExtensionAPI): void {
  const original = createBashToolDefinition(process.cwd());
  pi.registerTool({
    ...original,
    // Sibling tools must not overlap a before/after comparison.
    executionMode: "sequential",
    async execute(id, params, signal, onUpdate, ctx) {
      let snapshots: Awaited<ReturnType<typeof capture>> = [];
      let root = ctx.cwd;
      try {
        root = await scopeRoot(ctx.cwd);
        snapshots = await capture(await extractTargets(params.command, ctx.cwd, root), root);
      } catch {
        // File inspection must never prevent the requested command from running.
      }
      const result = await original.execute(id, params, signal, onUpdate, ctx);
      try {
        const edits = await compare(snapshots, root);
        if (edits.length) return { ...result, details: { ...result.details, edits } };
      } catch {
        // Preserve the original result if a file disappears or becomes unreadable.
      }
      return result;
    },
    renderResult(result, options, theme, context) {
      const edits = (result.details as ReadableDetails | undefined)?.edits ?? [];
      const output = result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
      const lines = output.split("\n");
      const outputLimit = options.expanded ? 200 : 10;
      let body = lines.slice(0, outputLimit).map((line) => theme.fg("toolOutput", line)).join("\n");
      if (lines.length > outputLimit) body += theme.fg("muted", `\n… ${lines.length - outputLimit} more output lines`);
      if (context.isError) body = theme.fg("error", body);
      if (options.isPartial) return new Text(body || "Running…", 0, 0);
      if (edits.length) {
        body += `\n${theme.fg("success", `Edits: ${edits.map((edit) => edit.path).join(", ")}`)}`;
        const patch = edits.map((edit) => edit.patch).join("\n");
        const patchLines = patch.split("\n");
        const limit = options.expanded ? 400 : 24;
        body += "\n" + patchLines.slice(0, limit).map((line) => {
          if (line.startsWith("+") && !line.startsWith("+++")) return theme.fg("success", line);
          if (line.startsWith("-") && !line.startsWith("---")) return theme.fg("error", line);
          return theme.fg("dim", line);
        }).join("\n");
        if (patchLines.length > limit) body += theme.fg("muted", `\n… ${patchLines.length - limit} more diff lines (expand)`);
      }
      return new Text(body, 0, 0);
    },
  });
}
