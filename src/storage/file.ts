/**
 * File-system storage adapter. Persists each key as a JSON file under a base
 * directory, mirroring the slash-delimited key layout (`aud/t/{tenant}/…`) as a
 * tree of nested directories with a `.json` extension on the leaf. Each key
 * segment is encoded into a case-safe file name ({@link encodeSegment}), so
 * tenants `Acme` and `acme` stay distinct on case-insensitive filesystems
 * (macOS and Windows defaults). Zero external dependencies — uses
 * `node:fs/promises`, which works in both Bun and Node.
 *
 * The driver is `@xtandard/kit/storage/file`: writes go to a temp file that is
 * then renamed over the target (a concurrent reader never sees a half-written
 * value), `compareAndSwap` is serialized per key within one process, and empty
 * key segments are distinct keys.
 *
 * Events go through the core's generic KV event log (ADR 0005), one file per
 * event plus one per index entry. Fine for development, demos and small
 * single-process deployments; `compareAndSwap` is per process, so the core
 * still assumes a **single writer per tenant** (one process).
 *
 * @module
 */

import * as kit from "@xtandard/kit/storage/file";

export {
  clearFileStorage,
  decodeSegment,
  encodeSegment,
  migrateFileStorage,
  type FileLegacyMode,
} from "@xtandard/kit/storage/file";

/** Options for {@link createFileStorage}: the base `dir`, created on demand. */
export type FileStorageOptions = kit.FileStorageOptions;

/** A watchable, compare-and-swap capable file-backed storage. */
export type FileAuditStorage = kit.FileKvStorage;

/**
 * Create a file-backed storage. Values are serialized as JSON. `watch` is
 * implemented via `fs.watch` on the base directory (recursive); it is
 * best-effort and may coalesce or miss events on platforms without
 * recursive-watch support.
 *
 * @example
 * ```ts
 * import { createFileStorage } from "@xtandard/audit/storage/file";
 *
 * const storage = createFileStorage({ dir: "./data/audit" });
 * ```
 */
export function createFileStorage(options: FileStorageOptions): FileAuditStorage {
  // Every audit release wrote encoded segment names, so there are no legacy leaves to read.
  return kit.createFileStorage({ legacy: "ignore", ...options });
}
