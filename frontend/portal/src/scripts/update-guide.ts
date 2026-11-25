import {
  type Condition,
  resolveUpdateGuide,
  type UpdatePhase,
} from '@openfolia/content-model/core';
import type { GuideConfig } from '../lib/i18n.ts';
import {
  choiceForStep,
  choiceQuery,
  type FullChoice,
  type GuideShape,
  parseChoice,
} from '../lib/update-guide.ts';

/**
 * An update guide's page (#907): the page holds every step, grouped by version (what it shows
 * without script). This moves them into the three phases, shows those of the reader's choice
 * (`resolveUpdateGuide`, the content model's), keeps the choice in the address and the ticked
 * steps in this browser (per guide and range), and says how many steps there are, politely.
 */

type Config = GuideConfig & GuideShape;

interface Step {
  readonly el: HTMLLIElement;
  readonly id: string;
  readonly version: string;
  readonly phase: UpdatePhase;
  readonly level: string | undefined;
  readonly when: Condition | undefined;
  readonly check: HTMLInputElement | null;
}

const STORE = 'of-portal-guide';

/** The ticked steps of a range, as this browser keeps them; none when storage is refused. */
function readDone(key: string): Set<string> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    return new Set(
      Array.isArray(value)
        ? value.filter((v): v is string => typeof v === 'string')
        : [],
    );
  } catch {
    return new Set();
  }
}

function writeDone(key: string, done: ReadonlySet<string>): void {
  try {
    if (done.size === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify([...done]));
  } catch {
    // Not kept (a private window, storage full): the ticks still hold on this page.
  }
}

/** A hash as text; one that is not valid percent-encoding names nothing. */
function decoded(hash: string): string {
  try {
    return decodeURIComponent(hash);
  } catch {
    return '';
  }
}

/**
 * Starts the page. Whatever happens, the steps are shown at the end: on a failure the page falls
 * back to what it is without script (the pickers and the checklist hidden, every step listed).
 */
export function startUpdateGuide(doc: Document): void {
  const root = doc.querySelector<HTMLElement>('[data-update-guide]');
  if (!root) return;
  try {
    start(doc, root);
  } catch (error) {
    // The steps may already be filtered: show them all again, as without script.
    for (const el of root.querySelectorAll<HTMLElement>(
      '[data-step], [data-phase-section], [data-guide-phases]',
    ))
      el.hidden = false;
    doc.documentElement.classList.remove('has-script');
    throw error;
  } finally {
    root.dataset['ready'] = '';
  }
}

function start(doc: Document, root: HTMLElement): void {
  const config = JSON.parse(root.dataset['updateGuide'] ?? '{}') as Config;
  const form = root.querySelector<HTMLFormElement>('[data-guide-picker]')!;
  const fromSelect =
    form.querySelector<HTMLSelectElement>('[data-guide-from]')!;
  const toSelect = form.querySelector<HTMLSelectElement>('[data-guide-to]')!;
  const levelSelect =
    form.querySelector<HTMLSelectElement>('[data-guide-level]');
  const optionInputs = [
    ...form.querySelectorAll<HTMLSelectElement>('[data-guide-option]'),
  ];
  const whole = root.querySelector<HTMLElement>('[data-guide-whole]')!;
  const phasesBox = root.querySelector<HTMLElement>('[data-guide-phases]')!;
  const empty = root.querySelector<HTMLElement>('[data-guide-empty]')!;
  const emptyText = root.querySelector<HTMLElement>('[data-guide-empty-text]')!;
  const count = root.querySelector<HTMLElement>('[data-guide-count]')!;
  const doneLine = root.querySelector<HTMLElement>('[data-guide-done]')!;
  const meter = root.querySelector<HTMLElement>('[data-guide-meter]')!;
  const reset = root.querySelector<HTMLButtonElement>('[data-guide-reset]')!;
  const range = root.querySelector<HTMLElement>('[data-guide-range]')!;
  const number = new Intl.NumberFormat(config.lang);
  const plural = new Intl.PluralRules(config.lang);

  // Every step, in the whole guide's order (version, phase, manifest), into its phase's list:
  // each phase then holds its steps by version, then manifest order, as resolving orders them.
  const steps: Step[] = [
    ...whole.querySelectorAll<HTMLLIElement>('li[data-step]'),
  ].map((el) => ({
    el,
    id: el.dataset['step'] ?? '',
    version: el.dataset['version'] ?? '',
    phase: (el.dataset['phase'] ?? 'during') as UpdatePhase,
    level: el.dataset['level'],
    when:
      el.dataset['when'] === undefined
        ? undefined
        : (JSON.parse(el.dataset['when']) as Condition),
    check: el.querySelector<HTMLInputElement>('[data-step-check]'),
  }));
  const lists = new Map<string, HTMLOListElement>();
  for (const list of phasesBox.querySelectorAll<HTMLOListElement>(
    '[data-phase-list]',
  ))
    lists.set(list.dataset['phaseList'] ?? '', list);
  for (const step of steps) lists.get(step.phase)?.append(step.el);
  whole.remove();
  phasesBox.hidden = false;

  const read = (): FullChoice => ({
    from: fromSelect.value,
    to: toSelect.value,
    level: levelSelect?.value ?? config.levels[0],
    // An option not set is absent: a condition on it is false.
    options: Object.fromEntries(
      optionInputs
        .filter((input) => input.value !== '')
        .map((input) => [input.dataset['guideOption'] ?? '', input.value]),
    ),
  });

  const show = (choice: FullChoice) => {
    fromSelect.value = choice.from;
    toSelect.value = choice.to;
    if (levelSelect && choice.level !== undefined)
      levelSelect.value = choice.level;
    for (const input of optionInputs)
      input.value = choice.options[input.dataset['guideOption'] ?? ''] ?? '';
  };

  /** "To" offers only the versions after "from". */
  const limitTo = () => {
    const from = config.versions.indexOf(fromSelect.value);
    for (const option of toSelect.options) {
      const after = config.versions.indexOf(option.value) > from;
      option.disabled = !after;
      option.hidden = !after;
    }
    if (toSelect.selectedOptions[0]?.disabled)
      toSelect.value = config.versions[config.versions.length - 1] ?? '';
  };

  let key = '';
  let done = new Set<string>();
  let shown: Step[] = [];
  let first = true;

  const progress = () => {
    const ticked = shown.filter((s) => done.has(s.id)).length;
    doneLine.textContent = config.doneCount
      .replace('{done}', () => number.format(ticked))
      .replace('{n}', () => number.format(shown.length));
    meter.style.inlineSize = `${shown.length === 0 ? 0 : (ticked / shown.length) * 100}%`;
    reset.disabled = ticked === 0;
    // Nothing to tick: the line keeps its place, so nothing below it moves.
    doneLine.parentElement!.style.visibility =
      shown.length === 0 ? 'hidden' : '';
  };

  const apply = () => {
    limitTo();
    const choice = read();
    const result = resolveUpdateGuide(
      { versions: config.versions, steps },
      choice,
      config.levels,
    );
    const included = new Set<Step>(
      result.status === 'resolved'
        ? result.phases.flatMap((p) => p.steps.map((s) => s.step))
        : [],
    );
    for (const step of steps) {
      const visible = included.has(step);
      if (visible && step.el.hidden && !first) {
        // A step that comes into view settles in; none of it under reduced motion (the CSS).
        step.el.classList.remove('is-entering');
        void step.el.offsetWidth;
        step.el.classList.add('is-entering');
      }
      step.el.hidden = !visible;
    }
    shown = steps.filter((s) => included.has(s));
    for (const section of phasesBox.querySelectorAll<HTMLElement>(
      '[data-phase-section]',
    )) {
      const n = shown.filter(
        (s) => s.phase === section.dataset['phaseSection'],
      ).length;
      section.hidden = n === 0;
      const badge = section.querySelector('[data-phase-count]');
      if (badge) badge.textContent = number.format(n);
    }
    empty.hidden = shown.length > 0;
    emptyText.textContent = config.nothingToChange
      .replace('{from}', () => choice.from)
      .replace('{to}', () => choice.to);
    const text = (
      plural.select(shown.length) === 'one'
        ? config.stepCount.one
        : config.stepCount.other
    ).replace('{n}', () => number.format(shown.length));
    // Only a change the reader made is announced, not the page's own first count.
    if (count.textContent !== text) {
      if (first) count.setAttribute('aria-live', 'off');
      count.textContent = text;
      if (first)
        requestAnimationFrame(() => count.setAttribute('aria-live', 'polite'));
    }
    range.textContent = config.range
      .replace('{from}', () => choice.from)
      .replace('{to}', () => choice.to);

    key = `${STORE}:${location.pathname}:${choice.from}>${choice.to}`;
    done = readDone(key);
    for (const step of steps) {
      const ticked = done.has(step.id);
      if (step.check) step.check.checked = ticked;
      step.el.classList.toggle('is-done', ticked);
    }
    progress();
    const query = choiceQuery(config, choice);
    if (query !== location.search)
      history.replaceState(
        history.state,
        '',
        `${location.pathname}${query}${location.hash}`,
      );
    first = false;
  };

  const { choice, invalid } = parseChoice(
    config,
    new URLSearchParams(location.search),
  );
  // A search result leads to a step (its heading's ID in the address): the jump that shows it.
  const target = location.hash
    ? doc.getElementById(decoded(location.hash.slice(1)))
    : null;
  const targetStep = target
    ? steps.find((s) => s.el.contains(target))
    : undefined;
  // Only when that choice shows the step (a condition it cannot satisfy keeps the address's).
  const forStep =
    targetStep && !location.search
      ? choiceForStep(config, choice, targetStep)
      : undefined;
  const showsStep = (c: FullChoice) => {
    const result = resolveUpdateGuide(
      { versions: config.versions, steps },
      c,
      config.levels,
    );
    return (
      result.status === 'resolved' &&
      result.phases.some((p) => p.steps.some((s) => s.step === targetStep))
    );
  };
  show(forStep !== undefined && showsStep(forStep) ? forStep : choice);
  if (invalid)
    root.querySelector<HTMLElement>('[data-guide-invalid]')!.hidden = false;

  form.addEventListener('change', apply);
  form.addEventListener('submit', (event) => event.preventDefault());
  for (const step of steps)
    step.check?.addEventListener('change', () => {
      if (step.check!.checked) done.add(step.id);
      else done.delete(step.id);
      step.el.classList.toggle('is-done', step.check!.checked);
      writeDone(key, done);
      progress();
    });
  // Reset clears the ticks shown; those of steps another level or setup shows stay.
  reset.addEventListener('click', () => {
    for (const step of shown) {
      done.delete(step.id);
      if (step.check) step.check.checked = false;
      step.el.classList.remove('is-done');
    }
    writeDone(key, done);
    progress();
    shown[0]?.check?.focus();
  });
  apply();
  if (targetStep && !targetStep.el.hidden) target?.scrollIntoView();
}
