/**
 * The one error envelope (contract §8, CLAUDE.md rule 8).
 *
 * Handlers throw ApiError; this module is the only place that turns a failure
 * into a response body, so no route can invent its own shape.
 */
import { ERROR_STATUS, type ErrorCode, type ErrorDetail } from '@suite/poster-contract';

export class ApiError extends Error {
  readonly status: number;

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: ErrorDetail[],
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ApiError';
    this.status = ERROR_STATUS[code];
  }

  /** 404 for a resource that does not exist, or for an ID that never could. */
  static notFound(what = 'Resource not found'): ApiError {
    return new ApiError('not_found', what);
  }

  static invalidToken(message = 'The access token is missing, malformed, or expired'): ApiError {
    return new ApiError('invalid_token', message);
  }

  static forbiddenUser(): ApiError {
    return new ApiError(
      'forbidden_user',
      'A user-mode token may only act for the user it was issued to',
    );
  }

  static invalidRequest(message: string, details?: ErrorDetail[]): ApiError {
    return new ApiError('invalid_request', message, details);
  }

  static rateLimited(retryAfterSeconds: number): RateLimitedError {
    return new RateLimitedError(retryAfterSeconds);
  }
}

/** Carries the Retry-After value the contract requires on a 429 (§2.1). */
export class RateLimitedError extends ApiError {
  constructor(readonly retryAfterSeconds: number) {
    super('rate_limited', 'Per-app rate limit exceeded');
    this.name = 'RateLimitedError';
  }
}

export interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: ErrorDetail[];
    request_id: string;
  };
}

export function toErrorBody(error: ApiError, requestId: string): ErrorBody {
  return {
    error: {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
      request_id: requestId,
    },
  };
}
