import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export function sh(command: string, cwd: string): string {
  return execFileSync("bash", ["-c", command], { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
}

/** A committed repository with the given files. Remove it with `cleanup`. */
export async function repository(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "readable-edits-test-"));
  await writeFiles(root, files);
  sh("git init -q -b main && git -c user.email=t@example.com -c user.name=T add -A && " +
    "git -c user.email=t@example.com -c user.name=T commit -qm init", root);
  return root;
}

export async function directory(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "readable-edits-test-"));
  await writeFiles(root, files);
  return root;
}

export async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
}

export async function cleanup(...paths: string[]): Promise<void> {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
}

/** Pi's global theme instance, which renderers use but the package does not export. */
export async function piTheme(): Promise<import("@earendil-works/pi-coding-agent").Theme> {
  const { initTheme } = await import("@earendil-works/pi-coding-agent");
  const { realpathSync } = await import("node:fs");
  const { fileURLToPath, pathToFileURL } = await import("node:url");
  initTheme("dark", false);
  const entry = realpathSync(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
  return (await import(pathToFileURL(join(dirname(entry), "modes/interactive/theme/theme.js")).href)).theme;
}

/** Strips ANSI styling and the card's one-column padding for assertions about rendered text. */
export function plain(lines: string[]): string[] {
  return lines.map((line) => line
    .replace(/\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;]*m/g, "").replace(/^ /, "").trimEnd());
}
