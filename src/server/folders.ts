import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { FolderListing } from "../shared/protocol.ts";

/** A typed path as a full path. `~` and relative paths start at the home folder, and an empty path is the home folder. */
export function toPath(input: string): string {
  return resolve(homedir(), input.trim().replace(/^~(?=$|\/)/, homedir()));
}

/** Subfolders of `path`, or of the home folder when `path` is empty. Hidden folders are left out. */
export async function listFolders(path: string): Promise<FolderListing> {
  const dir = toPath(path);
  // A path that the user is still typing usually does not exist. Show an empty list for it.
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return {
    path: dir,
    parent: dirname(dir),
    folders: entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => ({ name: entry.name, path: join(dir, entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}
