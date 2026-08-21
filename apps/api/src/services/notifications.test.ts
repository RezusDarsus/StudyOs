import { describe, expect, it, vi } from 'vitest';
import { NOTIFICATION_TYPE, SCHEDULED_NOTIFICATION_TYPE } from '../domain/enums.js';

// notify() and alreadySent() talk to the database; the two decisions worth pinning
// down here do not. Stubbing the client keeps this a unit test rather than one that
// needs a live PostgreSQL and a user row to say anything about muting.
vi.mock('../lib/prisma.js', () => ({ prisma: {} }));

const { dedupeKeyFor, isMuted } = await import('./notifications.js');

const allOn = {
  notifyTaskReminders: true,
  notifyFriendActivity: true,
  notifyLeaderboardUpdate: true,
  notifyAchievements: true,
  notifyMorningSummary: true,
  notifyEveningCheck: true,
};

describe('notification muting', () => {
  it('lets everything through when every toggle is on', () => {
    for (const type of NOTIFICATION_TYPE) {
      expect(isMuted(type, allOn), type).toBe(false);
    }
  });

  it('silences exactly the type whose toggle is off', () => {
    expect(isMuted('MORNING_SUMMARY', { ...allOn, notifyMorningSummary: false })).toBe(true);
    // Turning the morning one off says nothing about the evening one — the whole
    // reason they are separate columns.
    expect(isMuted('EVENING_INCOMPLETE', { ...allOn, notifyMorningSummary: false })).toBe(false);
    expect(isMuted('EVENING_INCOMPLETE', { ...allOn, notifyEveningCheck: false })).toBe(true);
    expect(isMuted('REMINDER', { ...allOn, notifyTaskReminders: false })).toBe(true);
    expect(isMuted('FRIEND', { ...allOn, notifyFriendActivity: false })).toBe(true);
    expect(isMuted('LEADERBOARD', { ...allOn, notifyLeaderboardUpdate: false })).toBe(true);
    expect(isMuted('ACHIEVEMENT', { ...allOn, notifyAchievements: false })).toBe(true);
  });

  it('never mutes PROGRESS, whatever the profile says', () => {
    const allOff = {
      notifyTaskReminders: false,
      notifyFriendActivity: false,
      notifyLeaderboardUpdate: false,
      notifyAchievements: false,
      notifyMorningSummary: false,
      notifyEveningCheck: false,
    };
    expect(isMuted('PROGRESS', allOff)).toBe(false);
  });

  it('treats a missing profile as no preferences expressed, not as silence', () => {
    // A user with no Profile row is a data problem, not a user who asked for quiet.
    for (const type of NOTIFICATION_TYPE) {
      expect(isMuted(type, null), type).toBe(false);
    }
  });

  it('covers every notification type, so a new one cannot slip through unconsidered', () => {
    // MUTED_BY is a Record over NOTIFICATION_TYPE, so adding a type without deciding
    // its toggle fails to compile. This asserts the runtime list is what we think.
    expect([...NOTIFICATION_TYPE].sort()).toEqual(
      [
        'ACHIEVEMENT',
        'EVENING_INCOMPLETE',
        'FRIEND',
        'LEADERBOARD',
        'MORNING_SUMMARY',
        'PROGRESS',
        'REMINDER',
      ].sort(),
    );
  });
});

describe('scheduled notification dedupe keys', () => {
  it('is userId:TYPE:localDate', () => {
    expect(dedupeKeyFor('user_123', 'MORNING_SUMMARY', '2026-08-21')).toBe(
      'user_123:MORNING_SUMMARY:2026-08-21',
    );
    expect(dedupeKeyFor('user_123', 'EVENING_INCOMPLETE', '2026-08-21')).toBe(
      'user_123:EVENING_INCOMPLETE:2026-08-21',
    );
  });

  it('separates the two jobs, the two days and the two users', () => {
    const keys = new Set([
      dedupeKeyFor('a', 'MORNING_SUMMARY', '2026-08-21'),
      dedupeKeyFor('a', 'EVENING_INCOMPLETE', '2026-08-21'),
      dedupeKeyFor('a', 'MORNING_SUMMARY', '2026-08-22'),
      dedupeKeyFor('b', 'MORNING_SUMMARY', '2026-08-21'),
    ]);
    expect(keys.size).toBe(4);
  });

  it('is stable, so a retry of the same job produces the same key', () => {
    // The unique index is only a guarantee if the key does not depend on when it
    // was computed. Nothing in here reads the clock.
    expect(dedupeKeyFor('a', 'MORNING_SUMMARY', '2026-08-21')).toBe(
      dedupeKeyFor('a', 'MORNING_SUMMARY', '2026-08-21'),
    );
  });

  it('only the two job-produced types are deduplicated', () => {
    expect([...SCHEDULED_NOTIFICATION_TYPE]).toEqual(['MORNING_SUMMARY', 'EVENING_INCOMPLETE']);
    // Three friend requests in a day are three notifications, not one.
    for (const type of SCHEDULED_NOTIFICATION_TYPE) {
      expect(NOTIFICATION_TYPE).toContain(type);
    }
  });
});
