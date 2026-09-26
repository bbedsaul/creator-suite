/**
 * @suite/poster-contract — the wire contract as code (D-026, CLAUDE.md rule 13).
 *
 * Every API change starts here: the zod schemas below generate the OpenAPI spec,
 * which generates @suite/poster-client. Handlers parse input with these schemas
 * and return values that satisfy them; no service defines its own parallel types.
 */
export { CONTRACT_VERSION, type ContractVersion } from './version.js';

export {
  ID_PREFIXES,
  InvalidPublicIdError,
  encodeId,
  decodeId,
  tryDecodeId,
  publicId,
  PostId,
  TargetId,
  ConnectionId,
  MediaId,
  EventId,
  ScopeRequestId,
  type ResourceKind,
  type IdPrefix,
} from './ids.js';

export {
  ERROR_CODES,
  ERROR_STATUS,
  CONSTRAINT_CODES,
  ErrorCode,
  ConstraintCode,
  ErrorDetail,
  ErrorEnvelope,
} from './errors.js';

export { AUTH_MODES, AuthMode, AuthContext, TokenRequest, TokenResponse } from './auth.js';

export {
  TEXT_UNITS,
  MEDIA_KINDS,
  CONSTRAINT_VIOLATION_CODES,
  TextUnit,
  TextConstraint,
  MediaKind,
  MediaConstraint,
  VideoConstraint,
  AspectRatioConstraint,
  ThreadConstraint,
  SpecSource,
  PlatformConstraintSpec,
  PlatformConstraints,
  PlatformConstraintsResponse,
  MediaFacts,
  TargetValidationInput,
  ConstraintViolationCode,
  PostContent,
  TargetOverrides,
  ValidateTargetRequest,
  ValidatePostRequest,
  ValidatePostResponse,
  measureText,
  validateTarget,
  type Violation,
} from './constraints.js';

export {
  MEDIA_STATUSES,
  MediaStatus,
  Media,
  SignedUploadRequest,
  SignedUploadResponse,
} from './media.js';

export {
  TARGET_STATES,
  POST_STATES,
  REASON_CLASSES,
  TargetState,
  PostState,
  ReasonClass,
  SubmitTarget,
  SubmitPostRequest,
  PostTargetSummary,
  PostTargetDetail,
  Post,
  PostDetail,
  PatchPostRequest,
  CancelPostResponse,
} from './posts.js';

export { buildOpenApiDocument } from './openapi.js';
