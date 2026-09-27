/**
 * The vault: the only module that sees credential plaintext (CLAUDE.md rule 5).
 *
 * Nothing here returns a credential to a caller that has not asked for it by
 * purpose, and every decrypt writes a `vault_access_log` row in the same call
 * (NFR-03). The log survives credential deletion by design — the row's FK is
 * `on delete set null` — so "who read this secret and why" outlives the secret.
 *
 * Callers receive a `DecryptedCredential` and must not log it, put it in an error
 * message, or include it in an adapter's `raw` response. The adapter layer is held
 * to the same rule.
 */
import type { Sql } from 'postgres';
import { SecretDecryptError, openSecret, sealSecret, type KeyManager } from '@suite/server-core';

export type CredentialKind = 'aggregator_profile' | 'oauth_token';

/** Why a decrypt happened. Recorded verbatim in the access log. */
export type AccessPurpose = 'dispatch' | 'refresh' | 'health_check';

export interface DecryptedCredential {
  readonly credentialId: string;
  readonly kind: CredentialKind;
  readonly provider: string;
  /** The plaintext. Never log this, never put it in an error, never serialise it. */
  readonly secret: string;
}

export interface AccessContext {
  /** Who read it, e.g. 'dispatcher:tiktok' or 'reconciler'. */
  readonly accessor: string;
  readonly purpose: AccessPurpose;
  /** The target this decrypt was for, when there is one. */
  readonly targetId?: string;
}

export class CredentialNotFoundError extends Error {
  constructor(credentialId: string) {
    super(`no credential ${credentialId}`);
    this.name = 'CredentialNotFoundError';
  }
}

export interface CredentialVault {
  /**
   * Decrypts a credential and logs the access. The log row is written even when
   * decryption fails, because a failed read is the more interesting event.
   */
  open(credentialId: string, context: AccessContext): Promise<DecryptedCredential>;

  /** Encrypts and stores a credential. Used by connection setup (M2) and by seeds. */
  store(params: StoreCredentialParams): Promise<string>;
}

export interface StoreCredentialParams {
  readonly id?: string;
  readonly userId: string;
  readonly kind: CredentialKind;
  readonly provider: string;
  readonly secret: string;
  readonly expiresAt?: Date | null;
}

interface CredentialRow {
  id: string;
  kind: CredentialKind;
  provider: string;
  ciphertext: Buffer;
  wrapped_dek: Buffer;
  nonce: Buffer;
  kms_key_id: string;
}

export function createCredentialVault(sql: Sql, keys: KeyManager): CredentialVault {
  async function logAccess(credentialId: string | null, context: AccessContext): Promise<void> {
    await sql`
      insert into poster.vault_access_log (credential_id, accessor, purpose, target_id)
      values (${credentialId}, ${context.accessor}, ${context.purpose},
              ${context.targetId ?? null})`;
  }

  return {
    async open(credentialId, context) {
      const rows = await sql<CredentialRow[]>`
        select id, kind, provider, ciphertext, wrapped_dek, nonce, kms_key_id
          from poster.credentials where id = ${credentialId}`;
      const row = rows[0];

      if (row === undefined) {
        // Logged with a null credential id: an attempt to read something that is
        // not there is worth a trail too.
        await logAccess(null, context);
        throw new CredentialNotFoundError(credentialId);
      }

      // Logged before the decrypt, so a decrypt that throws still leaves a record.
      await logAccess(row.id, context);

      const secret = await openSecret(
        {
          ciphertext: row.ciphertext,
          wrappedDek: row.wrapped_dek,
          nonce: row.nonce,
          keyId: row.kms_key_id,
        },
        keys,
      );

      return { credentialId: row.id, kind: row.kind, provider: row.provider, secret };
    },

    async store(params) {
      const sealed = await sealSecret(params.secret, keys);
      const rows = await sql<{ id: string }[]>`
        insert into poster.credentials
          (id, user_id, kind, provider, ciphertext, wrapped_dek, kms_key_id, nonce, expires_at)
        values (coalesce(${params.id ?? null}::uuid, gen_random_uuid()), ${params.userId},
                ${params.kind}, ${params.provider}, ${sealed.ciphertext}, ${sealed.wrappedDek},
                ${sealed.keyId}, ${sealed.nonce}, ${params.expiresAt ?? null})
        returning id`;
      const id = rows[0]?.id;
      if (id === undefined) throw new Error('credential insert returned no id');
      return id;
    },
  };
}

export { SecretDecryptError };
