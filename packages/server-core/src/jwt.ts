/**
 * Token verification for both auth modes (D-023).
 *
 * App tokens are ours: signed HS256 with a secret from the secrets manager, and
 * always carrying a `kid` so the signing key can rotate without a format change
 * (D-046). Nothing outside this service verifies them, so a symmetric key is the
 * right trade — and it is deliberately NOT the Supabase JWT secret.
 *
 * User tokens are Supabase's: verified against the project's JWKS using the
 * asymmetric key the token names in its own `kid` (D-046). That means this
 * service never holds Supabase's signing secret.
 */
import { SignJWT, createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

export const APP_TOKEN_TTL_SECONDS = 15 * 60;

export class TokenInvalidError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'TokenInvalidError';
  }
}

export interface AppTokenClaims {
  /** The app's database id. */
  readonly sub: string;
  readonly client_id: string;
  readonly first_party: boolean;
}

export interface AppTokenSigner {
  sign(claims: AppTokenClaims): Promise<{ token: string; expiresInSeconds: number }>;
  verify(token: string): Promise<AppTokenClaims>;
}

export interface AppTokenSignerOptions {
  /** Current signing secret. Never logged, never returned. */
  readonly secret: string;
  /** Identifies the current secret so verification survives rotation. */
  readonly keyId: string;
  /** Secrets still accepted for verification, keyed by `kid`, during rotation. */
  readonly previousSecrets?: Readonly<Record<string, string>>;
  readonly issuer: string;
  readonly audience: string;
  readonly ttlSeconds?: number;
}

export function createAppTokenSigner(options: AppTokenSignerOptions): AppTokenSigner {
  const encoder = new TextEncoder();
  const ttl = options.ttlSeconds ?? APP_TOKEN_TTL_SECONDS;
  const keys = new Map<string, Uint8Array>([[options.keyId, encoder.encode(options.secret)]]);
  for (const [kid, secret] of Object.entries(options.previousSecrets ?? {})) {
    keys.set(kid, encoder.encode(secret));
  }

  return {
    async sign(claims) {
      const token = await new SignJWT({
        client_id: claims.client_id,
        first_party: claims.first_party,
      })
        .setProtectedHeader({ alg: 'HS256', kid: options.keyId, typ: 'JWT' })
        .setSubject(claims.sub)
        .setIssuer(options.issuer)
        .setAudience(options.audience)
        .setIssuedAt()
        .setExpirationTime(`${String(ttl)}s`)
        .sign(keys.get(options.keyId) as Uint8Array);
      return { token, expiresInSeconds: ttl };
    },

    async verify(token) {
      let payload: JWTPayload;
      try {
        const kid = readKid(token);
        const key = kid === undefined ? undefined : keys.get(kid);
        if (key === undefined) throw new Error('unknown signing key');
        ({ payload } = await jwtVerify(token, key, {
          issuer: options.issuer,
          audience: options.audience,
          algorithms: ['HS256'],
        }));
      } catch (cause) {
        throw new TokenInvalidError(cause instanceof Error ? cause.message : 'invalid token');
      }

      const { sub, client_id: clientId, first_party: firstParty } = payload;
      if (typeof sub !== 'string' || typeof clientId !== 'string') {
        throw new TokenInvalidError('app token is missing required claims');
      }
      return { sub, client_id: clientId, first_party: firstParty === true };
    },
  };
}

/** Reads the `kid` from the header without trusting anything else in the token. */
function readKid(token: string): string | undefined {
  const header = token.split('.')[0];
  if (header === undefined) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as {
      kid?: unknown;
    };
    return typeof decoded.kid === 'string' ? decoded.kid : undefined;
  } catch {
    return undefined;
  }
}

export interface UserTokenVerifier {
  /** Returns the Supabase user id (`sub`) or throws TokenInvalidError. */
  verify(token: string): Promise<{ sub: string }>;
}

export interface UserTokenVerifierOptions {
  /** e.g. http://127.0.0.1:54321/auth/v1/.well-known/jwks.json */
  readonly jwksUrl: string;
  /** e.g. http://127.0.0.1:54321/auth/v1 */
  readonly issuer: string;
}

/**
 * Verifies Supabase session JWTs against the project's JWKS.
 *
 * `createRemoteJWKSet` caches keys and refetches on an unknown `kid`, which is
 * what makes key rotation a non-event here.
 */
export function createUserTokenVerifier(options: UserTokenVerifierOptions): UserTokenVerifier {
  const jwks = createRemoteJWKSet(new URL(options.jwksUrl));

  return {
    async verify(token) {
      try {
        const { payload } = await jwtVerify(token, jwks, { issuer: options.issuer });
        if (typeof payload.sub !== 'string') {
          throw new Error('session token has no subject');
        }
        return { sub: payload.sub };
      } catch (cause) {
        throw new TokenInvalidError(cause instanceof Error ? cause.message : 'invalid token');
      }
    },
  };
}
