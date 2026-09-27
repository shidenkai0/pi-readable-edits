import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { FileCapture } from "./capture.js";
import { describeChanges, displayPath, type RawChange } from "./changes.js";
import type { EditCardData } from "./render.js";

export interface Capture {
  /** Adds a command that joined the capture while it was open. */
  include(command: string, cwd: string): Promise<void>;
  finish(): Promise<RawChange[]>;
}

export interface CaptureSource {
  start(command: string, cwd: string): Promise<Capture>;
}

interface Member {
  command: string;
  done: boolean;
  failed: boolean;
}

interface Group {
  /** The session's directory; card paths are shown relative to it. */
  cwd: string;
  capture: Promise<Capture | undefined>;
  members: Map<string, Member>;
  /** Paths that tools with their own diff (edit, write, apply_patch) touched while this group was open. */
  shownElsewhere: Set<string>;
}

/**
 * Files a tool call edits when that tool already renders its own diff: Pi's
 * `edit` and `write`, and `apply_patch` (OpenAI models, via Codex-compatible
 * extensions), including `apply_patch` invoked through the shell.
 */
export function selfDiffingPaths(name: string, args: unknown): string[] {
  const input = (args ?? {}) as { path?: unknown; file_path?: unknown; patch?: unknown; input?: unknown };
  if (name === "edit" || name === "write") {
    const path = input.path ?? input.file_path;
    return typeof path === "string" ? [path] : [];
  }
  const patch = name === "apply_patch" ? input.patch ?? input.input ?? args : undefined;
  return typeof patch === "string" ? patchPaths(patch) : [];
}

/** File paths named by a Codex-format patch (`*** Update File: path`, `*** Move to: path`, …). */
export function patchPaths(patch: string): string[] {
  if (!patch.includes("*** Begin Patch")) return [];
  return [...patch.matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+?)\s*$/gm)].map((match) => match[1]!);
}

/**
 * Turns tool lifecycle events into edit cards.
 *
 * Pi can run tool calls from one assistant message in parallel, so shell calls
 * whose executions overlap share one capture: it opens before the first starts
 * and closes after the last finishes. That keeps every change attributable to
 * the commands on the card without serializing the user's tools.
 */
export class EditTracker {
  private group?: Group;
  private readonly editsInFlight = new Map<string, string[]>();

  private readonly source: CaptureSource;
  private readonly onError: (error: unknown) => void;

  constructor(
    private readonly onCard: (card: EditCardData) => void,
    options: { source?: CaptureSource; onError?: (error: unknown) => void } = {},
  ) {
    this.source = options.source ?? FileCapture;
    this.onError = options.onError ?? (() => {});
  }

  /** Call before a shell command executes; resolves once its "before" state is recorded. */
  async shellStarting(id: string, command: string, directory: string, sessionDirectory = directory): Promise<void> {
    const cwd = canonical(directory);
    // `apply_patch <<'EOF'` through the shell is rendered as a patch by Codex-compatible extensions.
    if (/^\s*(?:cd\s+\S+\s*&&\s*)?apply_patch\b/.test(command)) this.recordSelfDiffing(id, patchPaths(command), cwd);
    const open = this.group;
    if (open) {
      open.members.set(id, { command, done: false, failed: false });
      try {
        await (await open.capture)?.include(command, cwd);
      } catch (error) {
        this.onError(error);
      }
      return;
    }
    const group: Group = {
      cwd: canonical(sessionDirectory),
      members: new Map([[id, { command, done: false, failed: false }]]),
      shownElsewhere: new Set([...this.editsInFlight.values()].flat()),
      capture: this.source.start(command, cwd).catch((error) => {
        this.onError(error);
        return undefined;
      }),
    };
    this.group = group;
    await group.capture;
  }

  /** Call when any tool starts executing. */
  toolStarted(id: string, name: string, args: unknown, cwd: string): void {
    this.recordSelfDiffing(id, selfDiffingPaths(name, args), canonical(cwd));
  }

  private recordSelfDiffing(id: string, paths: string[], cwd: string): void {
    if (!paths.length) return;
    const absolute = paths.map((path) => resolve(cwd, path));
    this.editsInFlight.set(id, absolute);
    for (const path of absolute) this.group?.shownElsewhere.add(path);
  }

  /** Call when any tool finishes; closes the capture after its last shell command. */
  async toolEnded(id: string, isError: boolean): Promise<void> {
    this.editsInFlight.delete(id);
    const group = this.group;
    const member = group?.members.get(id);
    if (!group || !member) return;
    member.done = true;
    member.failed = isError;
    if ([...group.members.values()].every((entry) => entry.done)) await this.close(group);
  }

  /** Closes an open capture whose end events never arrived (for example after an abort). */
  async flush(): Promise<void> {
    if (this.group) await this.close(this.group);
  }

  reset(): void {
    this.group = undefined;
    this.editsInFlight.clear();
  }

  private async close(group: Group): Promise<void> {
    if (this.group === group) this.group = undefined;
    try {
      const capture = await group.capture;
      if (!capture) return;
      const raw = await capture.finish();
      const elsewhere = raw.filter((change) => group.shownElsewhere.has(change.path));
      const own = raw.filter((change) => !group.shownElsewhere.has(change.path));
      const { files, omittedFiles } = describeChanges(own, group.cwd);
      if (!files.length) return;
      const members = [...group.members.values()];
      this.onCard({
        v: 1,
        commands: members.map((member) => summarizeCommand(member.command)),
        files,
        ...(omittedFiles ? { omittedFiles } : {}),
        ...(elsewhere.length ? { shownElsewhere: elsewhere.map((change) => displayPath(change.path, group.cwd)) } : {}),
        ...(members.some((member) => member.failed) ? { failed: true } : {}),
        cwd: group.cwd,
      });
    } catch (error) {
      this.onError(error);
    }
  }
}

/** Cards only display a command's first line; a long heredoc body need not be stored twice. */
export function summarizeCommand(command: string): string {
  const trimmed = command.trim();
  const newline = trimmed.indexOf("\n");
  const first = newline < 0 ? trimmed : `${trimmed.slice(0, newline)} …`;
  return first.length > 240 ? `${first.slice(0, 239)}…` : first;
}

/** Targets are compared by canonical path; a symlinked working directory (macOS /var, ~/src links) must match them. */
function canonical(directory: string): string {
  try {
    return realpathSync(directory);
  } catch {
    return directory;
  }
}
