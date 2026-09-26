/**
 * Authentication schemas, from contract §2.
 *
 * Two modes share every /v1 route (D-023): app mode presents a client-credentials
 * JWT, user mode presents the user's Supabase session JWT and acts as the
 * first-party `poster-web` app.
 */
import { z } from 'zod';

export const TokenRequest = z
  .object({
    grant_type: z.literal('client_credentials'),
    client_id: z.string().min(1),
    client_secret: z.string().min(1),
  })
  .describe('OAuth2 client-credentials request, form-encoded.');
export type TokenRequest = z.infer<typeof TokenRequest>;

export const TokenResponse = z
  .object({
    access_token: z.string().describe('JWT whose sub is the app id.'),
    token_type: z.literal('Bearer'),
    expires_in: z.number().int().positive().describe('Seconds until the token expires.'),
  })
  .describe('A short-lived app access token.');
export type TokenResponse = z.infer<typeof TokenResponse>;

export const AUTH_MODES = ['app', 'user'] as const;
export const AuthMode = z.enum(AUTH_MODES);
export type AuthMode = z.infer<typeof AuthMode>;

export const AuthContext = z
  .object({
    mode: AuthMode.describe('Which auth mode the caller used.'),
    app: z.object({
      client_id: z.string().describe('The app the request acts as.'),
      first_party: z.boolean(),
    }),
    user_id: z
      .string()
      .uuid()
      .nullable()
      .describe('The user this request acts on behalf of, or null in app mode with no user.'),
  })
  .describe('Who the API thinks you are. Identical shape in both auth modes.');
export type AuthContext = z.infer<typeof AuthContext>;
