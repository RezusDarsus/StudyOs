// Hint ladder: releases support rungs one at a time, in the backend's order, with the backend as
// the only authority on how many rungs exist and what each one reveals. The frontend never fakes
// a hint count or an answer.
window.StudyOSTutor = window.StudyOSTutor || {};

(function (Tutor) {
  'use strict';

  const { escapeHtml, percent, apiMessage } = window.StudyOSFormat;
  const UI = window.StudyOSUI;

  function rungElement(support) {
    const note = document.createElement('div');
    note.className = `support-note ${support.gated ? 'gated' : ''}`;
    const heading = document.createElement('strong');
    heading.textContent = support.gated
      ? 'Support locked'
      : `Support ${support.level} of ${support.totalLevels} · ${support.label || 'Hint'}`;
    const body = document.createElement('span');
    // Support content is model text: rendered through the safe markdown pipeline, never innerHTML.
    window.StudyOSChat?.appendRichInline?.(body, support.content || '');
    const footnote = document.createElement('small');
    footnote.textContent = support.gated
      ? (support.gateReason || 'This step does not allow more support.')
      : `This answer now counts at ${percent(support.evidenceWeight)} evidence weight`;
    note.append(heading, body, footnote);
    return note;
  }

  function createLadder(container, { workspaceId, itemId, initialLevel = 0, onRelease } = {}) {
    let level = initialLevel;
    const ladder = document.createElement('div');
    ladder.className = 'hint-ladder';
    container.append(ladder);

    function nextButton() {
      const button = document.createElement('button');
      button.className = 'text-button';
      button.type = 'button';
      button.textContent = level === 0 ? 'Need help?' : 'Next hint';
      button.addEventListener('click', () => release());
      return button;
    }

    let button = null;

    async function release() {
      const api = window.StudyOSApi;
      if (!itemId || !api) return null;
      if (button) button.disabled = true;
      const pending = document.createElement('div');
      pending.className = 'loading-state compact';
      pending.textContent = 'Releasing the next hint…';
      ladder.append(pending);
      try {
        const support = await api.getExerciseSupport(workspaceId, itemId, Math.min(9, level + 1));
        pending.remove();
        level = support.level;
        ladder.append(rungElement(support));
        // The backend decides whether another rung exists — the button says exactly what is next.
        if (onRelease) onRelease(support);
        if (support.nextLevel == null) {
          button?.remove();
          button = null;
          const exhausted = document.createElement('small');
          exhausted.className = 'ladder-exhausted';
          exhausted.textContent = support.revealsSolution ? 'Full solution revealed.' : 'All available support is shown.';
          ladder.append(exhausted);
        } else {
          if (!button) { button = nextButton(); ladder.append(button); }
          button.disabled = false;
          button.textContent = support.nextLevel >= support.totalLevels ? 'Show solution' : 'Next hint';
        }
        return support;
      } catch (error) {
        pending.remove();
        ladder.append(new DOMParser().parseFromString(UI.errorState(UI.friendlyError(error, apiMessage(error, 'StudyOS could not release a hint for this exercise.'))), 'text/html').body.firstElementChild || document.createTextNode(''));
        if (button) button.disabled = false;
        return null;
      }
    }

    return {
      get level() { return level; },
      release,
      attachTrigger() { if (!button) { button = nextButton(); ladder.append(button); } },
      dispose() { ladder.remove(); }
    };
  }

  Tutor.createHintLadder = createLadder;
})(window.StudyOSTutor);
