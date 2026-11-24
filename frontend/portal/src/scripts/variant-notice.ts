import { switchNoticeText, textsFor } from '../lib/i18n.ts';
import { CHANGED_PARAM, SWITCHED_PARAM } from '../lib/variant-switch.ts';

/**
 * The manual page after a variant switch that changed other attributes too (#844): the link
 * says so in its query (`?switched=body&changed=drive`, `src/lib/variant-switch.ts`), and the
 * page shows a notice by the switch that names what changed, read out politely. The query is
 * dropped from the address at once, so a reload, a shared link or Back shows the page plain.
 * Labels come from the page's own switch, never from the address; a query that names an
 * attribute the switch does not have shows nothing.
 */
export function showSwitchNotice(doc: Document): void {
  const url = new URL(doc.location.href);
  const switched = url.searchParams.get(SWITCHED_PARAM);
  const changed = url.searchParams.get(CHANGED_PARAM);
  if (switched === null && changed === null) return;
  url.searchParams.delete(SWITCHED_PARAM);
  url.searchParams.delete(CHANGED_PARAM);
  history.replaceState(history.state, '', url);

  const notice = doc.querySelector<HTMLElement>('[data-switch-notice]');
  const text = notice?.querySelector<HTMLElement>('[data-switch-notice-text]');
  const status = doc.querySelector<HTMLElement>('[data-switch-status]');
  const close = notice?.querySelector<HTMLButtonElement>(
    '[data-switch-notice-close]',
  );
  if (!notice || !text || !status || !close || !switched || !changed) return;

  const choices = new Map(
    [...doc.querySelectorAll<HTMLElement>('[data-variant-attribute]')].map(
      (choice) => [choice.dataset['variantAttribute'], choice],
    ),
  );
  const currentOf = (attribute: string) =>
    choices
      .get(attribute)
      ?.querySelector<HTMLElement>('a[aria-current="true"]') ?? undefined;
  const ids = changed.split(',');
  if (
    new Set(ids).size !== ids.length ||
    ids.includes(switched) ||
    ![switched, ...ids].every((id) => currentOf(id)?.dataset['label'])
  )
    return;

  const lang = doc.documentElement.lang;
  const message = switchNoticeText(
    textsFor(lang),
    lang,
    currentOf(switched)?.dataset['label'] ?? '',
    ids.map((id) => ({
      attribute: choices.get(id)?.dataset['label'] ?? id,
      value: currentOf(id)?.dataset['label'] ?? '',
    })),
  );
  text.textContent = message;
  notice.hidden = false;
  // Shown on the next frame, so it fades in; read out once the page has settled.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => notice.classList.add('is-open')),
  );
  const announce = setTimeout(() => (status.textContent = message), 400);

  let open = true;
  const dismiss = () => {
    if (!open) return;
    open = false;
    clearTimeout(announce);
    status.textContent = '';
    const hadFocus = notice.contains(doc.activeElement);
    notice.classList.remove('is-open');
    // Back to the switch the reader used, rather than to the top of the page.
    if (hadFocus) currentOf(switched)?.focus();
    const done = () => (notice.hidden = true);
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) done();
    else setTimeout(done, 200);
  };
  close.addEventListener('click', dismiss);
  notice.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') dismiss();
  });
}
