import { keyHint, renderDiff, type Theme } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  Box, type Component, getCapabilities, hyperlink, sliceByColumn, truncateToWidth, visibleWidth, wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { FileChange } from "./changes.js";

export const CARD_TYPE = "readable-edits";

/** Persisted in the session as a custom entry; never sent to the model. */
export interface EditCardData {
  v: 1;
  /** Shell commands whose execution windows produced these changes. */
  commands: string[];
  files: FileChange[];
  omittedFiles?: number;
  /** Paths changed concurrently by Pi's edit/write tools, which render their own diffs. */
  shownElsewhere?: string[];
  failed?: boolean;
  /** Set by 0.2 cards (Git snapshot or parser); unused since. */
  mode?: string;
  /** Directory the paths are relative to; used for clickable links. */
  cwd?: string;
}

/** Collapsed cards show everything when the diff is at most this long... */
const COMPACT_DIFF_LINES = 16;
/** ...and otherwise a preview of this many diff lines. */
const PREVIEW_DIFF_LINES = 10;
const COLLAPSED_FILE_ROWS = 8;
const MIN_PREVIEW_LINES = 5;

export function renderCard(data: EditCardData, expanded: boolean, theme: Theme): Component {
  const box = new Box(1, 1, (line) => theme.bg("toolSuccessBg", line));
  box.addChild(new CardBody(data, expanded, theme));
  return box;
}

type Line = (width: number) => string[];

class CardBody implements Component {
  private cache?: { width: number; lines: string[] };

  constructor(private readonly data: EditCardData, private readonly expanded: boolean, private readonly theme: Theme) {}

  invalidate(): void {
    this.cache = undefined;
  }

  render(width: number): string[] {
    if (this.cache?.width === width) return this.cache.lines;
    const lines = this.build().flatMap((line) => line(width)).map((line) => truncateToWidth(line, width, ""));
    this.cache = { width, lines };
    return lines;
  }

  private build(): Line[] {
    const { data, expanded, theme } = this;
    const files = data.files;
    const single = files.length === 1 && !data.omittedFiles;
    const lines: Line[] = [this.header(single)];

    if (!single) {
      lines.push(...this.fileList(expanded ? files.length : COLLAPSED_FILE_ROWS));
    } else if (files[0]?.detail) {
      lines.push(fixed(theme.fg("muted", files[0].detail)));
    }

    const diffs = files.filter((file) => file.diff && (expanded || !file.generated) && file.summary === undefined);
    const totalDiffLines = diffs.reduce((sum, file) => sum + file.diff!.split("\n").length, 0);
    const budget = expanded || totalDiffLines <= COMPACT_DIFF_LINES ? Infinity : PREVIEW_DIFF_LINES;
    let shown = 0;
    for (const file of diffs) {
      const raw = file.diff!.split("\n");
      const left = budget - shown;
      // A preview that would cut a file to a stub is less useful than stopping.
      if (left <= 0 || (left < raw.length && left < MIN_PREVIEW_LINES)) break;
      const take = Math.min(raw.length, left);
      lines.push(blank);
      if (!single) lines.push(this.fileRule(file));
      lines.push(...diffLines(raw.slice(0, take)));
      shown += take;
      if (expanded && file.omittedLines) {
        lines.push(fixed(theme.fg("muted", `  … ${file.omittedLines} more diff lines not stored`)));
      }
    }

    const hiddenLines = totalDiffLines - shown;
    const notes = this.notes(hiddenLines);
    if (notes.length) lines.push(blank, ...notes);
    return lines;
  }

  private header(single: boolean): Line {
    const { data, theme } = this;
    const added = data.files.reduce((sum, file) => sum + file.added, 0);
    const removed = data.files.reduce((sum, file) => sum + file.removed, 0);
    const count = data.files.length + (data.omittedFiles ?? 0);
    const icon = theme.fg("accent", "✎");
    const stats = formatStats(added, removed, theme);
    const source = sourceLabel(data);
    return (width) => {
      let title: string;
      if (single) {
        const file = data.files[0]!;
        const verb = { added: "Created", deleted: "Deleted", renamed: "Renamed", modified: "Edited" }[file.status];
        const path = file.oldPath
          ? `${styledPath(file.oldPath, theme)} ${theme.fg("muted", "→")} ${linked(styledPath(file.path, theme), file, data.cwd)}`
          : linked(styledPath(file.path, theme), file, data.cwd);
        title = `${theme.fg("toolTitle", theme.bold(verb))} ${path}`;
      } else {
        title = theme.fg("toolTitle", theme.bold(`Changed ${count} files`));
      }
      const left = `${icon} ${title}${stats ? `  ${stats}` : ""}`;
      const leftWidth = visibleWidth(left);
      const failed = data.failed ? "failed " : "";
      const room = Math.min(width - leftWidth - 3, Math.max(24, Math.floor(width * 0.5)));
      if (room < 12) return [truncateToWidth(left, width)];
      const label = clip(source, room - failed.length);
      const right = (failed ? theme.fg("error", failed) : "") + theme.fg("dim", label);
      return [left + " ".repeat(Math.max(2, width - leftWidth - visibleWidth(right))) + right];
    };
  }

  private fileList(limit: number): Line[] {
    const { data, theme } = this;
    const rows = data.files.slice(0, limit);
    const maxChanges = Math.max(1, ...data.files.map((file) => file.added + file.removed));
    const lines: Line[] = [blank];
    lines.push((width) => {
      const pathWidth = Math.min(
        Math.max(...rows.map((file) => visibleWidth(plainPath(file)))),
        Math.max(12, width - 30),
      );
      return rows.map((file) => {
        const letter = { added: theme.fg("success", "A"), deleted: theme.fg("error", "D"),
          renamed: theme.fg("accent", "R"), modified: theme.fg("warning", "M") }[file.status];
        const path = linked(fitPath(file, pathWidth, theme), file, data.cwd);
        const pad = " ".repeat(Math.max(0, pathWidth - visibleWidth(path)));
        const tail = rowTail(file, maxChanges, theme);
        return `  ${letter}  ${path}${pad}  ${tail}`;
      });
    });
    const more = data.files.length - rows.length + (data.omittedFiles ?? 0);
    if (more > 0) lines.push(fixed(theme.fg("muted", `     … ${more} more file${more === 1 ? "" : "s"}`)));
    return lines;
  }

  private fileRule(file: FileChange): Line {
    const { theme, data } = this;
    return (width) => {
      const label = ` ${file.oldPath ? `${file.oldPath} → ` : ""}${file.path} `;
      const head = theme.fg("borderMuted", "──") + linked(theme.fg("accent", clip(label, width - 4)), file, data.cwd);
      const fill = Math.max(0, width - visibleWidth(head));
      return [head + theme.fg("borderMuted", "─".repeat(fill))];
    };
  }

  private notes(hiddenLines: number): Line[] {
    const { data, expanded, theme } = this;
    const notes: string[] = [];
    if (!expanded) {
      const hiddenGenerated = data.files.filter((file) => file.generated && file.diff).length;
      const parts: string[] = [];
      if (hiddenLines > 0) parts.push(`${hiddenLines} more diff line${hiddenLines === 1 ? "" : "s"}`);
      if (hiddenGenerated) parts.push(`${hiddenGenerated} generated file${hiddenGenerated === 1 ? "" : "s"}`);
      if (parts.length) notes.push(theme.fg("muted", `… ${parts.join(", ")} (`) + keyHint("app.tools.expand", "to expand") + theme.fg("muted", ")"));
    } else {
      if (data.omittedFiles) notes.push(theme.fg("muted", `${data.omittedFiles} more changed files not stored`));
      if (data.commands.length > 1) {
        notes.push(theme.fg("dim", `Combined changes from ${data.commands.length} commands that ran at the same time:`));
        for (const command of data.commands) notes.push(theme.fg("dim", `  $ ${firstLine(command)}`));
      }
    }
    if (data.shownElsewhere?.length) {
      notes.push(theme.fg("dim", `Also edited at the same time by Pi's edit tool, with its own diff: ${data.shownElsewhere.join(", ")}`));
    }
    return notes.map(fixed);
  }
}

const blank: Line = () => [""];
const fixed = (line: string): Line => (width) => wrapTextWithAnsi(line, width);

/** Wraps rendered diff lines with a hanging indent so the line-number gutter stays clean. */
function diffLines(raw: string[]): Line[] {
  const rendered = renderDiff(raw.join("\n")).split("\n");
  return rendered.map((line, index) => (width) => {
    const gutter = raw[index]?.match(/^[+\- ]\s*\d*\s/)?.[0].length ?? 0;
    const total = visibleWidth(line);
    if (total <= width || gutter === 0 || gutter >= width - 8) return wrapTextWithAnsi(line, width);
    const body = wrapTextWithAnsi(sliceByColumn(line, gutter, total - gutter), width - gutter);
    return body.map((part, i) => (i === 0 ? sliceByColumn(line, 0, gutter) : " ".repeat(gutter)) + part);
  });
}

function formatStats(added: number, removed: number, theme: Theme): string {
  const parts: string[] = [];
  if (added) parts.push(theme.fg("toolDiffAdded", `+${added}`));
  if (removed) parts.push(theme.fg("toolDiffRemoved", `−${removed}`));
  return parts.join(" ");
}

function rowTail(file: FileChange, maxChanges: number, theme: Theme): string {
  if (file.summary && file.summary !== "sensitive") return theme.fg("muted", file.detail ?? file.summary);
  if (file.status === "renamed" && !file.added && !file.removed) return theme.fg("muted", "moved, content unchanged");
  const stats = formatStats(file.added, file.removed, theme);
  const bar = changeBar(file.added, file.removed, maxChanges, theme);
  const tags: string[] = [];
  if (file.summary === "sensitive") tags.push("contents hidden");
  if (file.generated) tags.push("generated");
  const tagText = tags.length ? `  ${theme.fg("muted", tags.join(" · "))}` : "";
  const statsText = stats ? `${stats}${" ".repeat(Math.max(1, 10 - visibleWidth(stats)))}` : " ".repeat(10);
  return `${statsText}${bar}${tagText}`;
}

/** A five-cell bar, like `git diff --stat`, scaled to the largest file in the card. */
function changeBar(added: number, removed: number, maxChanges: number, theme: Theme): string {
  const cells = 5;
  const total = added + removed;
  if (!total) return theme.fg("borderMuted", "·····");
  // Small edits get one cell per line, as in `git diff --stat`; larger ones scale.
  const filled = Math.max(1, Math.round((total / Math.max(maxChanges, cells)) * cells));
  const green = Math.round((added / total) * filled);
  const red = filled - green;
  return theme.fg("toolDiffAdded", "■".repeat(green)) + theme.fg("toolDiffRemoved", "■".repeat(red)) +
    theme.fg("borderMuted", "·".repeat(cells - filled));
}

function sourceLabel(data: EditCardData): string {
  if (data.commands.length > 1) return `${data.commands.length} parallel commands`;
  const command = data.commands[0] ?? "";
  return `$ ${firstLine(command)}`;
}

function firstLine(command: string): string {
  const [first, ...rest] = command.trim().split("\n");
  return rest.length ? `${first} …` : first ?? "";
}

/** Makes a path clickable in terminals that support OSC 8 links, as Pi does for tool paths. */
function linked(styled: string, file: FileChange, cwd: string | undefined): string {
  if (!cwd || file.status === "deleted" || !getCapabilities().hyperlinks) return styled;
  const absolute = file.path.startsWith("~/") ? join(homedir(), file.path.slice(2))
    : isAbsolute(file.path) ? file.path : resolve(cwd, file.path);
  return hyperlink(styled, pathToFileURL(absolute).href);
}

/** Clips plain text to `width` cells with an ellipsis, without the style resets truncateToWidth adds. */
function clip(text: string, width: number): string {
  if (visibleWidth(text) <= width) return text;
  let out = "";
  for (const char of text) {
    if (visibleWidth(out + char) > width - 1) break;
    out += char;
  }
  return `${out}…`;
}

function plainPath(file: FileChange): string {
  return file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
}

function styledPath(path: string, theme: Theme): string {
  const slash = path.lastIndexOf("/");
  if (slash < 0) return theme.fg("accent", path);
  return theme.fg("muted", path.slice(0, slash + 1)) + theme.fg("accent", path.slice(slash + 1));
}

/** Fits a path into `width`, eliding leading directories before the file name. */
function fitPath(file: FileChange, width: number, theme: Theme): string {
  const full = plainPath(file);
  if (visibleWidth(full) <= width) {
    return file.oldPath
      ? `${styledPath(file.oldPath, theme)}${theme.fg("muted", " → ")}${styledPath(file.path, theme)}`
      : styledPath(file.path, theme);
  }
  const tail = full.slice(Math.max(0, full.length - (width - 1)));
  return theme.fg("muted", "…") + theme.fg("accent", tail);
}
