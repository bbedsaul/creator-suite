import { describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import { TokenInvalidError, createAppTokenSigner } from '../src/jwt.js';

const SECRET = 'a-test-signing-secret-at-least-32-chars';
const OPTIONS = {
  secret: SECRET,
  keyId: 'k1',
  issuer: 'poster-api',
  audience: 'poster-api',
} as const;

const claims = { sub: 'app-uuid', client_id: 'trainer-dev', first_party: false };

describe('app token signing (D-046)', () => {
  it('round-trips the claims a handler needs', async () => {
    const signer = createAppTokenSigner(OPTIONS);
    const { token, expiresInSeconds } = await signer.sign(claims);
    expect(expiresInSeconds).toBe(900);
    await expect(signer.verify(token)).resolves.toEqual(claims);
  });

  it('carries a kid, so the signing key can rotate without a format change', async () => {
    const { token } = await createAppTokenSigner(OPTIONS).sign(claims);
    const header = JSON.parse(
      Buffer.from(token.split('.')[0] as string, 'base64url').toString('utf8'),
    ) as { alg: string; kid: string };
    expect(header).toMatchObject({ alg: 'HS256', kid: 'k1' });
  });

  it('still accepts tokens signed with a previous key during rotation', async () => {
    const old = createAppTokenSigner({
      ...OPTIONS,
      secret: 'the-previous-secret-32-characters!!',
      keyId: 'k0',
    });
    const { token } = await old.sign(claims);

    const rotated = createAppTokenSigner({
      ...OPTIONS,
      previousSecrets: { k0: 'the-previous-secret-32-characters!!' },
    });
    await expect(rotated.verify(token)).resolves.toEqual(claims);
  });

  it('rejects a token whose kid it does not know', async () => {
    const foreign = createAppTokenSigner({ ...OPTIONS, keyId: 'unknown-kid' });
    const { token } = await foreign.sign(claims);
    await expect(createAppTokenSigner(OPTIONS).verify(token)).rejects.toThrow(TokenInvalidError);
  });

  it('rejects a token signed with the wrong secret', async () => {
    const attacker = createAppTokenSigner({
      ...OPTIONS,
      secret: 'a-different-secret-32-characters!!!',
    });
    const { token } = await attacker.sign(claims);
    await expect(createAppTokenSigner(OPTIONS).verify(token)).rejects.toThrow(TokenInvalidError);
  });

  it('rejects the wrong issuer and the wrong audience', async () => {
    const signer = createAppTokenSigner(OPTIONS);
    for (const override of [{ issuer: 'somebody-else' }, { audience: 'somebody-else' }]) {
      const other = createAppTokenSigner({ ...OPTIONS, ...override });
      const { token } = await other.sign(claims);
      await expect(signer.verify(token)).rejects.toThrow(TokenInvalidError);
    }
  });

  it('rejects an expired token (contract §2.1: 15 minutes)', async () => {
    const signer = createAppTokenSigner(OPTIONS);
    const expired = await new SignJWT({ client_id: 'trainer-dev', first_party: false })
      .setProtectedHeader({ alg: 'HS256', kid: 'k1', typ: 'JWT' })
      .setSubject('app-uuid')
      .setIssuer(OPTIONS.issuer)
      .setAudience(OPTIONS.audience)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(new TextEncoder().encode(SECRET));

    await expect(signer.verify(expired)).rejects.toThrow(TokenInvalidError);
  });

  it('rejects structural garbage without throwing something unexpected', async () => {
    const signer = createAppTokenSigner(OPTIONS);
    for (const bad of ['', 'not.a.jwt', 'a.b', '....', 'Bearer x']) {
      await expect(signer.verify(bad)).rejects.toThrow(TokenInvalidError);
    }
  });

  it('rejects an unsigned (alg=none) token', async () => {
    const payload = Buffer.from(JSON.stringify({ sub: 'app-uuid', client_id: 'x' })).toString(
      'base64url',
    );
    const header = Buffer.from(JSON.stringify({ alg: 'none', kid: 'k1' })).toString('base64url');
    await expect(createAppTokenSigner(OPTIONS).verify(`${header}.${payload}.`)).rejects.toThrow(
      TokenInvalidError,
    );
  });
});
