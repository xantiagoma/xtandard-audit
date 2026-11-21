import { createWebhooksCore } from "@xtandard/webhooks";
import { createMemoryStorage as createWebhooksMemoryStorage } from "@xtandard/webhooks/storage/memory";
import { describe, expect, it } from "vitest";
import { xtandardWebhooksSink, type WebhooksPublisher } from "../src/sinks/xtandard-webhooks.ts";
import { createStreamRunner } from "../src/streams.ts";
import { makeBatch, makeCore } from "./sinks-fixtures.ts";

type Published = Parameters<WebhooksPublisher["publish"]>;

function fakeCore(fail?: (app: string, input: Published[1]) => Error | null) {
  const published: Published[] = [];
  const core: WebhooksPublisher = {
    async publish(app, input) {
      const err = fail?.(app, input);
      if (err) throw err;
      published.push([app, input]);
      return {};
    },
  };
  return { core, published };
}

describe("xtandardWebhooksSink (fake core)", () => {
  it("publishes one message per item with idempotencyKey = item id", async () => {
    const { core, published } = fakeCore();
    const batch = await makeBatch({ count: 2, checkpoint: true });
    await xtandardWebhooksSink(core).send(batch);
    expect(published.map(([app]) => app)).toEqual(["acme", "acme", "acme"]);
    expect(published.map(([, i]) => i.eventType)).toEqual([
      "audit.invoice.paid",
      "audit.member.role_changed",
      "audit.checkpoint",
    ]);
    const ids = batch.items.map((i) => (i.kind === "event" ? i.event.id : i.checkpoint.id));
    expect(published.map(([, i]) => i.idempotencyKey)).toEqual(ids);
    const first = batch.items[0]!;
    expect(published[0]![1].payload).toEqual(first.kind === "event" ? first.event : null);
    expect(published[0]![1].timestamp).toBe(first.kind === "event" ? first.event.occurredAt : "");
  });

  it("maps tenants to applications; null skips the tenant", async () => {
    const { core, published } = fakeCore();
    const sink = xtandardWebhooksSink(core, {
      applicationKey: async (tenant) => (tenant === "acme" ? "org_acme" : null),
      eventType: () => "audit.event",
      payload: (item) => ({ kind: item.kind }),
    });
    await sink.send(await makeBatch({ tenant: "acme", count: 1 }));
    await sink.send(await makeBatch({ tenant: "globex", count: 1 }));
    await sink.send({ stream: "s", tenant: "acme", items: [] });
    expect(published).toEqual([
      [
        "org_acme",
        expect.objectContaining({ eventType: "audit.event", payload: { kind: "event" } }),
      ],
    ]);
  });

  it("treats IdempotencyConflictError as delivered, rethrows anything else", async () => {
    const conflict = Object.assign(new Error("conflict"), { name: "IdempotencyConflictError" });
    const { core, published } = fakeCore((_app, input) =>
      input.eventType === "audit.invoice.paid" ? conflict : null,
    );
    await xtandardWebhooksSink(core).send(await makeBatch({ count: 2 }));
    expect(published).toHaveLength(1);

    const { core: broken } = fakeCore(() => new Error("Application not found"));
    await expect(xtandardWebhooksSink(broken).send(await makeBatch())).rejects.toThrow(
      "Application not found",
    );
  });
});

describe("xtandardWebhooksSink (real @xtandard/webhooks)", () => {
  it("streams into a webhooks core: messages, endpoint deliveries, dedupe on re-send", async () => {
    const webhooks = createWebhooksCore({ storage: createWebhooksMemoryStorage() });
    await webhooks.createApplication({ key: "acme" });
    // requireKnownEventTypes is on by default: register what we stream.
    for (const name of ["audit.user.login", "audit.user.logout", "audit.checkpoint"]) {
      await webhooks.upsertEventType({ name });
    }
    await webhooks.createEndpoint("acme", { url: "https://siem.acme.test/hook" });

    const audit = makeCore();
    const runner = createStreamRunner(audit, {
      streams: [
        { name: "tenant-hooks", sink: xtandardWebhooksSink(webhooks), startFrom: "beginning" },
      ],
    });
    const e1 = await audit.record({ tenant: "acme", action: "user.login", actor: { id: "u1" } });
    const e2 = await audit.record({ tenant: "acme", action: "user.logout", actor: { id: "u1" } });
    const cp = await audit.checkpoint("acme");
    await runner.tick();

    const messages = await webhooks.listMessages("acme");
    expect(messages.map((m) => m.eventType).sort()).toEqual([
      "audit.checkpoint",
      "audit.user.login",
      "audit.user.logout",
    ]);
    expect(messages.map((m) => m.idempotencyKey).sort()).toEqual([cp.id, e1.id, e2.id].sort());
    const deliveries = await webhooks.listDeliveries("acme");
    expect(deliveries).toHaveLength(3);

    // At-least-once re-send: deduplicated by idempotency key.
    await xtandardWebhooksSink(webhooks).send({
      stream: "tenant-hooks",
      tenant: "acme",
      items: [{ kind: "event", event: e1 }],
    });
    expect(await webhooks.listMessages("acme")).toHaveLength(3);
    await runner.stop();
  });
});
