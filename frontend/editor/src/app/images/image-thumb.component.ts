import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  resource,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideImage, lucideImageOff } from '@ng-icons/lucide';
import { ZardSkeletonComponent } from '@openfolia/ui/skeleton';

import type { RenditionWidth } from '../api';
import { MeService } from '../permissions/me';
import { ImageSources } from './image-sources';

/**
 * A tile's picture: read through `ImageSources` (a skeleton meanwhile), contained in its box; an
 * image that can't be shown gets an icon (the tile's words say what it is). `src` shows bytes the
 * page already holds (an upload under way) without reading anything.
 */
@Component({
  selector: 'of-image-thumb',
  imports: [NgIcon, ZardSkeletonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [provideIcons({ lucideImage, lucideImageOff })],
  host: {
    class:
      'bg-muted text-muted-foreground flex aspect-[8/5] items-center justify-center overflow-hidden rounded-md',
  },
  template: `
    @let url = shown();
    @if (url) {
      <img
        class="animate-in fade-in-0 block size-full object-contain duration-200 motion-reduce:animate-none"
        [src]="url"
        alt=""
      />
    } @else if (pending()) {
      <z-skeleton class="size-full rounded-none" />
    } @else {
      <ng-icon
        [name]="failed() ? 'lucideImageOff' : 'lucideImage'"
        size="20"
        aria-hidden="true"
      />
    }
  `,
})
export class ImageThumbComponent {
  private readonly sources = inject(ImageSources);
  private readonly me = inject(MeService).me;

  /** The image: `sha256:<hash>`; empty for none. */
  readonly asset = input('');
  /** Where a fresh upload can be previewed. */
  readonly changeSetId = input<string | null>(null);
  /** A fresh upload into `changeSetId` no module shows yet: read from its preview first. */
  readonly upload = input(false);
  /** Bytes already here (an object URL): shown as they are. */
  readonly src = input('');
  /** Reads the image's rendition at most this wide (PNG, JPEG, GIF, WebP only); none: the file. */
  readonly width = input<RenditionWidth | undefined>(undefined);

  private readonly read = resource({
    params: () =>
      this.src() || !this.asset()
        ? undefined
        : {
            asset: this.asset(),
            changeSetId: this.changeSetId(),
            width: this.width(),
            upload: this.upload(),
            // Read again for another person: what was shown was the one before's (#716).
            who: this.me().id,
          },
    loader: ({ params }) =>
      this.sources.source(
        params.asset,
        params.changeSetId,
        undefined,
        params.width,
        { upload: params.upload },
      ),
  });

  protected readonly shown = computed(
    () => this.src() || (this.read.hasValue() ? this.read.value() : null),
  );
  protected readonly pending = computed(() => this.read.isLoading());
  protected readonly failed = computed(
    () =>
      this.read.status() === 'error' ||
      (this.read.status() === 'resolved' && !this.read.value()),
  );
}
