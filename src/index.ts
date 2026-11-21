/**
 * `@xtandard/audit` — self-hosted, embeddable, tamper-evident audit-log control
 * plane for B2B SaaS.
 *
 * The root export: the core and its types (also on `/core` and `/schema`), the
 * buffered recorder, transforms, integrity (hash chain, checkpoints, signers),
 * exports, the stream runner and sinks contract, portal tokens, the hooks
 * contract, the auth/authorization contracts, and the panel's web-standard
 * fetch handler. Storage adapters, auth providers, framework adapters, sinks
 * with peers and the React embeds are separate subpaths.
 *
 * Import from `@xtandard/audit`.
 *
 * @module audit
 */

export * from "./schema.ts";
export * from "./core.ts";
export { createRecorder, RecorderOverflowError } from "./recorder.ts";
export type { Recorder, RecorderFallback, RecorderOptions } from "./recorder.ts";
export {
  REDACTED,
  applyTransforms,
  hashValue,
  mask,
  maskValue,
  omit,
  redact,
  type AuditTransform,
  type TransformableEvent,
} from "./transforms.ts";
export {
  defineActions,
  runStandardSchema,
  type ActionMap,
  type ActionMetadataInput,
  type ActionSpec,
  type StandardSchemaV1,
} from "./standard-schema.ts";
export {
  GENESIS_HASH,
  chainHeader,
  computeDigests,
  ed25519Signer,
  ed25519VerificationKey,
  generateSigningKeyPair,
  hmacSigner,
  hmacVerificationKey,
  keysFromJwks,
  sealChain,
  sealEvent,
  sectionDigest,
  sha256,
  signCheckpoint,
  verifyChain,
  verifyCheckpointSignature,
  verifyEvent,
  type AuditSigner,
  type AuditVerificationKey,
  type VerifyChainOptions,
  type VerifyIssue,
  type VerifyIssueKind,
  type VerifyReport,
} from "./integrity.ts";
export {
  CSV_COLUMNS,
  EXPORT_CONTENT_TYPES,
  csvCell,
  eventToCsvRow,
  exportEvents,
  parseBundle,
  verifyBundle,
  type BundleHeader,
  type ExportFormat,
  type ExportOptions,
  type ParsedBundle,
} from "./export.ts";
export {
  DEFAULT_QUERY_LIMIT,
  MAX_QUERY_LIMIT,
  QueryError,
  decodeCursor,
  encodeCursor,
  matchesQuery,
  normalizeQuery,
  type NormalizedQuery,
  type QueryPosition,
} from "./query.ts";
export {
  callbackSink,
  createStreamRunner,
  type AuditSink,
  type StreamBatch,
  type StreamCursor,
  type StreamDefinition,
  type StreamItem,
  type StreamRunner,
  type StreamRunnerOptions,
  type StreamStatus,
} from "./streams.ts";
export { resolveEventLog, createKvEventLog, type EventLog } from "./event-log.ts";
export { canonicalStringify } from "./canonical.ts";
export { newId, idPattern, idTime, type IdPrefix } from "./id.ts";
export { durationToMs } from "./duration.ts";
export * as keys from "./keys.ts";
export { VERSION } from "./version.ts";
export {
  HookDeniedError,
  defaultHookErrorReporter,
  normalizeHooks,
  runAfter,
  runBefore,
  type AfterEvent,
  type AfterEventType,
  type AuditHooks,
  type AuditHooksInput,
  type BeforeEvent,
  type BeforeEventType,
  type HookActor,
  type HookErrorReporter,
} from "./hooks/contract.ts";
export {
  ChainConflictError,
  hasEventLog,
  isCompareAndSwap,
  isTransactional,
  isWatchable,
  requirePeer,
  type AuditStorage,
  type CompareAndSwapAuditStorage,
  type EventLogStorage,
  type StorageChangeEvent,
  type TransactionalAuditStorage,
  type WatchableAuditStorage,
} from "./storage/contract.ts";
export {
  pgListenNotify,
  withWatch,
  type PgNotificationClient,
  type WatchSubscribe,
} from "./storage/watch.ts";
export {
  ACTION_REGEX,
  DEFAULT_MAX_EVENT_BYTES,
  TENANT_REGEX,
  ValidationError,
  assertValid,
  validateActionDefinition,
  validateEventInput,
  validateTenant,
  type ValidationIssue,
  type ValidationResult,
} from "./validation.ts";

// Auth & authorization contracts (implement your own; providers live behind
// the auth/* and authorization/* subpath exports)
export type { AuthProvider, Principal } from "./auth/contract.ts";
export type {
  AuthorizationProvider,
  AuthorizeInput,
  AuditAction,
  AuditResource,
} from "./authorization/contract.ts";
export { ALL_ACTIONS, isMutatingAction, MUTATING_ACTIONS } from "./authorization/contract.ts";

// Portal tokens (mint server-side, verify in the panel handler)
export {
  createPortalToken,
  DEFAULT_PORTAL_ACTIONS,
  intersectActions,
  PORTAL_TOKEN_PREFIX,
  portalCanSee,
  PortalTokenError,
  scopeQueryToPortal,
  verifyPortalToken,
  type PortalFilter,
  type PortalGrant,
  type PortalTokenOptions,
  type ScopedQuery,
} from "./portal.ts";

// Server handler (the panel every framework adapter mounts)
export { createFetchHandler } from "./server/create-fetch-handler.ts";
export type { AuditPanelOptions, CreateFetchHandlerResult } from "./server/create-fetch-handler.ts";
export type { AuditCorsOptions } from "./server/cors.ts";
export type { AuditPortalOptions, PanelConfig } from "./server/routes.ts";
export { buildOpenApiDocument } from "./server/openapi.ts";
export type { OpenApiOptions } from "./server/openapi.ts";
