/**
 * Adapter that wraps an [unstorage](https://unstorage.unjs.io) `Storage`
 * instance as a {@link AuditStorage}. The caller constructs and configures
 * their own unstorage instance (with whatever driver they like) and passes it in
 * — we never import `unstorage` at runtime, only its type. `unstorage` therefore
 * remains an optional peer dependency.
 *
 * unstorage normalizes key separators to `:` internally. We write `/`-style keys
 * (which unstorage accepts), but its `getKeys(base)` returns `:`-separated keys.
 * This adapter converts those back to `/` so callers always see the keys they
 * wrote.
 *
 * unstorage's key normalization is lossy (it cuts at `?`, turns `\` and `/`
 * into `:`, collapses repeated `:` and hides keys ending in `$`), so the
 * `@xtandard/kit/storage/unstorage` driver escapes `%`, `?`, `\`, `:`, a
 * trailing `$` and empty segments before handing keys over and reverses it on
 * the way back: every key round-trips exactly, and keys written by earlier
 * releases still read. Strings are written JSON-encoded, so a stored `"123"`
 * reads back as the string, not the number.
 *
 * KV only: events go through the core's generic KV event log (ADR 0005), and
 * unstorage has no compare-and-swap, so the core assumes a **single writer per
 * tenant**. Note that filesystem-backed unstorage drivers inherit their
 * filesystem's case sensitivity; prefer `storage/file`, which encodes case.
 *
 * @module
 */

export {
  createUnstorageStorage,
  type UnstorageStorageOptions,
} from "@xtandard/kit/storage/unstorage";
