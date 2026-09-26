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
    },
  };
}
