import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Landing from './Landing';

let enterViewport: IntersectionObserverCallback;
let preferenceChanged: () => void;
let reduced = false;
let play: ReturnType<typeof vi.spyOn>;
let pause: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  reduced = false;
  vi.stubGlobal('matchMedia', () => ({
    get matches() { return reduced; },
    addEventListener: (_: string, callback: () => void) => { preferenceChanged = callback; },
    removeEventListener: vi.fn(),
  }));
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: IntersectionObserverCallback) { enterViewport = callback; }
    observe() {} disconnect() {}
  });
  play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function(this: HTMLMediaElement) {
    this.dispatchEvent(new Event('play'));
    return Promise.resolve();
  });
  pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function(this: HTMLMediaElement) {
    this.dispatchEvent(new Event('pause'));
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function mount() { return render(<MemoryRouter><Landing /></MemoryRouter>); }

describe('Landing product examples', () => {
  it('updates and reverses the continuity demonstration without an API request', async () => {
    const request = vi.fn(); vi.stubGlobal('fetch', request);
    mount(); const user = userEvent.setup();
    expect(screen.getByText('0 of 3 complete · 3 left')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try marking complete' }));
    expect(screen.getByText('1 of 3 complete · 2 left')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Completed · undo' }));
    expect(screen.getByText('0 of 3 complete · 3 left')).toBeInTheDocument();
    expect(request).not.toHaveBeenCalled();
  });
  it('opens the example review and labels it as unsaved', async () => {
    mount(); await userEvent.click(screen.getByRole('button', { name: 'Review this example' }));
    expect(screen.getByRole('button', { name: 'Close example review' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/Nothing here changes an account/)).toBeInTheDocument();
    expect(screen.queryByText('114 web tests passed')).not.toBeInTheDocument();
  });
  it('does not autoplay when reduced motion is requested, including changes at runtime', () => {
    reduced = true; mount();
    enterViewport([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    expect(play).not.toHaveBeenCalled();
    preferenceChanged();
    expect(pause).toHaveBeenCalled();
  });
  it('pauses when the product film leaves the viewport', () => {
    mount();
    enterViewport([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver);
    expect(pause).toHaveBeenCalled();
    expect(document.querySelector('video')).not.toHaveAttribute('loop');
  });
  it('lets visitors explore all film chapters without contacting the backend', async () => {
    const request = vi.fn(); vi.stubGlobal('fetch', request);
    mount(); const user = userEvent.setup();
    for (const [button, heading] of [
      ['01 Set a goal', 'Make room for what matters.'],
      ['02 Shape a plan', 'A big goal. A small first step.'],
      ['03 Take action', 'Today has a clear next move.'],
      ['04 Grow together', 'Your pace. A little company.'],
    ]) {
      await user.click(screen.getByRole('button', { name: button }));
      expect(screen.getAllByRole('heading', { name: heading }).length).toBeGreaterThan(0);
      expect(screen.getByRole('button', { name: button })).toHaveAttribute('aria-pressed', 'true');
    }
    await user.click(screen.getByRole('button', { name: 'Back to film' }));
    expect(document.querySelector('video source')).toHaveAttribute('src', '/assets/oneup-product-film.mp4');
    expect(request).not.toHaveBeenCalled();
  });
  it('offers the readable product story when video fails', () => {
    mount(); fireEvent.error(document.querySelector('video')!);
    expect(screen.getAllByRole('heading', { name: 'Make room for what matters.' }).length).toBeGreaterThan(0);
  });
});
