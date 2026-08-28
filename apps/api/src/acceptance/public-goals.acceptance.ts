import { describe, expect, it } from 'vitest';
import { useHarness } from './harness.js';

const h = useHarness();

describe('public goal discovery', () => {
  it('shows a newly created public goal to another account', async () => {
    const owner = await h.createUser({ name: 'Goal Owner' });
    const viewer = await h.createUser({ name: 'Goal Viewer' });

    const { goal } = await h.ok<{ goal: { id: string } }>(owner, 'POST', '/api/goals', {
      title: 'Public study challenge',
      description: 'Study together',
      category: 'LEARNING',
      visibility: 'PUBLIC',
      targetType: 'HABIT',
      tasks: [],
    });

    const discover = await h.ok<{ challenges: Array<{ id: string }> }>(
      viewer,
      'GET',
      '/api/discover',
    );

    expect(discover.challenges.map((challenge) => challenge.id)).toContain(goal.id);
  });
});
