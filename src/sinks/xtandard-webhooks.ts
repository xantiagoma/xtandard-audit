/**
 * The `@xtandard/webhooks` bridge (ADR 0008 §6): publishes every streamed
 * event and checkpoint into a webhooks core, so each tenant can **self-serve**
 * its own SIEM / archive endpoints — in the webhooks portal, with per-endpoint
 * retries, dead-letters, replay and signing — instead of this package
 * rebuilding all of that.
 *
 * Typed structurally: there is **no dependency** on `@xtandard/webhooks`; any
 * object with a compatible `publish(applicationKey, { eventType, payload,
 * timestamp, idempotencyKey })` works.
 *
 * @module
 */

import type { JsonValue } from "../schema.ts";
import type { AuditSink, StreamItem } from "../streams.ts";
import { defaultItemType, itemId, itemTime } from "./shared.ts";

/** The slice of an `@xtandard/webhooks` core this sink calls. */
export interface WebhooksPublisher {
  publish(
    applicationKey: string,
    input: {
      eventType: string;
      payload: JsonValue;
      timestamp?: string;
      idempotencyKey?: string;
    },
  ): Promise<unknown>;
}

/** Options for {@link xtandardWebhooksSink}. */
export interface XtandardWebhooksSinkOptions {
  /**
   * The webhooks application that receives a tenant's items, or `null` to
   * skip the tenant (e.g. it has not enabled streaming). Default: the tenant
   * key itself. The application must exist — `publish` into a missing one
   * throws and the stream backs off.
   */
  applicationKey?: (tenant: string) => string | null | Promise<string | null>;
  /** Event type per item. Default `audit.<action>` for events, `audit.checkpoint` for checkpoints. */
  eventType?: (item: StreamItem) => string;
  /** Message payload per item. Default: the full event / checkpoint (with its integrity block). */
  payload?: (item: StreamItem) => JsonValue;
}

/**
 * Create a sink that publishes into an `@xtandard/webhooks` core.
 *
 * Each item becomes one message with `idempotencyKey` = the event /
 * checkpoint id, so a re-sent batch is deduplicated by the webhooks core
 * (within its retention). A re-publish whose payload changed since (an event
 * erased under ADR 0011) is treated as already delivered — the endpoint got
 * the original, and the erasure is itself an audit event.
 *
 * With `requireKnownEventTypes`, register the event types first
 * (`audit.<action>` for each action you stream, plus `audit.checkpoint`).
 *
 * @example
 * ```ts
 * import { createWebhooksCore } from "@xtandard/webhooks";
 * import { createStreamRunner } from "@xtandard/audit";
 * import { xtandardWebhooksSink } from "@xtandard/audit/sinks/xtandard-webhooks";
 *
 * const webhooks = createWebhooksCore({ storage: webhooksStorage });
 *
 * createStreamRunner(audit, {
 *   streams: [
 *     {
 *       name: "tenant-webhooks",
 *       sink: xtandardWebhooksSink(webhooks, {
 *         // one webhooks application per audit tenant
 *         applicationKey: (tenant) => `org_${tenant}`,
 *       }),
 *     },
 *   ],
 * }).start();
 * ```
 */
export function xtandardWebhooksSink(
  webhooks: WebhooksPublisher,
  options: XtandardWebhooksSinkOptions = {},
): AuditSink {
  const appFor = options.applicationKey ?? ((tenant: string) => tenant);
  const eventType = options.eventType ?? defaultItemType;
  const payloadOf =
    options.payload ??
    ((item: StreamItem) =>
      (item.kind === "event" ? item.event : item.checkpoint) as unknown as JsonValue);

  return {
    kind: "xtandard-webhooks",
    async send(batch) {
      if (batch.items.length === 0) return;
      const app = await appFor(batch.tenant);
      if (app === null) return;
      for (const item of batch.items) {
        try {
          await webhooks.publish(app, {
            eventType: eventType(item),
            payload: payloadOf(item),
            timestamp: itemTime(item),
            idempotencyKey: itemId(item),
          });
        } catch (err) {
          // Already published with different content (erased since): delivered.
          if (err instanceof Error && err.name === "IdempotencyConflictError") continue;
          throw err;
        }
      }
    },
  };
}
