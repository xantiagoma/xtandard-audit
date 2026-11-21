# Testing

Both what this package ships for testing _your_ audit wiring and how this repository is tested.

## Testing your app: `@xtandard/audit/testing`

```ts
import { createTestAudit, expectRecorded, expectNotRecorded } from "@xtandard/audit/testing";
import { test, expect } from "bun:test"; // or vitest

test("promoting a member is audited", async () => {
  const { core, sink, flush } = createTestAudit({ actions }); // your defineActions(...) map

  await promote(core, { org: "acme", by: "u_1", member: "u_2" }); // your code, calling core.record(...)

  await expectRecorded(core, {
    tenant: "acme",
    action: "member.role_changed",
    actor: { id: "u_1" },
    targets: [{ type: "user", id: "u_2" }],
    metadata: { to: "admin" },
  });
  await expectNotRecorded(core, { tenant: "acme", action: "member.removed" });

  await flush(); // drive the stream runner once
  expect(sink.events().map((e) => e.action)).toContain("member.role_changed");
  expect((await core.verify("acme")).ok).toBe(true);
});
```

- `createTestAudit(options)` — an in-memory core (every `createAuditCore` option is accepted), a
  `collectingSink` behind a **not started** stream runner (no timers: call `flush()`), an optional
  panel (`panel: true` or panel options) for HTTP-level tests via `panel.fetch(new Request(…))`.
- `collectingSink()` — keeps every batch; `events()` / `checkpoints()` flatten them; `failNext(n)`
  rejects the next sends to exercise the stream retry path.
- `expectRecorded(core, matcher)` / `expectNotRecorded(core, matcher)` — deep-subset assertions that
  throw a descriptive `Error` listing what was recorded instead; they work with any test runner.
- Deterministic time: pass `now: () => fakeMillis` to the core; for background work (automatic
  checkpoints) `await core.settled()` instead of sleeping.

## How this repo is tested

| Layer               | Where                                            | Notes                                                                                        |
| ------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| unit + integration  | `test/*.test.ts` via `vp test run` (vitest)      | flat dir; `retry: 2` absorbs live-backend scheduling flakes                                  |
| Bun-runtime-only    | `test/*.bun.test.ts` via `bun test`              | `bun:sqlite`, libSQL (bun:sqlite-backed fake), CLI `serve`, native SHA-256 parity            |
| storage conformance | `test/storage-contract.ts`                       | one battery, every adapter: KV contract, event log through the core, native append semantics |
| live backends       | env-gated: `REDIS_URL`, `MONGO_URL`, `MYSQL_URL` | Postgres always runs on PGlite; CI runs Redis, Mongo, Postgres and MySQL service containers  |
| type tests          | `@ts-expect-error` in tests for typed actions    | action names and metadata shapes are compile errors when wrong                               |
| browser e2e         | `e2e/` via Playwright                            | the bundled SPA, the portal chrome and the React embeds against a seeded panel               |
| coverage            | `vp test run --coverage`, thresholds 92/85/90/92 | enforced in CI                                                                               |

Conventions worth copying (shared with the sibling packages):

- **Injectable clock** — the core takes `now`; tests set time instead of sleeping (retention ages,
  checkpoint intervals).
- **Tamper tests** — integrity tests edit stored events behind the core's back (`eventLog.replaceEvent`,
  edited bundle text) and assert the exact `issues[].kind`.
- **No timer assertions** — streams are driven with `tick()`, the recorder with `flush()`;
  `start()`/`stop()` get one smoke test each.
- **UI logic policy** — pure functions in `src/ui/lib/*` are unit-tested; everything visual goes
  through Playwright.

Local gate (also the pre-push hook): `bun run check && bun run test && bun run test:bun`.
