/**
 * Standard Webhooks sink: `webhookSink()` POSTs signed batches (or items),
 * verifiable by `@xtandard/webhooks/receiver`, Svix and the official
 * `standardwebhooks` libraries. Zero dependencies.
 *
 * Import from `@xtandard/audit/sinks/webhook`.
 *
 * @module sinks/webhook
 */

export * from "./sinks/webhook.ts";
