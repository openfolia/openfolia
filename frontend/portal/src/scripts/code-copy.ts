/**
 * The copy button on a manual's code blocks (#895). Each literal block is wrapped (so the
 * button stays in place while a long line scrolls) and gets a real button that puts the block's
 * text on the clipboard exactly as it is, answers with a check for a moment and a polite
 * "Copied". When the clipboard is refused it says so and selects the text for Ctrl+C. Without
 * script there is no button and the block reads as before.
 */
export interface CodeCopyTexts {
  readonly label: string;
  readonly copied: string;
  readonly failed: string;
  readonly failedHint: string;
}

const SHOWN_MS = 1500;
/** A refusal stays longer: the reader needs time to press the keys. */
const FAILED_MS = 4000;
const NS = 'http://www.w3.org/2000/svg';

const icon = (cls: string, paths: readonly string[]) => {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', `code-copy__icon ${cls}`);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.75');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  for (const d of paths) {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
};

function select(code: Element): void {
  const range = document.createRange();
  range.selectNodeContents(code);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

export function startCodeCopy(doc: Document): void {
  const body = doc.querySelector<HTMLElement>('[data-code-copy]');
  if (!body) return;
  let texts: CodeCopyTexts;
  try {
    texts = JSON.parse(body.dataset['codeCopy'] ?? '') as CodeCopyTexts;
  } catch {
    return;
  }
  for (const pre of body.querySelectorAll<HTMLElement>('pre.of-literal')) {
    const code = pre.querySelector('code') ?? pre;
    const wrap = doc.createElement('div');
    wrap.className = 'code-copy';
    pre.replaceWith(wrap);
    wrap.append(pre);

    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'code-copy__button';
    button.setAttribute('aria-label', texts.label);
    const note = doc.createElement('span');
    note.className = 'code-copy__note';
    note.setAttribute('aria-hidden', 'true');
    button.append(
      note,
      icon('code-copy__icon--copy', ['M9 9h10v11H9z', 'M5 15V4h10']),
      icon('code-copy__icon--done', ['m5 12.5 4.5 4.5L19 7.5']),
      icon('code-copy__icon--failed', ['M6.5 6.5l11 11M17.5 6.5l-11 11']),
    );
    const status = doc.createElement('span');
    status.className = 'visually-hidden';
    status.setAttribute('role', 'status');
    wrap.append(button, status);

    // A block that scrolls sideways takes the keyboard too, so its long lines can be read.
    new ResizeObserver(() => {
      if (pre.scrollWidth > pre.clientWidth) pre.tabIndex = 0;
      else pre.removeAttribute('tabindex');
    }).observe(pre);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const show = (state: 'copied' | 'failed', line: string, label: string) => {
      clearTimeout(timer);
      button.dataset['state'] = state;
      note.textContent = label;
      status.textContent = line;
      timer = setTimeout(
        () => {
          delete button.dataset['state'];
          note.textContent = '';
          status.textContent = '';
        },
        state === 'failed' ? FAILED_MS : SHOWN_MS,
      );
    };
    button.addEventListener('click', () => {
      const text = code.textContent ?? '';
      void (async () => {
        try {
          await navigator.clipboard.writeText(text);
          show('copied', texts.copied, texts.copied);
        } catch {
          select(code);
          show('failed', texts.failedHint, texts.failed);
        }
      })();
    });
  }
}
