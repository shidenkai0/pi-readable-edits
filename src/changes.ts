import { homedir } from "node:os";
import { basename, relative, sep } from "node:path";
import { generateDiffString } from "@earendil-works/pi-coding-agent";
import { diffLines } from "diff";

/** One side of a changed path, as captured before or after a command. */
export type Side =
  | { kind: "absent" }
  | { kind: "text"; text: string }
  | { kind: "binary"; size: number; hash?: string }
  | { kind: "large"; size: number }
  | { kind: "link"; target: string };

export interface RawChange {
  /** Absolute path after the command. */
  path: string;
  /** Absolute path before the command, for renames. */
  oldPath?: string;
  before: Side;
  after: Side;
}

export type FileStatus = "added" | "modified" | "deleted" | "renamed";

/**
 * What a card shows for one file. `diff` uses Pi's own display format
 * (`+12 text`), so bash edits render exactly like the built-in edit tool.
 */
export interface FileChange {
  path: string;
  oldPath?: string;
  status: FileStatus;
  added: number;
  removed: number;
  /** Why the body is summarized instead of shown as a diff. */
  summary?: "binary" | "large" | "rewrite" | "sensitive" | "link" | "eol";
  /** Presentation hint: lockfiles and generated files collapse even when expanded is off. */
  generated?: boolean;
  detail?: string;
  diff?: string;
  /** Diff lines dropped to keep the session file small. */
  omittedLines?: number;
}

export const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_FILES = 60;
const MAX_LINES_PER_FILE = 600;
const MAX_LINES_PER_CARD = 2400;
/**
 * Myers diff is O((N+M)·D): a heavily rewritten large file can take minutes.
 * Past these bounds the file is summarized as rewritten instead.
 */
const MAX_EDIT_LENGTH = 5000;
const DIFF_TIMEOUT_MS = 400;

const SENSITIVE = [
  /^\.env(\..*)?$/i, /\.(pem|key|p12|pfx|jks|keystore|asc|gpg)$/i, /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^\.(netrc|pgpass|npmrc|pypirc|htpasswd)$/i, /^credentials(\.\w+)?$/i, /^secrets?(\.\w+)?$/i,
  /\.(tfstate|tfvars)$/i, /^\.dev\.vars$/i, /^service[-_]?account.*\.json$/i,
];
const LOCKFILES = new Set([
  "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock", "Cargo.lock",
  "Gemfile.lock", "poetry.lock", "uv.lock", "Pipfile.lock", "composer.lock", "go.sum", "flake.lock", "Package.resolved",
  "pubspec.lock", "mix.lock", "deno.lock", "packages.lock.json", "gradle.lockfile",
]);

export function isSensitive(path: string): boolean {
  const name = basename(path);
  return SENSITIVE.some((pattern) => pattern.test(name));
}

export function isGeneratedName(path: string): boolean {
  const name = basename(path);
  return LOCKFILES.has(name) || /\.min\.(js|css)$/.test(name) || /\.(js|css)\.map$/.test(name);
}

/** Decodes a blob as display text, or reports it as binary. */
export function decode(bytes: Buffer): Side {
  const probe = bytes.subarray(0, 8000);
  if (probe.includes(0)) return { kind: "binary", size: bytes.length };
  try {
    return { kind: "text", text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { kind: "binary", size: bytes.length };
  }
}

/** Relative to the session directory when close to it (siblings included), otherwise from `~`. */
export function displayPath(path: string, cwd: string): string {
  const rel = relative(cwd, path);
  const ups = rel.split(sep).filter((part) => part === "..").length;
  if (ups <= 1) return (rel || ".").split(sep).join("/");
  const home = homedir();
  return (path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path).split(sep).join("/");
}

function statusOf(change: RawChange): FileStatus {
  if (change.oldPath && change.oldPath !== change.path) return "renamed";
  if (change.before.kind === "absent") return "added";
  if (change.after.kind === "absent") return "deleted";
  return "modified";
}

const text = (side: Side) => (side.kind === "text" ? side.text : side.kind === "absent" ? "" : undefined);
const lf = (value: string) => value.replace(/\r\n/g, "\n");

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function sizeOf(side: Side): number | undefined {
  if (side.kind === "text") return Buffer.byteLength(side.text);
  if (side.kind === "binary" || side.kind === "large") return side.size;
  return side.kind === "absent" ? 0 : undefined;
}

function describeSizes(before: Side, after: Side): string | undefined {
  const a = sizeOf(before), b = sizeOf(after);
  if (a === undefined || b === undefined) return undefined;
  if (before.kind === "absent") return formatSize(b);
  if (after.kind === "absent") return formatSize(a);
  return `${formatSize(a)} → ${formatSize(b)}`;
}

function countLines(value: string): number {
  if (!value) return 0;
  return value.split("\n").length - (value.endsWith("\n") ? 1 : 0);
}

/**
 * Converts captured before/after pairs into display-ready file changes.
 * Every returned entry changed; identical pairs are dropped.
 */
export function describeChanges(raw: RawChange[], cwd: string): { files: FileChange[]; omittedFiles: number } {
  const files: FileChange[] = [];
  let budget = MAX_LINES_PER_CARD;
  const ordered = [...raw].sort((a, b) => a.path.localeCompare(b.path));
  for (const change of ordered) {
    const file = describe(change, cwd);
    if (!file) continue;
    if (file.diff) {
      const lines = file.diff.split("\n");
      const keep = Math.max(0, Math.min(lines.length, MAX_LINES_PER_FILE, budget));
      if (keep < lines.length) {
        file.omittedLines = lines.length - keep;
        file.diff = keep ? lines.slice(0, keep).join("\n") : undefined;
      }
      budget -= keep;
    }
    files.push(file);
  }
  return { files: files.slice(0, MAX_FILES), omittedFiles: Math.max(0, files.length - MAX_FILES) };
}

function describe(change: RawChange, cwd: string): FileChange | undefined {
  const base: FileChange = {
    path: displayPath(change.path, cwd),
    ...(change.oldPath && change.oldPath !== change.path ? { oldPath: displayPath(change.oldPath, cwd) } : {}),
    status: statusOf(change),
    added: 0,
    removed: 0,
    ...(isGeneratedName(change.path) ? { generated: true } : {}),
  };
  const { before, after } = change;

  if (before.kind === "link" || after.kind === "link") {
    const from = before.kind === "link" ? before.target : undefined;
    const to = after.kind === "link" ? after.target : undefined;
    if (from === to && !base.oldPath) return undefined;
    return { ...base, summary: "link", detail: from && to ? `symlink ${from} → ${to}` : `symlink → ${to ?? from}` };
  }

  const beforeText = text(before), afterText = text(after);
  if (beforeText === undefined || afterText === undefined) {
    const summary = before.kind === "large" || after.kind === "large" ? "large" : "binary";
    return { ...base, summary, detail: [summary === "large" ? "large file" : "binary", describeSizes(before, after)]
      .filter(Boolean).join(" · ") };
  }
  if (beforeText === afterText) return base.oldPath ? base : undefined; // A pure rename, or nothing.
  const oldText = lf(beforeText), newText = lf(afterText);
  if (oldText === newText) {
    return { ...base, summary: "eol", detail: beforeText.includes("\r\n") ? "line endings CRLF → LF" : "line endings LF → CRLF" };
  }
  if (before.kind === "absent" && !newText) return { ...base, detail: "empty file" };
  const stats = lineStats(oldText, newText);
  if (!stats) {
    const lines = `${countLines(oldText)} → ${countLines(newText)} lines`;
    return { ...base, summary: "rewrite", detail: `rewritten, too many changes to diff · ${lines}` };
  }
  const { added, removed } = stats;
  // Counts only: the session file must not become a copy of a secret.
  if (isSensitive(change.path)) return { ...base, added, removed, summary: "sensitive", detail: "contents hidden" };
  // The bounded pass above guarantees this one finishes in similar time.
  return { ...base, added, removed, diff: generateDiffString(oldText, newText, 3).diff };
}

/** Line counts, or undefined when the diff is too expensive to compute. */
function lineStats(oldText: string, newText: string): { added: number; removed: number } | undefined {
  if (!oldText) return { added: countLines(newText), removed: 0 };
  if (!newText) return { added: 0, removed: countLines(oldText) };
  const parts = diffLines(oldText, newText, { maxEditLength: MAX_EDIT_LENGTH, timeout: DIFF_TIMEOUT_MS });
  if (!parts) return undefined;
  let added = 0, removed = 0;
  for (const part of parts) {
    if (part.added) added += part.count ?? 0;
    else if (part.removed) removed += part.count ?? 0;
  }
  return { added, removed };
}
