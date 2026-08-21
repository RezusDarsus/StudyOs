import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import QuestionInput from './QuestionInput';
import type { CopilotQuestion } from '../lib/types';

// Parts 4 and 50 of the Phase 2.5 plan. The bug being protected against: rapidly
// selecting Walking then Swimming submitted only one of them, because a stale
// React closure overwrote the first value. These tests drive the real component,
// not a reducer, because that is the only way the regression is observable.

const multiSelect: CopilotQuestion = {
  id: 'enjoyed_activities',
  type: 'MULTI_SELECT',
  prompt: 'Which activities do you enjoy?',
  options: ['Walking', 'Swimming', 'Gym', 'Dancing', 'Cycling'],
  allowCustomAnswer: true,
  optional: false,
};

function renderQuestion(question: CopilotQuestion = multiSelect) {
  const onAnswer = vi.fn();
  render(<QuestionInput question={question} disabled={false} onAnswer={onAnswer} />);
  return { onAnswer, user: userEvent.setup() };
}

describe('MULTI_SELECT', () => {
  it('keeps every value when options are selected in quick succession', async () => {
    const { onAnswer, user } = renderQuestion();

    await user.click(screen.getByRole('button', { name: 'Walking' }));
    await user.click(screen.getByRole('button', { name: 'Swimming' }));
    await user.click(screen.getByRole('button', { name: 'Dancing' }));

    // Nothing is submitted on click — only Continue sends.
    expect(onAnswer).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /Continue/ }));
    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer.mock.calls[0][0]).toEqual(['Walking', 'Swimming', 'Dancing']);
  });

  it('marks selected options as pressed', async () => {
    const { user } = renderQuestion();
    const walking = screen.getByRole('button', { name: 'Walking' });

    expect(walking).toHaveAttribute('aria-pressed', 'false');
    await user.click(walking);
    expect(walking).toHaveAttribute('aria-pressed', 'true');
  });

  it('deselects on a second tap and leaves the others alone', async () => {
    const { onAnswer, user } = renderQuestion();

    await user.click(screen.getByRole('button', { name: 'Walking' }));
    await user.click(screen.getByRole('button', { name: 'Swimming' }));
    await user.click(screen.getByRole('button', { name: 'Walking' }));

    await user.click(screen.getByRole('button', { name: /Continue/ }));
    expect(onAnswer.mock.calls[0][0]).toEqual(['Swimming']);
  });

  it('keeps Continue disabled until something is chosen', async () => {
    const { user } = renderQuestion();
    const cont = screen.getByRole('button', { name: /Continue/ });

    expect(cont).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Gym' }));
    expect(cont).toBeEnabled();
  });

  it('appends a custom "Other" value to the checked options', async () => {
    // Part 4.3: Walking + Swimming + typed "Boxing" must all three arrive.
    const { onAnswer, user } = renderQuestion();

    await user.click(screen.getByRole('button', { name: 'Walking' }));
    await user.click(screen.getByRole('button', { name: 'Swimming' }));
    await user.type(screen.getByLabelText('Other answer'), 'Boxing');
    await user.click(screen.getByRole('button', { name: /Continue/ }));

    expect(onAnswer.mock.calls[0][0]).toEqual(['Walking', 'Swimming', 'Boxing']);
  });

  it('does not discard checked options when Enter is pressed in the Other field', async () => {
    // The regression this replaces: Enter submitted only the typed text.
    const { onAnswer, user } = renderQuestion();

    await user.click(screen.getByRole('button', { name: 'Walking' }));
    await user.type(screen.getByLabelText('Other answer'), 'Boxing{Enter}');

    expect(onAnswer.mock.calls[0][0]).toEqual(['Walking', 'Boxing']);
  });

  it('accepts a slash inside a custom answer', async () => {
    const { onAnswer, user } = renderQuestion();

    await user.type(screen.getByLabelText('Other answer'), 'walking/running{Enter}');
    expect(onAnswer.mock.calls[0][0]).toEqual(['walking/running']);
  });
});

describe('SINGLE_SELECT', () => {
  const single: CopilotQuestion = { ...multiSelect, type: 'SINGLE_SELECT', id: 'one' };

  it('submits immediately on the first click', async () => {
    const { onAnswer, user } = renderQuestion(single);

    await user.click(screen.getByRole('button', { name: 'Swimming' }));
    expect(onAnswer).toHaveBeenCalledWith('Swimming', 'Swimming');
  });

  it('has no Continue button', () => {
    renderQuestion(single);
    expect(screen.queryByRole('button', { name: /Continue/ })).toBeNull();
  });
});

describe('FREE_TEXT — slashes are ordinary characters', () => {
  const freeText: CopilotQuestion = {
    id: 'availability',
    type: 'FREE_TEXT',
    prompt: 'When are you free?',
    allowCustomAnswer: false,
    optional: false,
  };

  it('sends text containing slashes verbatim', async () => {
    const { onAnswer, user } = renderQuestion(freeText);

    const answer = 'I can exercise 5/7 days and prefer walking/swimming.';
    await user.type(screen.getByLabelText('When are you free?'), answer);
    await user.click(screen.getByRole('button', { name: 'Send answer' }));

    expect(onAnswer).toHaveBeenCalledWith(answer, answer);
  });

  it('enables Send for a lone slash', async () => {
    const { onAnswer, user } = renderQuestion(freeText);

    await user.type(screen.getByLabelText('When are you free?'), '/');
    const send = screen.getByRole('button', { name: 'Send answer' });
    expect(send).toBeEnabled();

    await user.click(send);
    expect(onAnswer).toHaveBeenCalledWith('/', '/');
  });

  it('keeps Send disabled while empty', () => {
    renderQuestion(freeText);
    expect(screen.getByRole('button', { name: 'Send answer' })).toBeDisabled();
  });
});

describe('NUMBER — a number question still accepts an answer in words', () => {
  const number: CopilotQuestion = {
    id: 'minutes_per_session',
    type: 'NUMBER',
    prompt: 'How many minutes per session?',
    allowCustomAnswer: false,
    optional: false,
  };

  const field = () => screen.getByLabelText('How many minutes per session?');

  it('sends a plain number as a number', async () => {
    const { onAnswer, user } = renderQuestion(number);

    await user.type(field(), '40');
    await user.click(screen.getByRole('button', { name: 'Send answer' }));

    expect(onAnswer).toHaveBeenCalledWith(40, '40');
  });

  it('keeps a slashed answer instead of swallowing it', async () => {
    // The reported bug. As type="number" the field silently discarded anything
    // containing "/" — the text never arrived, so Send stayed greyed out with
    // nothing on screen to explain why.
    const { onAnswer, user } = renderQuestion(number);

    await user.type(field(), '5/7');
    expect(field()).toHaveValue('5/7');

    const send = screen.getByRole('button', { name: 'Send answer' });
    expect(send).toBeEnabled();

    await user.click(send);
    // Sent as text, because "5/7" is not a number. Number() would make it NaN,
    // which reaches the backend as null and loses the answer entirely.
    expect(onAnswer).toHaveBeenCalledWith('5/7', '5/7');
  });

  it('sends a hedged answer as the words the user typed', async () => {
    const { onAnswer, user } = renderQuestion(number);

    await user.type(field(), 'about 40{Enter}');
    expect(onAnswer).toHaveBeenCalledWith('about 40', 'about 40');
  });

  it('keeps a decimal a number', async () => {
    const { onAnswer, user } = renderQuestion(number);

    await user.type(field(), '2.5{Enter}');
    expect(onAnswer).toHaveBeenCalledWith(2.5, '2.5');
  });
});

describe('DAYS_OF_WEEK', () => {
  const days: CopilotQuestion = {
    id: 'which_days',
    type: 'DAYS_OF_WEEK',
    prompt: 'Which days?',
    allowCustomAnswer: false,
    optional: false,
  };

  it('accumulates several days before submitting', async () => {
    const { onAnswer, user } = renderQuestion(days);

    await user.click(screen.getByRole('button', { name: 'Mon' }));
    await user.click(screen.getByRole('button', { name: 'Wed' }));
    await user.click(screen.getByRole('button', { name: 'Fri' }));
    await user.click(screen.getByRole('button', { name: /Continue/ }));

    expect(onAnswer.mock.calls[0][0]).toEqual(['Mon', 'Wed', 'Fri']);
  });
});
