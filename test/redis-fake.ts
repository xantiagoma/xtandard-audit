/**
 * A Map-backed stand-in for a node-redis client — enough of the surface the
 * redis adapters use (strings, RedisJSON, SCAN, the compare-and-swap `EVAL`)
 * to run the adapters and the storage conformance suite without a server.
 *
 * `eval` emulates the adapter's CAS script (it does not run Lua): it decides
 * string vs RedisJSON from the script text and compares values structurally,
 * like the script does. The live suites cover the real Lua.
 *
 * Not a `.test.ts` file: imported by the redis test files only.
 */

import { vi } from "vitest";

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) =>
    deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

/** Translate a Redis glob (with `\` escapes) into an anchored RegExp. */
function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === "\\" && i + 1 < glob.length) {
      re += glob[++i]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    } else if (ch === "*") re += ".*";
    else if (ch === "?") re += ".";
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export function fakeRedisClient(options: { json?: boolean; batchScan?: boolean } = {}) {
  const strings = new Map<string, string>();
  const docs = new Map<string, unknown>();
  const evalCalls: Array<{ script: string; keys: string[]; arguments: string[] }> = [];
  const client: Record<string, unknown> = {
    isOpen: true,
    on: () => client,
    connect: async () => client,
    quit: async () => undefined,
    get: async (key: string) => strings.get(key) ?? null,
    set: async (key: string, value: string) => {
      strings.set(key, value);
    },
    del: async (key: string) => {
      strings.delete(key);
      docs.delete(key);
    },
    eval: async (script: string, opts: { keys: string[]; arguments: string[] }) => {
      evalCalls.push({ script, ...opts });
      const [key] = opts.keys;
      const [expectNull, expected, next] = opts.arguments;
      const isJson = script.includes("JSON.GET");
      const current = isJson
        ? docs.has(key!)
          ? docs.get(key!)
          : null
        : strings.has(key!)
          ? JSON.parse(strings.get(key!)!)
          : null;
      if (expectNull === "1" ? current !== null : !deepEqual(current, JSON.parse(expected!))) {
        return 0;
      }
      if (isJson) docs.set(key!, JSON.parse(next!));
      else strings.set(key!, next!);
      return 1;
    },
    scanIterator: async function* (opts?: { MATCH?: string }) {
      const re = globToRegExp(opts?.MATCH ?? "*");
      const keys = [...strings.keys(), ...docs.keys()].filter((k) => re.test(k));
      if (options.batchScan) yield keys;
      else for (const k of keys) yield k;
    },
    duplicate: () => client,
    pSubscribe: async () => undefined,
    disconnect: async () => undefined,
  };
  if (options.json !== false) {
    client.json = {
      get: vi.fn(async (key: string) => (docs.has(key) ? structuredClone(docs.get(key)) : null)),
      set: vi.fn(async (key: string, _path: string, value: unknown) => {
        docs.set(key, structuredClone(value));
      }),
    };
  }
  return { client: client as never, strings, docs, evalCalls };
}
