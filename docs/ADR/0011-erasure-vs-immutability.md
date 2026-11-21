# ADR 0011 — Erasure vs Immutability: Redact Sections, Keep Digests

**Status:** Accepted (★ new)

---

## Context

An immutable, hash-chained log collides with the right to erasure (GDPR art. 17) and with secrets
accidentally logged in metadata: deleting or editing an event breaks the chain from that point.

## Decision

Because the chain commits to **section digests** rather than raw section content (ADR 0004),
`core.erase(tenant, eventId, { sections, reason })` replaces the content of the named sections
(`actor`, `targets`, `context`, `metadata`, `description`) with an erasure marker
(`{ "$erased": true }`, actor keeps a stable pseudonymous `id: "erased:<digest prefix>"`), records the
names in `integrity.erased`, and **keeps the original digests**. Verification uses the stored digest
for erased sections and recomputes the others, so the chain still verifies and the erasure itself is
visible. The erasure is recorded as an `audit_log.erased` event (actor = operator, metadata = event
id, sections, reason) in the same tenant log. `before`/`after` hooks fire (`event.erase`).

Bulk: `core.eraseActor(tenant, actorId)` erases every section mentioning that actor.

## Consequences

- Personal data can be removed without breaking tamper evidence; the fact of erasure is auditable.
- A digest of low-entropy content (an email) could be brute-forced; digests are therefore salted
  with the event id (`SHA-256(id + "\n" + canonical(section))`). Documented in docs/INTEGRITY.md.
