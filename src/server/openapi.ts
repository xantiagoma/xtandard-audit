/**
 * OpenAPI 3.1 description of the panel's JSON API (`docs/HTTP_API.md`).
 *
 * Exposed two ways, mirroring the sibling panels:
 *  - served at `GET {basePath}/api/openapi.json` for standalone tools (Scalar,
 *    Swagger UI, Postman, codegen);
 *  - returned by `createFetchHandler(...).openapi()` so you can MERGE it into
 *    your host app's OpenAPI document (e.g. Elysia `@elysiajs/openapi`
 *    `references`, or Hono's OpenAPI).
 *
 * Hand-authored — no generation dependency (flags precedent).
 *
 * @module
 */

/** Options for {@link buildOpenApiDocument}. */
export interface OpenApiOptions {
  /** Mount prefix used in the `servers` url (e.g. `"/audit"`). */
  basePath?: string;
  /** Document title. */
  title?: string;
  /** Document version (defaults to the package's API version). */
  version?: string;
}

const str = { type: "string" } as const;
const dateTime = { type: "string", format: "date-time" } as const;
const int = { type: "integer" } as const;
const strList = { type: "array", items: str } as const;
const SECTION = {
  type: "string",
  enum: ["actor", "targets", "context", "metadata", "description"],
} as const;

const AUDIT_ACTIONS = [
  "tenant:read",
  "event:read",
  "event:record",
  "event:export",
  "event:erase",
  "integrity:read",
  "integrity:checkpoint",
  "action:read",
  "action:update",
  "action:delete",
  "retention:prune",
  "stream:read",
  "stream:retry",
];

const schemas = {
  Actor: {
    type: "object",
    required: ["id"],
    properties: {
      id: str,
      type: { type: "string", description: 'Default "user".' },
      name: str,
      email: str,
      metadata: { type: "object" },
    },
  },
  Target: {
    type: "object",
    required: ["type", "id"],
    properties: { type: str, id: str, name: str, metadata: { type: "object" } },
  },
  Context: {
    type: "object",
    additionalProperties: true,
    properties: { ip: str, userAgent: str, requestId: str, location: str },
  },
  Integrity: {
    type: "object",
    required: ["v", "prevHash", "hash", "digests"],
    properties: {
      v: { const: 1 },
      prevHash: str,
      hash: { type: "string", description: '"sha256:" + hex.' },
      digests: { type: "object", additionalProperties: str },
      erased: { type: "array", items: SECTION },
    },
  },
  AuditEvent: {
    type: "object",
    required: [
      "id",
      "tenant",
      "seq",
      "action",
      "occurredAt",
      "recordedAt",
      "actor",
      "targets",
      "context",
      "metadata",
      "integrity",
    ],
    properties: {
      id: { type: "string", description: '"evt_" + 26-char time-sortable id.' },
      tenant: str,
      seq: { type: "integer", minimum: 1, description: "Position in the tenant's chain." },
      action: str,
      occurredAt: dateTime,
      recordedAt: dateTime,
      actor: { $ref: "#/components/schemas/Actor" },
      targets: { type: "array", items: { $ref: "#/components/schemas/Target" } },
      context: { $ref: "#/components/schemas/Context" },
      metadata: { type: "object" },
      outcome: { type: "string", enum: ["success", "failure"] },
      description: str,
      integrity: { $ref: "#/components/schemas/Integrity" },
    },
  },
  AuditEventInput: {
    type: "object",
    required: ["action"],
    description:
      "The tenant comes from the path; the actor defaults to the authenticated principal.",
    properties: {
      id: { type: "string", description: "Explicit id for idempotent re-recording." },
      action: str,
      occurredAt: dateTime,
      actor: { $ref: "#/components/schemas/Actor" },
      targets: { type: "array", items: { $ref: "#/components/schemas/Target" } },
      context: { $ref: "#/components/schemas/Context" },
      metadata: { type: "object" },
      outcome: { type: "string", enum: ["success", "failure"] },
      description: str,
    },
  },
  AuditPage: {
    type: "object",
    required: ["items", "pageInfo"],
    properties: {
      items: { type: "array", items: { $ref: "#/components/schemas/AuditEvent" } },
      pageInfo: {
        type: "object",
        required: ["hasNextPage", "endCursor"],
        properties: { hasNextPage: { type: "boolean" }, endCursor: { type: ["string", "null"] } },
      },
    },
  },
  ChainHead: {
    type: "object",
    required: ["tenant", "seq", "hash"],
    properties: {
      tenant: str,
      seq: int,
      hash: str,
      baseSeq: int,
      baseHash: str,
      updatedAt: dateTime,
    },
  },
  AuditTenant: {
    type: "object",
    required: ["key", "head"],
    properties: {
      key: str,
      count: { type: "integer", description: "Events currently retained." },
      head: { $ref: "#/components/schemas/ChainHead" },
      createdAt: dateTime,
    },
  },
  AuditCheckpoint: {
    type: "object",
    required: ["v", "id", "tenant", "kind", "seq", "hash", "at", "keyId", "alg", "signature"],
    properties: {
      v: { const: 1 },
      id: str,
      tenant: str,
      kind: { type: "string", enum: ["head", "base"] },
      seq: int,
      hash: str,
      at: dateTime,
      keyId: str,
      alg: { type: "string", enum: ["Ed25519", "HS256"] },
      signature: { type: "string", description: "base64url." },
    },
  },
  VerifyReport: {
    type: "object",
    required: ["ok", "checked", "anchor", "issues"],
    properties: {
      ok: { type: "boolean" },
      tenant: { type: ["string", "null"] },
      checked: int,
      fromSeq: { type: ["integer", "null"] },
      toSeq: { type: ["integer", "null"] },
      headHash: { type: ["string", "null"] },
      anchor: { type: "string", enum: ["genesis", "checkpoint", "unanchored", "none"] },
      linksChecked: { type: "boolean" },
      checkpointsVerified: int,
      signedThrough: { type: ["integer", "null"] },
      erased: {
        type: "array",
        items: {
          type: "object",
          properties: { seq: int, eventId: str, sections: { type: "array", items: SECTION } },
        },
      },
      issues: {
        type: "array",
        items: {
          type: "object",
          required: ["kind", "message"],
          properties: {
            kind: str,
            seq: int,
            eventId: str,
            checkpointId: str,
            section: SECTION,
            message: str,
          },
        },
      },
    },
  },
  ActionDefinition: {
    type: "object",
    required: ["name"],
    properties: {
      name: { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9._:-]*$" },
      description: str,
      group: str,
      targets: strList,
      schema: { description: "JSON-Schema-ish description of metadata (documentation only)." },
      deprecated: { type: "boolean" },
      source: { type: "string", enum: ["code", "ui"] },
      createdAt: dateTime,
      updatedAt: dateTime,
    },
  },
  EraseInput: {
    type: "object",
    properties: {
      sections: {
        type: "array",
        items: SECTION,
        description: "Default: every section.",
      },
      reason: { type: "string", description: "Recorded in the self-audit event." },
    },
  },
  PruneResult: {
    type: "object",
    required: ["tenant", "pruned", "baseSeq"],
    properties: { tenant: str, pruned: int, baseSeq: int },
  },
  StreamStatus: {
    type: "object",
    required: ["name", "kind", "tenants"],
    properties: {
      name: str,
      kind: str,
      tenants: {
        type: "array",
        items: {
          type: "object",
          properties: {
            tenant: str,
            cursor: int,
            headSeq: int,
            lag: int,
            failures: int,
            lastError: str,
            lastErrorAt: dateTime,
            nextAttemptAt: dateTime,
            lastDeliveredAt: dateTime,
          },
        },
      },
    },
  },
  Overview: {
    type: "object",
    required: ["tenants", "events", "recent", "streams"],
    properties: {
      tenants: int,
      events: int,
      recent: { type: "array", items: { $ref: "#/components/schemas/AuditEvent" } },
      streams: { type: "array", items: { $ref: "#/components/schemas/StreamStatus" } },
    },
  },
  PanelConfig: {
    type: "object",
    required: ["title", "basePath", "readonly", "portal", "principal", "allowed", "features"],
    properties: {
      title: str,
      basePath: str,
      readonly: { type: "boolean" },
      logoUrl: str,
      portal: {
        type: "boolean",
        description: "True when the request carried a valid portal token.",
      },
      tenant: { type: "string", description: "The portal principal's tenant." },
      principal: {
        type: ["object", "null"],
        properties: { id: str, name: str, email: str },
      },
      allowed: { type: "array", items: { type: "string", enum: AUDIT_ACTIONS } },
      features: {
        type: "object",
        properties: { signer: { type: "boolean" }, streams: { type: "boolean" } },
      },
    },
  },
  Jwks: {
    type: "object",
    required: ["keys"],
    properties: { keys: { type: "array", items: { type: "object" } } },
  },
  Error: {
    type: "object",
    required: ["error"],
    properties: {
      error: str,
      code: str,
      action: str,
      errors: {
        type: "array",
        items: { type: "object", properties: { path: str, message: str } },
      },
    },
  },
} as const;

const TENANT = { name: "tenant", in: "path", required: true, schema: str } as const;
const ID = { name: "id", in: "path", required: true, schema: str } as const;
const NAME = { name: "name", in: "path", required: true, schema: str } as const;

const listQ = (name: string, description: string) => ({
  name,
  in: "query",
  description: `${description} Repeat the parameter or separate with commas.`,
  schema: strList,
  style: "form",
  explode: true,
});
const q = (name: string, schema: object, description?: string) => ({
  name,
  in: "query",
  schema,
  ...(description ? { description } : {}),
});

/** The query model as URL parameters (filters; pagination added separately). */
const FILTER_PARAMS = [
  listQ("actions", 'Exact action names, or families ("invoice.*").'),
  listQ("excludeActions", "Names / families to exclude."),
  q("actorId", str),
  q("actorType", str),
  q("targetType", str),
  q("targetId", str),
  q("outcome", { type: "string", enum: ["success", "failure"] }),
  q("from", dateTime, "Inclusive lower bound on occurredAt."),
  q("to", dateTime, "Exclusive upper bound on occurredAt."),
  q("search", str, "Case-insensitive substring search."),
];
const PAGE_PARAMS = [
  q("order", { type: "string", enum: ["desc", "asc"], default: "desc" }),
  q("limit", { type: "integer", minimum: 1, maximum: 500, default: 50 }),
  q("cursor", str, "Opaque, from pageInfo.endCursor."),
];

const jsonBody = (schema: object, required = true) => ({
  required,
  content: { "application/json": { schema } },
});
const jsonRes = (desc: string, schema: object) => ({
  description: desc,
  content: { "application/json": { schema } },
});
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const errorRes = (desc: string) => jsonRes(desc, ref("Error"));
const okRef = (name: string, desc = name) => jsonRes(desc, ref(name));
const arrayOf = (name: string) => ({ type: "array", items: ref(name) });
const noContent = { description: "No content" };

/** Responses every authenticated route can produce. */
const common = {
  "401": errorRes("Unauthenticated or invalid portal token"),
  "403": errorRes("Denied (authorization, portal scope, or a hook)"),
};
/** Plus readonly, for mutating routes. */
const mutating = { ...common, "423": errorRes("The panel is readonly") };

/** Build the OpenAPI 3.1 document for the panel API. Pure — safe to call anywhere. */
export function buildOpenApiDocument(options: OpenApiOptions = {}): Record<string, unknown> {
  const base = options.basePath && options.basePath !== "/" ? options.basePath : "";
  const tenantPath = "/api/tenants/{tenant}";

  return {
    openapi: "3.1.0",
    info: {
      title: options.title ?? "@xtandard/audit API",
      version: options.version ?? "0.1.0",
      description:
        "Control-plane API for @xtandard/audit: browse, record, export and verify per-tenant tamper-evident audit logs; manage checkpoints, retention, the action catalog and SIEM streams. Portal tokens (Authorization: Bearer audpt_…) hit the same surface scoped to one tenant and an optional view filter.",
    },
    servers: [{ url: base || "/" }],
    tags: [
      { name: "meta" },
      { name: "tenants" },
      { name: "events" },
      { name: "integrity" },
      { name: "retention" },
      { name: "actions" },
      { name: "streams" },
    ],
    security: [{ basicAuth: [] }, { bearerAuth: [] }],
    paths: {
      "/config": {
        get: {
          tags: ["meta"],
          security: [],
          summary: "Bootstrap config (principal, allowed actions, portal flag, features)",
          responses: { "200": okRef("PanelConfig") },
        },
      },
      "/api/openapi.json": {
        get: {
          tags: ["meta"],
          security: [],
          summary: "This OpenAPI document",
          responses: { "200": jsonRes("OpenAPI 3.1 document", { type: "object" }) },
        },
      },
      "/api/integrity/keys": {
        get: {
          tags: ["integrity"],
          security: [],
          summary: "Public checkpoint verification keys as a JWKS (unauthenticated, CORS-open)",
          responses: { "200": okRef("Jwks") },
        },
      },
      "/api/overview": {
        get: {
          tags: ["tenants"],
          summary: "Dashboard counters, the 10 latest events across tenants, stream status",
          responses: { "200": okRef("Overview"), ...common },
        },
      },
      "/api/tenants": {
        get: {
          tags: ["tenants"],
          summary: "List tenants (created implicitly on their first event)",
          responses: { "200": jsonRes("Tenants", arrayOf("AuditTenant")), ...common },
        },
      },
      [tenantPath]: {
        parameters: [TENANT],
        get: {
          tags: ["tenants"],
          summary: "Get a tenant (chain head + retained count)",
          responses: { "200": okRef("AuditTenant"), "404": errorRes("Not found"), ...common },
        },
      },
      "/api/events": {
        get: {
          tags: ["events"],
          summary: "Search events across tenants (portal tokens: their tenant only)",
          parameters: [q("tenant", str), ...FILTER_PARAMS, ...PAGE_PARAMS],
          responses: {
            "200": okRef("AuditPage"),
            "400": errorRes("Bad query or cursor"),
            ...common,
          },
        },
      },
      [`${tenantPath}/events`]: {
        parameters: [TENANT],
        get: {
          tags: ["events"],
          summary: "Search a tenant's events",
          parameters: [...FILTER_PARAMS, ...PAGE_PARAMS],
          responses: {
            "200": okRef("AuditPage"),
            "400": errorRes("Bad query or cursor"),
            ...common,
          },
        },
        post: {
          tags: ["events"],
          summary: "Record one event (object body) or a batch (array body)",
          requestBody: jsonBody({
            oneOf: [ref("AuditEventInput"), arrayOf("AuditEventInput")],
          }),
          responses: {
            "201": jsonRes("Recorded", {
              oneOf: [ref("AuditEvent"), arrayOf("AuditEvent")],
            }),
            "409": errorRes("Same explicit id, different content"),
            "422": errorRes("Validation error"),
            ...mutating,
          },
        },
      },
      [`${tenantPath}/events/{id}`]: {
        parameters: [TENANT, ID],
        get: {
          tags: ["events"],
          summary: "Get one event",
          responses: { "200": okRef("AuditEvent"), "404": errorRes("Not found"), ...common },
        },
      },
      [`${tenantPath}/events/{id}/erase`]: {
        parameters: [TENANT, ID],
        post: {
          tags: ["events"],
          summary: "Erase sections of an event (digests kept: the chain still verifies)",
          requestBody: jsonBody(ref("EraseInput"), false),
          responses: {
            "200": okRef("AuditEvent", "The erased event"),
            "404": errorRes("Not found"),
            "422": errorRes("Unknown section"),
            ...mutating,
          },
        },
      },
      [`${tenantPath}/export`]: {
        parameters: [TENANT],
        get: {
          tags: ["events"],
          summary:
            "Stream an export (csv | json | jsonl, or the verifiable `bundle` of the whole chain)",
          parameters: [
            q("format", {
              type: "string",
              enum: ["csv", "json", "jsonl", "bundle"],
              default: "csv",
            }),
            ...FILTER_PARAMS,
            PAGE_PARAMS[0]!,
          ],
          responses: {
            "200": {
              description: "The export, as an attachment (`content-disposition`)",
              content: {
                "text/csv": { schema: str },
                "application/json": { schema: arrayOf("AuditEvent") },
                "application/x-ndjson": { schema: str },
              },
            },
            "400": errorRes("Bad format or query"),
            ...common,
          },
        },
      },
      [`${tenantPath}/verify`]: {
        parameters: [TENANT],
        get: {
          tags: ["integrity"],
          summary: "Verify the tenant's chain (whole retained range, or fromSeq..toSeq)",
          parameters: [q("fromSeq", int), q("toSeq", int)],
          responses: { "200": okRef("VerifyReport"), ...common },
        },
      },
      [`${tenantPath}/checkpoints`]: {
        parameters: [TENANT],
        get: {
          tags: ["integrity"],
          summary: "List signed checkpoints",
          responses: { "200": jsonRes("Checkpoints", arrayOf("AuditCheckpoint")), ...common },
        },
        post: {
          tags: ["integrity"],
          summary: "Sign the tenant's current chain head",
          responses: {
            "201": okRef("AuditCheckpoint", "Created"),
            "409": errorRes("No signer configured"),
            ...mutating,
          },
        },
      },
      [`${tenantPath}/prune`]: {
        parameters: [TENANT],
        post: {
          tags: ["retention"],
          summary: "Apply the retention policy to one tenant",
          responses: { "200": okRef("PruneResult"), ...mutating },
        },
      },
      "/api/prune": {
        post: {
          tags: ["retention"],
          summary: "Apply the retention policy to every tenant",
          responses: { "200": jsonRes("Per-tenant results", arrayOf("PruneResult")), ...mutating },
        },
      },
      "/api/actions": {
        get: {
          tags: ["actions"],
          summary: "List the action catalog",
          responses: { "200": jsonRes("Actions", arrayOf("ActionDefinition")), ...common },
        },
      },
      "/api/actions/{name}": {
        parameters: [NAME],
        put: {
          tags: ["actions"],
          summary: "Create or update a catalog entry",
          requestBody: jsonBody(ref("ActionDefinition")),
          responses: {
            "200": okRef("ActionDefinition", "Saved"),
            "422": errorRes("Validation error"),
            ...mutating,
          },
        },
        delete: {
          tags: ["actions"],
          summary: "Delete a UI-defined catalog entry",
          responses: {
            "204": noContent,
            "404": errorRes("Not found"),
            "409": errorRes("Defined in code"),
            ...mutating,
          },
        },
      },
      "/api/streams": {
        get: {
          tags: ["streams"],
          summary: "Stream status: per-tenant cursor, lag, last error, next retry",
          responses: { "200": jsonRes("Streams", arrayOf("StreamStatus")), ...common },
        },
      },
      "/api/streams/{name}/retry": {
        parameters: [NAME],
        post: {
          tags: ["streams"],
          summary: "Clear a stream's backoff (one tenant with ?tenant=, else all)",
          parameters: [q("tenant", str)],
          responses: { "204": noContent, "404": errorRes("Unknown stream"), ...mutating },
        },
      },
    },
    components: {
      schemas,
      securitySchemes: {
        basicAuth: { type: "http", scheme: "basic" },
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "Portal tokens (audpt_…) or host-issued bearer credentials.",
        },
      },
    },
  };
}
