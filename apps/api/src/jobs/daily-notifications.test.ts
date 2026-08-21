import { describe, expect, it, vi } from 'vitest';
import { dayInTimezone, timeInTimezone } from '../domain/dates.js';

// runDailyNotifications() needs a database and a logger; the delivery window does not,
// and it is the rule that decides whether anyone is woken at 3am.
vi.mock('../lib/prisma.js', () => ({ prisma: {} }));

const { isWithinWindow } = await import('./daily-notifications.js');

describe('delivery windows', () => {
  it('opens exactly at the chosen time', () => {
    expect(isWithinWindow('07:59', '08:00', 'MORNING_SUMMARY')).toBe(false);
    expect(isWithinWindow('08:00', '08:00', 'MORNING_SUMMARY')).toBe(true);
    expect(isWithinWindow('08:01', '08:00', 'MORNING_SUMMARY')).toBe(true);
  });

  it('stays open while the notification is still worth sending', () => {
    // A plan for the day is still a plan at 11:59; at noon the morning is over.
    expect(isWithinWindow('11:59', '08:00', 'MORNING_SUMMARY')).toBe(true);
    expect(isWithinWindow('12:00', '08:00', 'MORNING_SUMMARY')).toBe(false);
    expect(isWithinWindow('14:00', '08:00', 'MORNING_SUMMARY')).toBe(false);
  });

  it('closes the evening nudge before bedtime', () => {
    expect(isWithinWindow('20:30', '20:30', 'EVENING_INCOMPLETE')).toBe(true);
    expect(isWithinWindow('22:59', '20:30', 'EVENING_INCOMPLETE')).toBe(true);
    expect(isWithinWindow('23:00', '20:30', 'EVENING_INCOMPLETE')).toBe(false);
    expect(isWithinWindow('23:45', '20:30', 'EVENING_INCOMPLETE')).toBe(false);
  });

  it('never wraps past midnight into the next local day', () => {
    // A late evening time truncates at midnight rather than reaching into tomorrow:
    // 00:30 belongs to a new local date, and therefore to a different notification.
    expect(isWithinWindow('23:30', '23:00', 'EVENING_INCOMPLETE')).toBe(true);
    expect(isWithinWindow('00:30', '23:00', 'EVENING_INCOMPLETE')).toBe(false);
    expect(isWithinWindow('01:00', '23:00', 'EVENING_INCOMPLETE')).toBe(false);
    // Nor does a very early morning time catch the tail of the previous night.
    expect(isWithinWindow('23:50', '00:05', 'MORNING_SUMMARY')).toBe(false);
    expect(isWithinWindow('00:05', '00:05', 'MORNING_SUMMARY')).toBe(true);
  });

  it('respects a time the user chose rather than the default', () => {
    expect(isWithinWindow('06:15', '06:15', 'MORNING_SUMMARY')).toBe(true);
    expect(isWithinWindow('06:14', '06:15', 'MORNING_SUMMARY')).toBe(false);
    expect(isWithinWindow('10:14', '06:15', 'MORNING_SUMMARY')).toBe(true);
    expect(isWithinWindow('10:15', '06:15', 'MORNING_SUMMARY')).toBe(false);
  });

  it('lets a five-minute tick hit every window it should', () => {
    // The cron runs at :00, :05, :10 … so a chosen time never falls between ticks in a
    // way that skips it. This is the property that makes tick frequency a latency
    // choice and not a correctness one.
    for (const chosen of ['08:00', '08:03', '08:59', '20:30', '23:00']) {
      const hits = [];
      for (let minute = 0; minute < 24 * 60; minute += 5) {
        const local = `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
        if (isWithinWindow(local, chosen, 'MORNING_SUMMARY')) hits.push(local);
      }
      expect(hits.length, chosen).toBeGreaterThan(0);
      // First hit is never more than five minutes after the chosen time.
      expect(hits[0] >= chosen, `${chosen} -> ${hits[0]}`).toBe(true);
    }
  });
});

describe('the timezone a window is measured in', () => {
  // Not a test of isWithinWindow so much as of the pairing the tick relies on: one
  // instant, two users, two verdicts.
  const instant = new Date('2026-08-21T04:02:00Z');

  it('fires for the user whose local clock says 08:00, not the server\'s', () => {
    const tbilisi = timeInTimezone(instant, 'Asia/Tbilisi'); // 08:02
    const london = timeInTimezone(instant, 'Europe/London'); // 05:02
    expect(isWithinWindow(tbilisi, '08:00', 'MORNING_SUMMARY')).toBe(true);
    expect(isWithinWindow(london, '08:00', 'MORNING_SUMMARY')).toBe(false);
  });

  it('dates the notification by the recipient, so neighbours across midnight differ', () => {
    // 20:10 UTC: already the 22nd in Tbilisi, still the 21st in London. Two users with
    // the same evening time get keys for different days — as they should.
    const evening = new Date('2026-08-21T20:10:00Z');
    expect(dayInTimezone(evening, 'Asia/Tbilisi')).toBe('2026-08-22');
    expect(dayInTimezone(evening, 'Europe/London')).toBe('2026-08-21');
    // And only the London user is inside the 20:30 window — Tbilisi is at 00:10.
    expect(isWithinWindow(timeInTimezone(evening, 'Europe/London'), '20:30', 'EVENING_INCOMPLETE')).toBe(
      true,
    );
    expect(
      isWithinWindow(timeInTimezone(evening, 'Asia/Tbilisi'), '20:30', 'EVENING_INCOMPLETE'),
    ).toBe(false);
  });
});
