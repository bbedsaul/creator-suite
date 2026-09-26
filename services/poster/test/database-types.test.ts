/**
 * Guards that the generated database types are in sync with the schema.
 *
 * `database.types.ts` is generated from the local database, which means it can
 * silently go stale after a migration. These assertions are written against the
 * contract and DECISIONS rather than against the file, so a forgotten
 * `gen:types` shows up here instead of as a wrong type six sessions later.
 */
import { describe, expect, it } from 'vitest';
import { Constants, type Database } from '../src/db/database.types.js';

type TargetState = Database['poster']['Enums']['target_state'];
type ReasonClass = Database['poster']['Enums']['reason_class'];

describe('generated poster database types', () => {
  it('carries every target state from contract §6', () => {
    expect([...Constants.poster.Enums.target_state]).toEqual([
      'accepted',
      'scheduled',
      'dispatching',
      'posted',
      'failed',
      'paused',
      'canceled',
    ]);
  });

  it('carries the three contract reason classes plus the D-015 additions', () => {
    expect([...Constants.poster.Enums.reason_class]).toEqual([
      // contract §8
      'transient_exhausted',
      'platform_rejected',
      'token_revoked_expired',
      // additive under contract §10, recorded as D-015
      'grant_revoked',
      'rendition_failed',
      'dispatch_outcome_unknown',
    ]);
  });

  it('types a target row with the columns dispatch depends on', () => {
    // Compile-time assertion: these names and types must survive regeneration.
    type Target = Database['poster']['Tables']['post_targets']['Row'];
    const shape: Pick<
      Target,
      'state' | 'claimed_by' | 'claim_expires_at' | 'needs_reconciliation' | 'reason_class'
    > = {
      state: 'dispatching',
      claimed_by: 'worker-1',
      claim_expires_at: new Date().toISOString(),
      needs_reconciliation: false,
      reason_class: null,
    };
    expect(shape.state satisfies TargetState).toBe('dispatching');
    expect(shape.reason_class satisfies ReasonClass | null).toBeNull();
  });

  it('exposes the derived post_status view (contract §6)', () => {
    type PostStatus = Database['poster']['Views']['post_status']['Row'];
    const row: Pick<PostStatus, 'post_id' | 'state' | 'target_count'> = {
      post_id: '00000000-0000-0000-0000-000000000000',
      state: 'partial',
      target_count: 2,
    };
    expect(row.state).toBe('partial');
  });
});
