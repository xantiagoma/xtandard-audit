/**
 * File-system storage adapter. Persists each key as a JSON file under a base
 * directory, mirroring the slash-delimited key layout (`aud/t/{tenant}/…`) as a
 * tree of nested directories with a `.json` extension on the leaf. Zero
 * external dependencies — uses `node:fs/promises`, which works in both Bun and
 * Node.
 *
 * KV only: events go through the core's generic KV event log (ADR 0005), one
 * file per event plus one per index entry. Fine for development, demos and
 * small single-process deployments; there is no compare-and-swap, so the core
 * assumes a **single writer per tenant** (one process). Writes go to a temp file
 * that is then renamed over the target, so a concurrent reader never sees a
 * half-written value.
 *
 * @module
 */

import { existsSync, watch as fsWatch } from "node:fs";
import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import type { StorageChangeEvent, WatchableAuditStorage } from "./contract.ts";

/** Options for {@link createFileStorage}. */
export interface FileStorageOptions {
  /** Base directory under which key files are written. Created on demand. */
  dir: string;
}

/** Suffix appended to the leaf file for every stored key. */
const JSON_SUFFIX = ".json";

/**
 * Map a storage key (e.g. `aud/t/acme/head`) to an absolute file path inside
 * `dir`. Each key segment becomes a directory; the last segment gains a
 * `.json` extension.
 */
function keyToPath(dir: string, key: string): string {
  return join(dir, ...key.split("/")) + JSON_SUFFIX;
}

/**
 * Reverse {@link keyToPath}: turn an absolute (or `dir`-relative) file path back
 * into the original slash-delimited storage key. Returns `null` for paths that
 * are not `.json` leaves under `dir` (including in-flight temp files).
 */
function pathToKey(dir: string, filePath: string): string | null {
  const rel = relative(dir, filePath);
  if (rel.startsWith("..") || !rel.endsWith(JSON_SUFFIX)) return null;
  return rel.slice(0, -JSON_SUFFIX.length).split(sep).join("/");
}

/** Recursively collect every `.json` leaf file path under `root`. */
async function walk(root: string): Promise<string[]> {
  const out: string[] = [];
  let entries: Dirent[];
  try {
    entries = (await readdir(root, { withFileTypes: true })) as Dirent[];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return out;
    throw err;
  }
  for (const entry of entries) {
    const name = entry.name.toString();
    const full = join(root, name);
    if (entry.isDirectory()) {
      out.push(...(await walk(full)));
    } else if (entry.isFile() && name.endsWith(JSON_SUFFIX)) {
      out.push(full);
    }
  }
  return out;
}

let tmpCounter = 0;

/**
 * Create a file-backed {@link WatchableAuditStorage}. Values are serialized
 * as pretty-printed JSON. `watch` is implemented via `fs.watch` on the base
 * directory (recursive); it is best-effort and may coalesce or miss events on
 * platforms without recursive-watch support.
 *
 * @example
 * ```ts
 * import { createFileStorage } from "@xtandard/audit/storage/file";
 *
 * const storage = createFileStorage({ dir: "./data/audit" });
 * ```
 */
export function createFileStorage(options: FileStorageOptions): WatchableAuditStorage {
  const { dir } = options;

  return {
    async getItem<T>(key: string): Promise<T | null> {
      try {
        const raw = await readFile(keyToPath(dir, key), "utf8");
        return JSON.parse(raw) as T;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    },

    async setItem<T>(key: string, value: T): Promise<void> {
      const path = keyToPath(dir, key);
      await mkdir(dirname(path), { recursive: true });
      // Write-then-rename: rename is atomic within a filesystem, so readers see
      // either the old or the new value, never a truncated file.
      const tmp = `${path}.${process.pid}.${tmpCounter++}.tmp`;
      await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
      await rename(tmp, path);
    },

    async removeItem(key: string): Promise<void> {
      try {
        await unlink(keyToPath(dir, key));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    },

    async getKeys(prefix: string): Promise<string[]> {
      const files = await walk(dir);
      const out: string[] = [];
      for (const file of files) {
        const key = pathToKey(dir, file);
        if (key !== null && key.startsWith(prefix)) out.push(key);
      }
      return out;
    },

    async watch(
      prefix: string,
      callback: (event: StorageChangeEvent) => void,
    ): Promise<() => void> {
      // Ensure the watched root exists so fs.watch does not throw on a fresh dir.
      await mkdir(dir, { recursive: true });
      const watcher = fsWatch(dir, { recursive: true }, (eventType, filename) => {
        if (!filename) return;
        const path = join(dir, filename.toString());
        const key = pathToKey(dir, path);
        if (key === null || !key.startsWith(prefix)) return;
        // `rename` covers creation (incl. our temp-file rename), replacement and
        // deletion; the file's presence tells them apart.
        const type: StorageChangeEvent["type"] =
          eventType === "rename" && !existsSync(path) ? "remove" : "update";
        callback({ type, key });
      });
      return () => watcher.close();
    },
  } satisfies WatchableAuditStorage;
}

/**
 * Delete every file written by a {@link createFileStorage} instance by removing
 * its base directory. Exposed primarily for tests and cleanup tooling.
 */
export async function clearFileStorage(options: FileStorageOptions): Promise<void> {
  await rm(options.dir, { recursive: true, force: true });
}
