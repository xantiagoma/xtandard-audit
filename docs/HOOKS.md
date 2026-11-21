# Hooks

Control-plane extensibility around audit mutations, plus the fire-and-forget record tap. Hooks are plain JavaScript wired in at construction time (on the core, or the panel's `hooks` option) — never authored through the UI (that would be remote code execution).

## The two phases

|         | `before`                                 | `after`                                                 |
| ------- | ---------------------------------------- | ------------------------------------------------------- |
| Runs    | before a mutation commits                | after it commits                                        |
| Order   | sequentially, declared order             | concurrently                                            |
| Failure | **throw = deny**; nothing commits        | isolated; reported to `onHookError`, never fails the op |
| Use for | quotas, export approvals, erasure policy | notifications, archiving pruned events, cache busting   |

```ts
import { createAuditCore, HookDeniedError } from "@xtandard/audit";

const audit = createAuditCore({
  storage,
  hooks: {
    before(event) {
      if (event.type === "event.record" && overQuota(event.tenant, event.count)) {
        throw new HookDeniedError("Monthly audit quota exceeded.", { status: 429 });
      }
      if (event.type === "event.erase" && !event.reason) {
        throw new HookDeniedError("Erasures need a reason.", { status: 422 });
      }
    },
    async after(event) {
      if (event.type === "events.pruned") {
        await archive.notify(
          `${event.tenant}: pruned ${event.count} through seq ${event.throughSeq}`,
        );
      }
    },
  },
});
```

`HookDeniedError` maps to its `status` (default 403) at the API layer — detected by name, so a copy of the class from another bundle still maps correctly; any other thrown error maps to 500 (treated as a bug, not a policy).

## Event catalog

`before` (veto points) — every control-plane one carries `actor` (the authenticated principal, `null` from code):

| Type                | When                                               | Payload                                    |
| ------------------- | -------------------------------------------------- | ------------------------------------------ |
| `event.record`      | once per `record`/`recordMany` call **per tenant** | `tenant`, `actions`, `count` (no actor)    |
| `event.erase`       | `erase()` / `POST …/events/:id/erase`              | `tenant`, `eventId`, `sections`, `reason?` |
| `events.export`     | every export (API, CLI, `exportEvents`)            | `tenant`, `query`, `format`                |
| `events.prune`      | retention is about to remove a prefix              | `tenant`, `throughSeq`                     |
| `checkpoint.create` | manual or automatic checkpoint                     | `tenant`                                   |
| `action.upsert`     | catalog edit                                       | `action`                                   |
| `action.delete`     | catalog delete                                     | `name`                                     |

`after` (committed state): `events.recorded` (the sealed events), `event.erased` (the erased event + sections), `events.exported`, `events.pruned` (count, through seq, and the signed `base` checkpoint anchoring what remains), `checkpoint.created`, `action.upserted`, `action.deleted`.

Self-audit is separate from hooks: exports, erasures and prunes are also **recorded into the affected tenant's own log** (`audit_log.exported`, `audit_log.erased`, `audit_log.pruned`, catalog changes into the `_system` tenant), so customers see them in their portal. Internal self-audit records do not fire `event.record`.

## The record tap (`onRecord`)

`record()` is the hot path, so besides the `event.record` / `events.recorded` hook pair there is a cheaper per-batch tap:

```ts
createAuditCore({
  storage,
  onRecord(events) {
    metrics.increment("audit_events", events.length);
  },
});
```

Never awaited, errors are logged and swallowed — a broken tap cannot fail a record. For delivering events to SIEMs and archives use **streams** (they read the log, with cursors and retries — ADR 0008), not hooks.

## Bundled hooks

- `@xtandard/audit/hooks/log` — `createLogHook()`: logs each event, the reference implementation to copy.

That's the whole catalog on purpose (anti-bloat): anything else is ten lines against the seam above.
