import { describe, expect, it } from 'vitest';
import { isProductHelpRequest } from './copilot-intent';

describe('isProductHelpRequest', () => {
  it.each([
    'How do I log out?',
    'Where can I delete my account?',
    'Can I export my data?',
    'contact support',
    'show me the privacy policy',
  ])('routes %s to product help', (message) => {
    expect(isProductHelpRequest(message)).toBe(true);
  });

  it.each(['I want to save for a trip', 'Run three times a week', 'Read the terms in my contract']) (
    'leaves %s as a goal request',
    (message) => expect(isProductHelpRequest(message)).toBe(false),
  );
});
