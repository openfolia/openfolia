// Before the page paints: the visitor's theme (their choice on this page, else their system's), so
// a dark visitor never sees a light flash. Then, on every launcher page, the toggle: the choice is
// kept on this device; without one, the system's follows.
{
  let chosen = null;
  try {
    chosen = localStorage.getItem('openfolia-demo-theme');
  } catch {
    // No storage (a private window): the system's theme, and the toggle works for the visit.
  }
  const dark = chosen
    ? chosen === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  if (dark) document.documentElement.classList.add('dark');
}

function storedTheme() {
  try {
    return localStorage.getItem('openfolia-demo-theme');
  } catch {
    return null;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const root = document.documentElement;
  const toggle = document.querySelector('[data-theme-toggle]');
  if (!toggle) return;
  const dark = () => root.classList.contains('dark');
  const label = () =>
    toggle.setAttribute(
      'aria-label',
      dark() ? toggle.dataset.labelLight : toggle.dataset.labelDark,
    );
  toggle.hidden = false;
  label();
  toggle.addEventListener('click', () => {
    root.classList.toggle('dark');
    label();
    try {
      localStorage.setItem('openfolia-demo-theme', dark() ? 'dark' : 'light');
    } catch {
      // Not kept: fine for this visit.
    }
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener(
    'change',
    (event) => {
      if (storedTheme()) return;
      root.classList.toggle('dark', event.matches);
      label();
    },
  );
});
