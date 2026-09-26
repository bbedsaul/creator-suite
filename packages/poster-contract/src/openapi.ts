/**
 * Assembles the OpenAPI document from the zod schemas in this package.
 *
 * The schemas are the source of truth (D-026): this file only describes which
 * routes exist and which schema each one uses. `pnpm -F @suite/poster-contract gen`
 * writes the result to openapi.json and regenerates @suite/poster-client from it.
 *
 * Only the routes that actually exist are listed. Later sessions add theirs here
 * in the same commit as the handler.
 */
import { z } from 'zod';
import { CONTRACT_VERSION } from './version.js';
import { AuthContext, TokenRequest, TokenResponse } from './auth.js';
import {
  PlatformConstraintsResponse,
  ValidatePostRequest,
  ValidatePostResponse,
} from './constraints.js';
import { Media, SignedUploadRequest, SignedUploadResponse } from './media.js';
import {
  CancelPostResponse,
  PatchPostRequest,
  Post,
  PostDetail,
  SubmitPostRequest,
} from './posts.js';
import { ErrorEnvelope } from './errors.js';

type JsonSchema = Record<string, unknown>;

/** OpenAPI 3.0 dialect, so the spec works with the widest set of tools. */
function toSchema(schema: z.ZodType): JsonSchema {
  return z.toJSONSchema(schema, { target: 'openapi-3.0', io: 'output' }) as JsonSchema;
}

const ref = (name: string): JsonSchema => ({ $ref: `#/components/schemas/${name}` });

const errorResponse = (description: string): JsonSchema => ({
  description,
  content: { 'application/json': { schema: ref('ErrorEnvelope') } },
});

export function buildOpenApiDocument(): JsonSchema {
  return {
    openapi: '3.0.3',
    info: {
      title: 'Social Poster internal API',
      version: CONTRACT_VERSION,
      description:
        'Cross-platform publishing API. Two auth modes share every /v1 route (D-023): ' +
        'app mode uses a client-credentials JWT, user mode uses the signed-in user’s ' +
        'Supabase session JWT and acts as the first-party poster-web app.',
    },
    servers: [{ url: '/', description: 'The service root; deployments front this with TLS.' }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description:
            'App mode: the token from POST /v1/oauth/token. User mode: a Supabase session JWT.',
        },
      },
      schemas: {
        TokenRequest: toSchema(TokenRequest),
        TokenResponse: toSchema(TokenResponse),
        AuthContext: toSchema(AuthContext),
        PlatformConstraintsResponse: toSchema(PlatformConstraintsResponse),
        ValidatePostRequest: toSchema(ValidatePostRequest),
        ValidatePostResponse: toSchema(ValidatePostResponse),
        Media: toSchema(Media),
        SignedUploadRequest: toSchema(SignedUploadRequest),
        SignedUploadResponse: toSchema(SignedUploadResponse),
        SubmitPostRequest: toSchema(SubmitPostRequest),
        Post: toSchema(Post),
        PostDetail: toSchema(PostDetail),
        PatchPostRequest: toSchema(PatchPostRequest),
        CancelPostResponse: toSchema(CancelPostResponse),
        ErrorEnvelope: toSchema(ErrorEnvelope),
      },
    },
    paths: {
      '/v1/oauth/token': {
        post: {
          operationId: 'createToken',
          summary: 'Exchange client credentials for a short-lived app token',
          description:
            'Form-encoded, per OAuth2. The returned JWT is valid for 15 minutes and its ' +
            'sub claim identifies the app. App credentials alone never authorize ' +
            'publishing: acting for a user also requires that user’s grant.',
          tags: ['auth'],
          security: [],
          requestBody: {
            required: true,
            content: {
              'application/x-www-form-urlencoded': { schema: ref('TokenRequest') },
            },
          },
          responses: {
            '200': {
              description: 'A new access token.',
              content: { 'application/json': { schema: ref('TokenResponse') } },
            },
            '400': errorResponse('Malformed request or unsupported grant_type.'),
            '401': errorResponse('Unknown client_id, wrong client_secret, or disabled app.'),
            '429': errorResponse('Too many token requests; honor Retry-After.'),
          },
        },
      },
      '/v1/auth/context': {
        get: {
          operationId: 'getAuthContext',
          summary: 'Report who the API thinks you are',
          description:
            'Returns the acting app and user for the presented token. The response shape is ' +
            'identical in both auth modes, which makes it the cheapest way for a client to ' +
            'confirm its credentials and the user it is acting for.',
          tags: ['auth'],
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: 'user_id',
              in: 'query',
              required: false,
              schema: { type: 'string', format: 'uuid' },
              description:
                'The user to act as. Required in app mode for user-scoped work; in user mode ' +
                'it must equal the token subject or the request is rejected with forbidden_user.',
            },
          ],
          responses: {
            '200': {
              description: 'The resolved auth context.',
              content: { 'application/json': { schema: ref('AuthContext') } },
            },
            '401': errorResponse('Missing, malformed, or expired token.'),
            '403': errorResponse('User-mode token does not match the requested user_id.'),
            '429': errorResponse('Per-app rate limit exceeded; honor Retry-After.'),
          },
        },
      },
      '/v1/platforms/constraints': {
        get: {
          operationId: 'getPlatformConstraints',
          summary: 'Published platform limits, as data',
          description:
            'Every limit the constraint engine enforces, so no client hard-codes a platform ' +
            'rule (CLAUDE.md rule 9). Each spec carries its own `sources` and a `provisional` ' +
            'flag: while provisional, the numbers come from platform documentation rather ' +
            'than the aggregator actually used to post, which is often stricter. Limits ' +
            'marked `max_duration_is_per_account` are an optimistic ceiling that only the ' +
            'platform can confirm for a given account.',
          tags: ['platforms'],
          security: [{ bearerAuth: [] }],
          responses: {
            '200': {
              description: 'Constraints for every enabled platform.',
              content: {
                'application/json': { schema: ref('PlatformConstraintsResponse') },
              },
            },
            '401': errorResponse('Missing, malformed, or expired token.'),
            '429': errorResponse('Per-app rate limit exceeded; honor Retry-After.'),
          },
        },
      },
      '/v1/posts/validate': {
        post: {
          operationId: 'validatePost',
          summary: 'Check a post against platform rules without creating it',
          description:
            'Runs exactly the validation POST /v1/posts runs, and returns exactly the same ' +
            '422 envelope, so a composer can show per-platform warnings before submitting ' +
            'rather than reimplementing the rules. Nothing is created and nothing is ' +
            'reserved. A clean post returns 200; any violation returns 422 with one ' +
            '`details` entry per failing target.',
          tags: ['posts'],
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: ref('ValidatePostRequest') } },
          },
          responses: {
            '200': {
              description: 'Every target passes.',
              content: { 'application/json': { schema: ref('ValidatePostResponse') } },
            },
            '400': errorResponse('Malformed request body.'),
            '401': errorResponse('Missing, malformed, or expired token.'),
            '403': errorResponse('User-mode token does not match the requested user_id.'),
            '404': errorResponse('A connection or media id does not exist for this user.'),
            '422': errorResponse('One or more targets failed platform rules; see details.'),
            '429': errorResponse('Per-app rate limit exceeded; honor Retry-After.'),
          },
        },
      },
      '/v1/media': {
        post: {
          operationId: 'createMedia',
          summary: 'Upload media, or get a signed URL to upload it directly',
          description:
            'Two paths, chosen by Content-Type. `multipart/form-data` sends the bytes ' +
            'through the API, which stores and probes them and returns a ready media row; ' +
            'it is capped in size. `application/json` returns a signed upload URL instead, ' +
            'for large video that should not pass through the API process — PUT the bytes ' +
            'to that URL and then call /complete. Media is uploaded once and referenced by ' +
            'id from any number of posts (FR-07).',
          tags: ['media'],
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'multipart/form-data': {
                schema: {
                  type: 'object',
                  required: ['user_id', 'file'],
                  properties: {
                    user_id: { type: 'string', format: 'uuid' },
                    file: { type: 'string', format: 'binary' },
                  },
                },
              },
              'application/json': { schema: ref('SignedUploadRequest') },
            },
          },
          responses: {
            '201': {
              description: 'Stored and probed (multipart path).',
              content: { 'application/json': { schema: ref('Media') } },
            },
            '202': {
              description: 'Signed URL issued; nothing is usable until /complete.',
              content: { 'application/json': { schema: ref('SignedUploadResponse') } },
            },
            '400': errorResponse('Malformed request, unsupported type, or file too large.'),
            '401': errorResponse('Missing, malformed, or expired token.'),
            '403': errorResponse('User-mode token does not match the requested user_id.'),
            '429': errorResponse('Per-app rate limit exceeded; honor Retry-After.'),
          },
        },
      },
      '/v1/media/{media_id}/complete': {
        post: {
          operationId: 'completeMedia',
          summary: 'Finish a signed-URL upload',
          description:
            'Probes the uploaded object for duration and dimensions and marks the media ' +
            'ready. Until this succeeds the media cannot be posted, and referencing it ' +
            'yields the `media_not_ready` constraint code.',
          tags: ['media'],
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: 'media_id', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': {
              description: 'Probed and ready.',
              content: { 'application/json': { schema: ref('Media') } },
            },
            '400': errorResponse('The object is missing or could not be probed.'),
            '401': errorResponse('Missing, malformed, or expired token.'),
            '404': errorResponse('No such media for this user.'),
          },
        },
      },
      '/v1/posts': {
        post: {
          operationId: 'submitPost',
          summary: 'Submit a post to one or more connected accounts',
          description:
            'Validates every target and creates all of them or none (§5). Send an ' +
            '`Idempotency-Key` header: the same key with the same body returns the ' +
            'original result, and the same key with a different body is 409 ' +
            '`idempotency_conflict`. Keys are scoped per app and kept at least 24 hours. ' +
            'Omitting `schedule_at` means dispatch as soon as the post is ready.',
          tags: ['posts'],
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: 'Idempotency-Key',
              in: 'header',
              required: false,
              schema: { type: 'string', maxLength: 255 },
              description: 'Strongly recommended. Without it a retry creates a second post.',
            },
          ],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: ref('SubmitPostRequest') } },
          },
          responses: {
            '202': {
              description: 'Accepted; targets created.',
              content: { 'application/json': { schema: ref('Post') } },
            },
            '400': errorResponse('Malformed request body.'),
            '401': errorResponse('Missing, malformed, or expired token.'),
            '403': errorResponse('forbidden_user, or grant_missing for a connection.'),
            '404': errorResponse('A connection or media id does not exist for this user.'),
            '409': errorResponse('Same Idempotency-Key with a different body.'),
            '422': errorResponse('One or more targets failed platform rules; see details.'),
            '429': errorResponse('Per-app rate limit exceeded; honor Retry-After.'),
          },
        },
      },
      '/v1/posts/{post_id}': {
        get: {
          operationId: 'getPost',
          summary: 'Read a post and its targets',
          tags: ['posts'],
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'post_id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': {
              description: 'The post, with per-target state and outcomes.',
              content: { 'application/json': { schema: ref('PostDetail') } },
            },
            '401': errorResponse('Missing, malformed, or expired token.'),
            '404': errorResponse('No such post for this app and user.'),
          },
        },
        patch: {
          operationId: 'patchPost',
          summary: 'Edit a post before dispatch',
          description:
            'Re-validates constraints (FR-13). Refused with 409 `too_late` once any target ' +
            'has begun dispatching, because the content may already be on its way.',
          tags: ['posts'],
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'post_id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: ref('PatchPostRequest') } },
          },
          responses: {
            '200': {
              description: 'Updated and re-validated.',
              content: { 'application/json': { schema: ref('PostDetail') } },
            },
            '400': errorResponse('Malformed request body.'),
            '401': errorResponse('Missing, malformed, or expired token.'),
            '403': errorResponse('forbidden_user, or grant_missing for a connection.'),
            '404': errorResponse('No such post, connection, or media for this user.'),
            '409': errorResponse('A target is already dispatching.'),
            '422': errorResponse('The edit fails platform rules; see details.'),
          },
        },
      },
      '/v1/posts/{post_id}/cancel': {
        post: {
          operationId: 'cancelPost',
          summary: 'Cancel a post before dispatch',
          description:
            'Cancels every target that has not begun dispatching (§6). Returns 409 ' +
            '`too_late` when nothing could be canceled. A post already canceled returns ' +
            '200 with an empty `canceled_target_ids`, so a retry is safe.',
          tags: ['posts'],
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'post_id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': {
              description: 'Cancel applied, or already canceled.',
              content: { 'application/json': { schema: ref('CancelPostResponse') } },
            },
            '401': errorResponse('Missing, malformed, or expired token.'),
            '404': errorResponse('No such post for this app and user.'),
            '409': errorResponse('Every target had already begun dispatching or finished.'),
          },
        },
      },
    },
  };
}
