// The portal's light and dark mode, before the page paints (a file, not inline script, so the
// Content Security Policy needs no 'unsafe-inline'). The reader's choice is kept in this
// browser only; without one, the system's setting applies and is followed when it changes.
(function () {
  const KEY = 'of-portal-theme';
  const root = document.documentElement;
  // Script runs: what only works with it (the update guide's pickers, #907) may show at once.
  root.classList.add('has-script');
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  function saved() {
    try {
      const value = localStorage.getItem(KEY);
      return value === 'dark' || value === 'light' ? value : null;
    } catch {
      return null;
    }
  }
  function apply(dark) {
    root.classList.toggle('dark', dark);
    root.style.colorScheme = dark ? 'dark' : 'light';
    const button = document.querySelector('[data-theme-toggle]');
    if (button) button.setAttribute('aria-pressed', String(dark));
  }
  const choice = saved();
  apply(choice ? choice === 'dark' : media.matches);
  media.addEventListener('change', function (event) {
    if (!saved()) apply(event.matches);
  });
  document.addEventListener('DOMContentLoaded', function () {
    const button = document.querySelector('[data-theme-toggle]');
    if (!button) return;
    button.hidden = false;
    apply(root.classList.contains('dark'));
    button.addEventListener('click', function () {
      const dark = !root.classList.contains('dark');
      try {
        localStorage.setItem(KEY, dark ? 'dark' : 'light');
      } catch {
        // Not kept (a private window): it still applies to this page.
      }
      // A cross-fade between the two, where the browser has one and the reader wants motion.
      const still = window.matchMedia(
        '(prefers-reduced-motion: reduce)',
      ).matches;
      if (document.startViewTransition && !still) {
        root.classList.add('theme-fading');
        const fade = document.startViewTransition(function () {
          apply(dark);
        });
        fade.finished.finally(function () {
          root.classList.remove('theme-fading');
        });
      } else apply(dark);
    });
  });
})();
