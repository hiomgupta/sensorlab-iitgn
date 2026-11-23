import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionBackupLabel, summarizeProfileSessions } from '../../src/ui/profile-view.js';

test('profile summary separates local, pending and backed-up sessions across browser accounts; recent list is bounded and non-mutating', () => {
    const sessions = [
        { sessionId: 'old', startedWall: '2026-11-20', cloudOwnerUid: 'a', cloudUploadedAt: '2026-11-21' },
        { sessionId: 'local', startedWall: '2026-11-21' },
        { sessionId: 'other-account', startedWall: '2026-11-22', cloudOwnerUid: 'b', cloudUploadedAt: null },
        { sessionId: 'waiting', startedWall: '2026-11-23', cloudOwnerUid: 'a', cloudUploadedAt: null },
        { sessionId: 'open', createdWall: '2026-11-24', state: 'open', cloudOwnerUid: 'a', cloudUploadedAt: null },
    ];
    const original = structuredClone(sessions);
    const summary = summarizeProfileSessions(sessions);
    assert.deepEqual({ total: summary.total, local: summary.localOnly, pending: summary.pending, backedUp: summary.backedUp }, { total: 5, local: 1, pending: 3, backedUp: 1 });
    assert.deepEqual(summary.recent.map(s => s.sessionId), ['open', 'waiting', 'other-account']);
    assert.deepEqual(sessions, original);
});

test('backup labels distinguish account ownership and active recordings rather than implying all history belongs to the signed-in user', () => {
    const pending = { cloudOwnerUid: 'a', state: 'closed' };
    assert.equal(sessionBackupLabel(pending, 'a'), 'Pending backup');
    assert.equal(sessionBackupLabel(pending, 'b'), 'Pending backup - another account');
    assert.equal(sessionBackupLabel(pending, null), 'Pending backup - owner sign-in needed');
    assert.equal(sessionBackupLabel({ ...pending, state: 'open' }, 'a'), 'Backup after Stop or recovery');
    assert.equal(sessionBackupLabel({ ...pending, cloudUploadedAt: '2026-11-24' }, 'b'), 'Backed up (another account)');
    assert.equal(sessionBackupLabel({ state: 'closed' }, 'a'), 'Local only');
});
