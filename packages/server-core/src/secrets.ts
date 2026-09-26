/**
 * Client-secret hashing with argon2id.
 *
 * Parameters are the OWASP baseline for argon2id (D-045): 19 MiB of memory, two
 * passes, one lane. They are stored inside the hash string, so a stored hash
 * always records the cost it was made with, and `needsRehash` lets the cost be
 * raised later without invalidating anyone's credentials.
 *
 * `@node-rs/argon2` is used rather than the node-gyp `argon2` package because it
 * ships a prebuilt linux-x64-musl binary, so the Alpine runtime image needs no
 * compiler toolchain (D-045).
 */
import { hash, verify } from '@node-rs/argon2';

export interface Argon2Params {
  readonly memoryCost: number;
  readonly timeCost: number;
  readonly parallelism: number;
}

/** OWASP-recommended argon2id minimum. Raise deliberately, never lower. */
export const ARGON2_PARAMS: Argon2Params = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

/**
 * The variant is left to the library default, which is argon2id, rather than
 * passing `Algorithm.Argon2id`: that enum is an ambient const enum and cannot be
 * referenced under `verbatimModuleSyntax`. The default is pinned by a test that
 * asserts the hash string starts with `$argon2id$`, so a library change that
 * altered it would fail the build rather than silently weaken every secret.
 */
export async function hashSecret(secret: string): Promise<string> {
  return hash(secret, ARGON2_PARAMS);
}

/**
 * Constant-time verification. Returns false rather than throwing on a malformed
 * stored hash: a corrupt row must read as "wrong secret", never as a 500 that
 * tells an attacker they found something interesting.
 */
export async function verifySecret(storedHash: string, secret: string): Promise<boolean> {
  try {
    return await verify(storedHash, secret);
  } catch {
    return false;
  }
}

/**
 * True when a stored hash was made with weaker parameters than the current
 * baseline, so the caller can transparently re-hash on a successful login.
 */
export function needsRehash(storedHash: string, params: Argon2Params = ARGON2_PARAMS): boolean {
  const match = /^\$argon2id\$v=\d+\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(storedHash);
  if (match === null) return true;
  const [, memory, time, lanes] = match;
  return (
    Number(memory) < params.memoryCost ||
    Number(time) < params.timeCost ||
    Number(lanes) < params.parallelism
  );
}
