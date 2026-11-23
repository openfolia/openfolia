import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { AdmonitionComponent, admonitionKinds } from './admonition.component';
import { FaqEntryComponent } from './faq-entry.component';
import {
  AttachmentBlockComponent,
  attachmentIcon,
} from './attachment-block.component';
import { CodeBlockComponent } from './code-block.component';
import { ImageBlockComponent } from './image-block.component';
import { PageBreakBlockComponent } from './page-break-block.component';
import { PassthroughBlockComponent } from './passthrough-block.component';
import { ModuleReferenceCardComponent } from './module-reference-card.component';
import { SafetyNoticeComponent, safetyLevels } from './safety-notice.component';
import { SafetySymbolComponent } from './safety-symbol.component';
import { VariantBlockComponent } from './variant-block.component';

@Component({
  imports: [SafetyNoticeComponent],
  template: `<of-safety-notice level="danger" signalWord="Peril" hazard="Edge">
    <span consequence>Cut</span>
  </of-safety-notice>`,
})
class SafetyHost {}

@Component({
  imports: [SafetyNoticeComponent],
  template: `<of-safety-notice level="warning" signalWord="Word" [body]="true">
    <button header type="button">Level</button>
    <p class="own">Own content</p>
  </of-safety-notice>`,
})
class SafetyBodyHost {}

describe('safety notice', () => {
  it.each(safetyLevels)(
    'level %s uses its fixed colour, an icon and the word',
    (level) => {
      const f = TestBed.createComponent(SafetyNoticeComponent);
      f.componentRef.setInput('level', level);
      f.componentRef.setInput('signalWord', 'Word');
      f.componentRef.setInput('hazard', 'H');
      f.detectChanges();
      const el = f.nativeElement as HTMLElement;
      expect(el.innerHTML).toContain(`bg-safety-${level}`);
      expect(el.querySelector('ng-icon')).not.toBeNull();
      expect(el.getAttribute('aria-label')).toBe('Word');
    },
  );

  it('fades the colours when the level changes, and not under reduced motion', () => {
    const f = TestBed.createComponent(SafetyNoticeComponent);
    f.componentRef.setInput('level', 'notice');
    f.componentRef.setInput('signalWord', 'Word');
    f.detectChanges();
    f.componentRef.setInput('level', 'danger');
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    const header = el.firstElementChild as HTMLElement;
    for (const part of [el, header]) {
      expect(part.classList).toContain('transition-colors');
      expect(part.classList).toContain('motion-reduce:transition-none');
    }
    expect(el.classList).toContain('border-safety-danger');
    expect(header.classList).toContain('bg-safety-danger');
  });

  it('shows inputs and projected slots, in the order hazard, consequence, measure', () => {
    const f = TestBed.createComponent(SafetyHost);
    f.detectChanges();
    const text = (f.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Peril');
    expect(text).toMatch(/Edge[\s\S]*Cut/);
  });

  it('hides a field that is empty', () => {
    const f = TestBed.createComponent(SafetyNoticeComponent);
    f.componentRef.setInput('signalWord', 'Word');
    f.componentRef.setInput('hazard', 'H');
    f.detectChanges();
    const rows = (f.nativeElement as HTMLElement).querySelectorAll('dl > div');
    expect(rows).toHaveLength(3);
    // `has-[dd:empty]:hidden` needs the empty fields to be truly empty (jsdom has no :has)
    for (const row of [rows[1], rows[2]])
      expect(row?.querySelector('dd')?.textContent).toBe('');
  });
});

describe('safety symbol', () => {
  const symbol = (inputs: Record<string, unknown>) => {
    const f = TestBed.createComponent(SafetySymbolComponent);
    f.componentRef.setInput('label', 'General warning');
    for (const [name, value] of Object.entries(inputs)) {
      f.componentRef.setInput(name, value);
    }
    f.detectChanges();
    return f;
  };

  it('shows the artwork as an image, the label as its text alternative', () => {
    const el = symbol({ state: 'shown', src: 'blob:x' })
      .nativeElement as HTMLElement;
    const img = el.querySelector('img');
    expect(img?.getAttribute('src')).toBe('blob:x');
    expect(img?.getAttribute('alt')).toBe('General warning');
    expect(el.dataset['state']).toBe('shown');
  });

  it('holds the place while loading, named for screen readers', () => {
    const el = symbol({ state: 'loading' }).nativeElement as HTMLElement;
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe(
      'General warning',
    );
  });

  it('shows the label, marked as without artwork, never a broken image', () => {
    const el = symbol({ state: 'missing' }).nativeElement as HTMLElement;
    expect(el.querySelector('img')).toBeNull();
    const missing = el.querySelector('[data-slot="symbol-missing"]');
    expect(missing?.textContent).toContain('General warning');
    expect(missing?.textContent).toContain('No artwork');
    // Shown without an address, or one that fails to load: missing too.
    const empty = symbol({ state: 'shown', src: '' });
    expect((empty.nativeElement as HTMLElement).dataset['state']).toBe(
      'missing',
    );
    const broken = symbol({ state: 'shown', src: 'blob:gone' });
    (broken.nativeElement as HTMLElement)
      .querySelector('img')
      ?.dispatchEvent(new Event('error'));
    broken.detectChanges();
    expect((broken.nativeElement as HTMLElement).dataset['state']).toBe(
      'missing',
    );
  });

  it('is a marked tile alone in a menu, its text for screen readers', () => {
    const el = symbol({ state: 'missing', compact: true })
      .nativeElement as HTMLElement;
    const tile = el.querySelector('[data-slot="symbol-missing"]');
    expect(tile?.getAttribute('aria-label')).toBe(
      'General warning: no artwork to show',
    );
    expect(tile?.textContent?.trim()).toBe('');
  });
});

describe('safety notice with a body', () => {
  it('shows the projected content in place of the fields, and header controls after the word', () => {
    const f = TestBed.createComponent(SafetyBodyHost);
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    expect(el.querySelector('dl')).toBeNull();
    expect(el.querySelector('p.own')?.textContent).toBe('Own content');
    const header = el.querySelector('button')?.parentElement;
    expect(header?.textContent).toMatch(/Word[\s\S]*Level/);
  });
});

describe('variant block', () => {
  it('shows each condition as a chip and emits pick', () => {
    const f = TestBed.createComponent(VariantBlockComponent);
    f.componentRef.setInput('conditions', [
      { attribute: 'size', values: ['s', 'm'] },
      { attribute: 'region', values: ['x'] },
    ]);
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    const chips = el.querySelectorAll('[data-chip]');
    expect(chips).toHaveLength(2);
    expect(chips[0]?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      'size: s, m',
    );
    let picked = 0;
    f.componentInstance.pick.subscribe(() => picked++);
    el.querySelector('button')!.click();
    expect(picked).toBe(1);
  });

  it('keeps a disabled pick in view, with its reason, and emits nothing', () => {
    const f = TestBed.createComponent(VariantBlockComponent);
    f.componentRef.setInput('pickDisabledReason', 'Not yet');
    f.detectChanges();
    const button = (f.nativeElement as HTMLElement).querySelector('button')!;
    expect(button.getAttribute('aria-disabled')).toBe('true');
    let picked = 0;
    f.componentInstance.pick.subscribe(() => picked++);
    button.click();
    expect(picked).toBe(0);
  });

  it('says it applies everywhere without a condition', () => {
    const f = TestBed.createComponent(VariantBlockComponent);
    f.detectChanges();
    expect(f.nativeElement.textContent).toContain('Applies to every variant');
  });
});

describe('module reference card', () => {
  it('renders a link with href and a button without', () => {
    const f = TestBed.createComponent(ModuleReferenceCardComponent);
    f.componentRef.setInput('title', 'Cleaning');
    f.componentRef.setInput('shared', true);
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    expect(el.querySelector('a')).toBeNull();
    expect(el.textContent).toContain('Shared module · Whole module');
    let opened = 0;
    f.componentInstance.open.subscribe(() => opened++);
    el.querySelector('button')!.click();
    expect(opened).toBe(1);
    f.componentRef.setInput('href', '/modules/cleaning');
    f.detectChanges();
    expect(el.querySelector('a')?.getAttribute('href')).toBe(
      '/modules/cleaning',
    );
  });

  it('shows a skeleton while loading, a problem in words, and a disabled action with its reason', () => {
    const f = TestBed.createComponent(ModuleReferenceCardComponent);
    f.componentRef.setInput('title', 'Cleaning');
    f.componentRef.setInput('loading', true);
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    expect(el.querySelector('z-skeleton')).not.toBeNull();
    expect(el.textContent).not.toContain('Cleaning');
    f.componentRef.setInput('loading', false);
    f.componentRef.setInput('problem', true);
    f.componentRef.setInput('description', 'Not found');
    f.componentRef.setInput('actionDisabledReason', 'Not yet');
    f.detectChanges();
    expect(el.querySelector('.text-destructive')?.textContent?.trim()).toBe(
      'Not found',
    );
    const button = el.querySelector('button')!;
    expect(button.getAttribute('aria-disabled')).toBe('true');
    let opened = 0;
    f.componentInstance.open.subscribe(() => opened++);
    button.click();
    expect(opened).toBe(0);
  });
});

describe('image block', () => {
  const make = (inputs: Record<string, unknown>) => {
    const f = TestBed.createComponent(ImageBlockComponent);
    for (const [name, value] of Object.entries(inputs))
      f.componentRef.setInput(name, value);
    f.detectChanges();
    return { f, el: f.nativeElement as HTMLElement };
  };

  it('shows the picture at its width, with its alt text, caption and alt line', () => {
    const { el } = make({
      state: 'shown',
      src: 'blob:picture',
      alt: 'A pump',
      caption: 'The pump',
      width: 50,
    });
    const img = el.querySelector('img')!;
    expect(img.getAttribute('src')).toBe('blob:picture');
    expect(img.getAttribute('alt')).toBe('A pump');
    expect(
      el.querySelector<HTMLElement>('[data-slot="image-frame"]')!.style.width,
    ).toBe('50%');
    expect(
      el.querySelector('[data-slot="image-caption"]')?.textContent?.trim(),
    ).toBe('The pump');
    expect(
      el.querySelector('[data-slot="image-alt"]')?.textContent?.trim(),
    ).toBe('Alt text: A pump');
  });

  it('keeps the picture at its own size without a width', () => {
    const { el } = make({ state: 'shown', src: 'blob:x', alt: 'X' });
    const frame = el.querySelector<HTMLElement>('[data-slot="image-frame"]')!;
    expect(frame.style.width).toBe('');
    expect(frame.classList.contains('w-fit')).toBe(true);
  });

  it('says in words when alt text is missing, the picture is missing or failed (with Retry)', () => {
    const { f, el } = make({ state: 'missing', alt: '' });
    expect(el.querySelector('[data-slot="image-alt"]')?.textContent).toContain(
      'No alt text',
    );
    expect(el.textContent).toContain('Image not found');
    expect(el.querySelector('button')).toBeNull();
    f.componentRef.setInput('state', 'error');
    f.detectChanges();
    let retried = 0;
    f.componentInstance.retry.subscribe(() => retried++);
    el.querySelector('button')!.click();
    expect(retried).toBe(1);
    f.componentRef.setInput('state', 'loading');
    f.detectChanges();
    expect(el.querySelector('z-skeleton')).not.toBeNull();
  });

  it('shows a missing picture as a muted box of its own size, never an empty <img>', () => {
    const { el } = make({ state: 'missing', alt: 'X' });
    expect(el.querySelector('img')).toBeNull();
    const frame = el.querySelector<HTMLElement>('[data-slot="image-frame"]')!;
    // At most 20rem wide without a width set; the box keeps an aspect and a minimum height.
    expect(frame.classList.contains('max-w-xs')).toBe(true);
    const box = el.querySelector<HTMLElement>('[data-slot="image-problem"]')!;
    expect(box.classList.contains('min-h-24')).toBe(true);
    expect(box.style.aspectRatio).not.toBe('');
    expect(el.getAttribute('data-state')).toBe('missing');
  });

  it('turns a picture without an address, or one that does not load, into the failed box', () => {
    const { f, el } = make({ state: 'shown', src: '', alt: 'X' });
    expect(el.querySelector('img')).toBeNull();
    expect(el.textContent).toContain('could not be loaded');
    f.componentRef.setInput('src', 'blob:broken');
    f.detectChanges();
    const img = el.querySelector('img')!;
    img.dispatchEvent(new Event('error'));
    f.detectChanges();
    expect(el.querySelector('img')).toBeNull();
    expect(el.getAttribute('data-state')).toBe('error');
    let retried = 0;
    f.componentInstance.retry.subscribe(() => retried++);
    el.querySelector<HTMLButtonElement>(
      '[data-slot="image-problem"] button',
    )!.click();
    f.detectChanges();
    expect(retried).toBe(1);
    // Tried again: the picture gets another chance.
    expect(el.querySelector('img')).not.toBeNull();
  });

  it('puts the action on one line with the alt text, centred, in one text size', () => {
    const { el } = make({
      state: 'shown',
      src: 'blob:x',
      alt: 'X',
      actionLabel: 'Edit',
    });
    const meta = el.querySelector<HTMLElement>('[data-slot="image-meta"]')!;
    expect(meta.classList.contains('items-center')).toBe(true);
    expect(meta.classList.contains('text-xs')).toBe(true);
    const sizes = [...meta.querySelectorAll('*')].flatMap((node) =>
      [...node.classList].filter((c) => /^text-(sm|base|xs|\[)/.test(c)),
    );
    expect(sizes.filter((c) => c !== 'text-xs')).toEqual([]);
  });

  it('offers its action, or keeps it in view, disabled, with the reason', () => {
    const { f, el } = make({
      state: 'shown',
      src: 'blob:x',
      alt: 'X',
      actionLabel: 'Edit',
    });
    let acted = 0;
    f.componentInstance.action.subscribe(() => acted++);
    const button = el.querySelector('button')!;
    expect(button.textContent?.trim()).toBe('Edit');
    button.click();
    expect(acted).toBe(1);
    f.componentRef.setInput('actionDisabledReason', 'Read-only');
    f.detectChanges();
    expect(button.getAttribute('aria-disabled')).toBe('true');
    button.click();
    expect(acted).toBe(1);
  });
});

describe('admonition', () => {
  it.each(admonitionKinds)(
    'kind %s has its own edge and tint, an icon and the word, and no header bar',
    (kind) => {
      const f = TestBed.createComponent(AdmonitionComponent);
      f.componentRef.setInput('kind', kind);
      f.componentRef.setInput('label', 'Word');
      f.detectChanges();
      const el = f.nativeElement as HTMLElement;
      expect(el.getAttribute('role')).toBe('note');
      expect(el.getAttribute('aria-label')).toBe('Word');
      expect(el.className).toContain('border-s-4');
      expect(el.innerHTML).not.toContain('bg-safety');
      expect(el.querySelector('ng-icon')).not.toBeNull();
    },
  );

  it('fades the colours when the kind changes, and not under reduced motion', () => {
    const f = TestBed.createComponent(AdmonitionComponent);
    f.componentRef.setInput('label', 'Word');
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    const before = el.className;
    f.componentRef.setInput('kind', 'important');
    f.detectChanges();
    expect(el.className).not.toBe(before);
    for (const part of [el, el.firstElementChild as HTMLElement]) {
      expect(part.classList).toContain('transition-colors');
      expect(part.classList).toContain('motion-reduce:transition-none');
    }
  });
});

describe('FAQ entry', () => {
  it('is a group named by its label, a quiet frame with an icon, never tinted like a notice', () => {
    const f = TestBed.createComponent(FaqEntryComponent);
    f.componentRef.setInput('label', 'FAQ entry');
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    expect(el.getAttribute('role')).toBe('group');
    expect(el.getAttribute('aria-label')).toBe('FAQ entry');
    expect(el.className).toContain('border-border');
    expect(el.className).not.toMatch(/bg-(info|success|warning|safety)/);
    expect(el.querySelector('ng-icon')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
    expect(el.textContent).toContain('FAQ entry');
  });
});

describe('code block', () => {
  it('shows its label and language, and keeps whitespace', () => {
    const f = TestBed.createComponent(CodeBlockComponent);
    f.componentRef.setInput('label', 'Code');
    f.componentRef.setInput('language', 'yaml');
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    expect(el.querySelector('[data-language]')?.textContent).toBe('yaml');
    expect(el.innerHTML).toContain('whitespace-pre-wrap');
  });
});

describe('passthrough block', () => {
  it('shows its format and source as text only, behind a toggle', () => {
    const f = TestBed.createComponent(PassthroughBlockComponent);
    f.componentRef.setInput('label', 'Unconverted');
    f.componentRef.setInput('format', 'xml');
    f.componentRef.setInput('source', '<img src=x onerror=alert(1)>');
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    expect(el.querySelector('[data-format]')?.textContent).toBe('xml');
    expect(el.querySelector('img')).toBeNull();
    const toggle = el.querySelector<HTMLButtonElement>('button')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(el.querySelector('[data-preview]')?.textContent?.trim()).toBe(
      '<img src=x onerror=alert(1)>',
    );
    toggle.click();
    f.detectChanges();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(el.querySelector('[data-source]')?.textContent).toBe(
      '<img src=x onerror=alert(1)>',
    );
    expect(el.querySelector('img')).toBeNull();
  });
});

describe('page break block', () => {
  it('is a separator named by its label, with the label between two dashed rules', () => {
    const f = TestBed.createComponent(PageBreakBlockComponent);
    f.componentRef.setInput('label', 'Page break (PDF)');
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    expect(el.getAttribute('role')).toBe('separator');
    expect(el.getAttribute('aria-label')).toBe('Page break (PDF)');
    expect(el.textContent?.trim()).toBe('Page break (PDF)');
    expect(el.querySelectorAll('.border-dashed')).toHaveLength(2);
  });
});

describe('attachment block', () => {
  const make = (inputs: Record<string, unknown>) => {
    const f = TestBed.createComponent(AttachmentBlockComponent);
    for (const [name, value] of Object.entries(inputs))
      f.componentRef.setInput(name, value);
    f.detectChanges();
    return { f, el: f.nativeElement as HTMLElement };
  };
  const slot = (el: HTMLElement, name: string) =>
    el.querySelector<HTMLElement>(`[data-slot="attachment-${name}"]`);

  it('shows the icon by type, the name, the facts on one line and the description', () => {
    const { el } = make({
      name: 'Sample settings',
      description: 'Import them to start.',
      fileName: 'sample-settings.zip',
      mediaType: 'application/zip',
      typeLabel: 'ZIP archive',
      sizeLabel: '48 kB',
    });
    expect(slot(el, 'icon')?.dataset['icon']).toBe('archive');
    expect(slot(el, 'name')?.textContent?.trim()).toBe('Sample settings');
    expect(slot(el, 'facts')?.textContent?.trim()).toBe(
      'sample-settings.zip · ZIP archive · 48 kB',
    );
    expect(slot(el, 'description')?.textContent?.trim()).toBe(
      'Import them to start.',
    );
    // No actions without their labels.
    expect(el.querySelector('button')).toBeNull();
  });

  it('picks an icon by the kind of file', () => {
    expect(attachmentIcon('application/json')).toBe('data');
    expect(attachmentIcon('text/csv')).toBe('sheet');
    expect(attachmentIcon('application/pdf')).toBe('text');
    expect(attachmentIcon('image/png')).toBe('image');
    expect(attachmentIcon('text/html')).toBe('code');
    expect(attachmentIcon('application/octet-stream')).toBe('file');
  });

  it('emits Download and Edit, and keeps a disabled one in view without emitting', () => {
    const { f, el } = make({
      name: 'Settings',
      fileName: 'a.zip',
      mediaType: 'application/zip',
      downloadLabel: 'Download',
      actionLabel: 'Edit',
    });
    let downloads = 0;
    let edits = 0;
    f.componentInstance.download.subscribe(() => downloads++);
    f.componentInstance.action.subscribe(() => edits++);
    slot(el, 'download')!.click();
    slot(el, 'action')!.click();
    expect([downloads, edits]).toEqual([1, 1]);
    f.componentRef.setInput('downloading', true);
    f.detectChanges();
    expect(slot(el, 'download')!.getAttribute('aria-busy')).toBe('true');
    slot(el, 'download')!.click();
    f.componentRef.setInput('downloading', false);
    f.componentRef.setInput('downloadDisabledReason', 'Not saved yet');
    f.detectChanges();
    expect(slot(el, 'download')!.getAttribute('aria-disabled')).toBe('true');
    slot(el, 'download')!.click();
    expect(downloads).toBe(1);
  });

  it('says in words when the file is missing or not chosen', () => {
    const { f, el } = make({ state: 'missing', name: 'Settings' });
    expect(el.getAttribute('data-state')).toBe('missing');
    expect(slot(el, 'icon')?.dataset['icon']).toBe('missing');
    expect(slot(el, 'facts')?.textContent).toContain('File not found');
    f.componentRef.setInput('state', 'empty');
    f.componentRef.setInput('name', '');
    f.detectChanges();
    expect(slot(el, 'facts')?.textContent).toContain('No file chosen');
    expect(slot(el, 'name')?.textContent).toContain('Untitled file');
  });
});
