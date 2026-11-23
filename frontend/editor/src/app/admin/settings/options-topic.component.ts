import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';

import { translated } from '@openfolia/ui/i18n';

import { optionsOf, setOptions, sourceLabel } from './config-model';
import {
  OptionListComponent,
  type OptionListChange,
  type OptionRow,
} from './option-list.component';
import {
  OptionNewDialogComponent,
  type NewOption,
} from './option-new-dialog.component';
import { SettingsContext } from './settings-context';
import {
  OPTION_TOPICS,
  topicOf,
  type SettingsTopicPage,
} from './settings-topics';

/**
 * A settings topic that is one list of `{ id, label }` values (module types, audiences, text
 * attributes, safety symbols; the route says which): the list read first
 * (`of-option-list`), the topic's Add dialog, and removals through the in-use check.
 */
@Component({
  selector: 'of-settings-options',
  imports: [TranslocoPipe, OptionListComponent, OptionNewDialogComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block max-w-4xl min-w-0' },
  template: `
    <of-option-list
      [items]="items()"
      [label]="(topic.title | transloco) ?? ''"
      [editable]="ctx.editable()"
      [flags]="list.key === 'moduleTypes' ? 'moduleType' : null"
      [min]="list.min"
      [usageKind]="list.usage"
      [counts]="ctx.counts()"
      [linkQuery]="ctx.linkQuery()"
      [languages]="ctx.languages()"
      (changed)="apply($event)"
      (remove)="remove($event)"
    />
    <of-option-new-dialog
      [open]="adding()"
      [title]="(topic.add ?? '' | transloco) ?? ''"
      [rule]="list.key"
      [taken]="ids()"
      [languages]="ctx.languages()"
      (add)="add($event)"
      (closed)="adding.set(false)"
    />
  `,
})
export class OptionsTopicPage implements SettingsTopicPage {
  protected readonly ctx = inject(SettingsContext);
  private readonly path =
    inject(ActivatedRoute).snapshot.routeConfig?.path ?? '';

  protected readonly topic = topicOf(this.path) ?? {
    path: this.path,
    group: 'contentModel' as const,
    title: '',
    hint: '',
  };
  protected readonly list = OPTION_TOPICS[this.path] ?? {
    key: 'audiences' as const,
    usage: 'audience' as const,
    min: 1,
  };

  protected readonly items = computed((): readonly OptionRow[] => {
    const c = this.ctx.config();
    return c ? optionsOf(c, this.list.key) : [];
  });
  protected readonly ids = computed(() => this.items().map((i) => i.id));
  protected readonly adding = signal(false);

  openAdd(): void {
    this.adding.set(true);
  }

  protected apply(change: OptionListChange): void {
    const c = this.ctx.config();
    if (c)
      this.ctx.save(setOptions(c, this.list.key, change.items), change.what);
  }

  protected add(option: NewOption): void {
    const c = this.ctx.config();
    this.adding.set(false);
    if (!c) return;
    const row: OptionRow =
      this.list.key === 'moduleTypes'
        ? {
            id: option.id,
            label: option.label,
            restricted: false,
            snippet: false,
          }
        : { id: option.id, label: option.label };
    const label = sourceLabel(c, row.label);
    this.ctx.save(
      setOptions(c, this.list.key, [...optionsOf(c, this.list.key), row]),
      translated('editor.admin.settings.changes.add', { label }),
      {
        part: this.list.key,
        done: translated('editor.admin.settings.done.add', { label }),
      },
    );
  }

  protected remove(row: OptionRow): void {
    const key = this.list.key;
    this.ctx.remove(
      this.list.usage ? { kind: this.list.usage, valueId: row.id } : null,
      row.label,
      key,
      (c) =>
        setOptions(
          c,
          key,
          optionsOf(c, key).filter((i) => i.id !== row.id),
        ),
    );
  }
}
