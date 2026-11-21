# ADR 0012 — Typed Actions via Standard Schema

**Status:** Accepted (★ deviation: siblings validate with valibot only and have no user-typed payloads)

---

## Context

The mission asks for "a typed schema per action and validation". Webhooks has an event-type catalog
with an optional JSON schema for documentation, but payloads are untyped `JsonValue`. Audit hosts
want `audit.record({ action: "invoice.paid", metadata: { invoiceId, amount } })` to be **type-checked
at compile time** and validated at runtime, with whatever validator they already use.

## Decision

1. `defineActions({ "invoice.paid": { metadata: schema, targets: ["invoice"], description } })`
   accepts any **Standard Schema v1** validator (valibot, zod, arktype, effect…) for `metadata`.
   The Standard Schema types are vendored (a few type-only lines; zero runtime dependency).
2. `createAuditCore({ actions })` is generic over the action map: `record()` infers the action
   name union and each action's `metadata` input type; unknown actions are a type error and, with
   `strictActions: true` (default when `actions` is given), a runtime `ValidationError`.
3. Runtime validation runs the schema's `~standard.validate` on the record path (async-capable);
   the validated **output** is what gets stored and hashed.
4. The catalog persisted in storage (for the UI: names, descriptions, groups, target types) is
   synced from `actions` at startup and can be extended from the admin UI with descriptions only —
   schemas live in code (never authored through the UI).
5. Internal input validation (shapes of actor/targets/context, API bodies) stays on valibot, like
   the siblings.

## Consequences

- No validator lock-in; type inference matches the host's validator.
- Untyped mode still works: without `actions`, any `action` string matching the name pattern is
  accepted and metadata is any JSON object.
