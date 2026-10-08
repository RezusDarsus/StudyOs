// View router: owns which panel is visible and which per-view refresh runs on entry. Replaces the
// bare class-toggle switch so navigation can also trigger data loads and stop background work.
window.StudyOSRouter = window.StudyOSRouter || {};

(function (Router) {
  'use strict';

  const handlers = new Map();
  let current = 'today';

  function showView(view, options = {}) {
    const known = document.querySelector(`[data-view-panel="${view}"]`);
    if (!known) return current;
    const changed = window.StudyOSState?.setRoute(view) || current !== view;
    current = view;
    document.querySelectorAll('[data-view-panel]').forEach(panel => panel.classList.toggle('hidden', panel.dataset.viewPanel !== view));
    document.querySelectorAll('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.view === view));
    closeMobileNavigation();
    if (!options.silent) window.scrollTo({ top: 0, behavior: 'smooth' });
    const handler = handlers.get(view);
    if (handler && (changed || options.force)) { try { handler(); } catch (error) { console.error(`View handler for ${view} failed`, error); } }
    return current;
  }

  /** Registers a per-view refresh hook, run when the view becomes active. */
  function onShow(view, handler) { handlers.set(view, handler); }

  function currentView() { return current; }

  function closeMobileNavigation() {
    const sidebar = document.querySelector('.sidebar');
    const button = document.querySelector('#mobileNavButton');
    sidebar?.classList.remove('mobile-open');
    button?.setAttribute('aria-expanded', 'false');
    button?.setAttribute('aria-label', 'Open navigation');
  }

  function toggleMobileNavigation() {
    const sidebar = document.querySelector('.sidebar');
    const button = document.querySelector('#mobileNavButton');
    const open = sidebar?.classList.toggle('mobile-open');
    button?.setAttribute('aria-expanded', String(Boolean(open)));
    button?.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
  }

  Router.showView = showView;
  Router.onShow = onShow;
  Router.currentView = currentView;
  Router.toggleMobileNavigation = toggleMobileNavigation;
  Router.closeMobileNavigation = closeMobileNavigation;
})(window.StudyOSRouter);
