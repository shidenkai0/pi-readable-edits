import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { createTwoFilesPatch } from "diff";

const MAX_FILE_BYTES = 256 * 1024;
const MAX_FILES = 128;
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface DiffEntry {
  path: string;
  patch: string;
}

type Snapshot = { path: string; before: string | null };

async function insideRoot(path: string, root: string): Promise<boolean> {
  let parent = dirname(path);
  while (true) {
    try {
      const real = await realpath(parent);
      const rel = relative(root, real);
      return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === dirname(parent)) return false;
      parent = dirname(parent);
    }
  }
}

async function textFile(path: string): Promise<string | null | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return undefined;
    const bytes = await readFile(path);
    if (bytes.includes(0) || bytes.length > MAX_FILE_BYTES) return undefined;
    return decoder.decode(bytes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return undefined;
  }
}

/** Missing files are preserved as null, so creation and deletion have accurate before/after states. */
export async function capture(paths: string[], root: string): Promise<Snapshot[]> {
  const canonicalRoot = await realpath(root);
  const result: Snapshot[] = [];
  for (const path of paths.slice(0, MAX_FILES)) {
    if (!(await insideRoot(path, canonicalRoot))) continue;
    const before = await textFile(path);
    if (before !== undefined) result.push({ path, before });
  }
  return result;
}

export async function compare(snapshots: Snapshot[], root: string): Promise<DiffEntry[]> {
  const canonicalRoot = await realpath(root);
  const result: DiffEntry[] = [];
  for (const { path, before } of snapshots) {
    if (!(await insideRoot(path, canonicalRoot))) continue;
    const after = await textFile(path);
    if (after === undefined || before === after) continue;
    const name = relative(resolve(root), path);
    result.push({
      path: name,
      patch: createTwoFilesPatch(`a/${name}`, `b/${name}`, before ?? "", after ?? "", "", "", { context: 3 }),
    });
  }
  return result;
}
