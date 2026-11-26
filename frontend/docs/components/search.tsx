'use client';
import {
  SearchDialog,
  SearchDialogClose,
  SearchDialogContent,
  SearchDialogHeader,
  SearchDialogIcon,
  SearchDialogInput,
  SearchDialogList,
  SearchDialogOverlay,
  type SharedProps,
} from 'fumadocs-ui/components/dialog/search';
import { buttonVariants } from 'fumadocs-ui/components/ui/button';
import { useStaticSearch } from 'fumadocs-core/search/client';
import { useI18n } from 'fumadocs-ui/contexts/i18n';
import { useEffect, useState } from 'react';
import { isLang } from '@/lib/i18n';
import { t } from '@/lib/translations';

/**
 * Search in the browser over the index exported at build time, one file per language
 * (`/search-<lang>.json`, `lib/search-index.ts`). The index is fetched when the dialog opens, not
 * at the first keystroke, so the wait shows as a loading state; a failed fetch says so and can be
 * tried again.
 */
export default function StaticSearchDialog(props: SharedProps) {
  const { locale } = useI18n();
  const lang = locale && isLang(locale) ? locale : 'en';
  // The client caches the fetch by its address, a failure too: a new address retries.
  const [attempt, setAttempt] = useState(0);
  const [retried, setRetried] = useState<unknown>();
  const from = `/search-${lang}.json${attempt ? `?retry=${attempt}` : ''}`;
  const { error, ...search } = useStaticSearch({
    from,
    locale,
    allowEmpty: props.open,
  });
  // An error already retried is stale: the retry is running (or has succeeded).
  const current = error && error !== retried ? error : undefined;
  const indexing = useAfterDelay(search.isLoading && !search.data && !current);
  const failed = !!current && !search.data;
  return (
    <SearchDialog {...search} {...props}>
      <SearchDialogOverlay />
      <SearchDialogContent>
        <SearchDialogHeader>
          <SearchDialogIcon />
          <SearchDialogInput />
          <SearchDialogClose />
        </SearchDialogHeader>
        {indexing && <SearchLoading text={t(lang, 'searchLoading')} />}
        {failed && (
          <SearchFailed
            title={t(lang, 'searchFailed')}
            text={t(lang, 'searchFailedText')}
            retry={t(lang, 'searchRetry')}
            onRetry={() => {
              setRetried(error);
              setAttempt((n) => n + 1);
            }}
          />
        )}
        {/* With nothing typed there is nothing to list: the open dialog only warms the index. */}
        <SearchDialogList
          items={search.search && search.data?.query ? search.data.items : null}
        />
      </SearchDialogContent>
    </SearchDialog>
  );
}

/** True once `on` has held for 150 ms: a placeholder never flashes for an index that loads at once. */
function useAfterDelay(on: boolean) {
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (!on) return setLate(false);
    const timer = setTimeout(() => setLate(true), 150);
    return () => clearTimeout(timer);
  }, [on]);
  return on && late;
}

/** The panels' shared frame: one height for loading and failure, so the dialog never jumps. */
const PANEL =
  'search-state flex h-44 flex-col items-center justify-center gap-3 px-6 text-center text-sm text-fd-muted-foreground';

/** Placeholder rows shaped like results, pulsing unless the reader prefers reduced motion. */
function SearchLoading({ text }: { text: string }) {
  return (
    <div role="status" className="h-44 overflow-hidden p-3">
      <p className="mb-3 text-xs text-fd-muted-foreground">{text}</p>
      <div
        aria-hidden
        className="flex flex-col gap-3 motion-safe:animate-pulse"
      >
        {[72, 56, 64].map((width) => (
          <div key={width} className="flex flex-col gap-1.5 px-1">
            <div className="h-2 w-1/4 rounded bg-fd-muted" />
            <div
              className="h-3 rounded bg-fd-muted"
              style={{ width: `${width}%` }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function SearchFailed(props: {
  title: string;
  text: string;
  retry: string;
  onRetry: () => void;
}) {
  return (
    <div role="alert" className={PANEL}>
      <svg
        aria-hidden
        viewBox="0 0 24 24"
        className="size-6 text-fd-error"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="12" r="10" />
        <path d="M12 8v4M12 16h.01" />
      </svg>
      <div>
        <p className="font-medium text-fd-popover-foreground">{props.title}</p>
        <p className="mt-1">{props.text}</p>
      </div>
      <button
        type="button"
        onClick={props.onRetry}
        className={buttonVariants({ variant: 'outline', size: 'sm' })}
      >
        {props.retry}
      </button>
    </div>
  );
}
