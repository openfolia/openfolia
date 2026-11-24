'use client';
import { useServer } from 'fumadocs-openapi';
import { createOpenAPIPage } from 'fumadocs-openapi/ui';
import { Fragment, useId, useState } from 'react';
import { hostOf, isHost } from '@/lib/host';

const METHOD_COLOUR: Record<string, string> = {
  get: 'text-green-700 dark:text-green-400',
  post: 'text-blue-700 dark:text-blue-400',
  put: 'text-yellow-700 dark:text-yellow-400',
  patch: 'text-orange-700 dark:text-orange-400',
  delete: 'text-red-700 dark:text-red-400',
};

/**
 * The operation's address with the reader's host (#858), in place of the playground: the docs site
 * can't send a request to an instance (another origin, the API sends no CORS headers, and the
 * site's Content-Security-Policy allows only itself), so it shows where the request goes, lets the
 * reader type their host once (kept in the browser by fumadocs, for every page) and the code
 * samples use it. Sending is for the instance's own reference, `/api/docs`.
 */
function Endpoint({ path, method }: { path: string; method: string }) {
  const { server, servers, setServerVariables } = useServer();
  const fallback = String(servers?.[0]?.variables?.host?.default ?? '');
  // Re-checked: the stored value comes back from the browser's storage.
  const stored = server?.variables?.host;
  const host = stored !== undefined && isHost(stored) ? stored : fallback;
  // What the field shows while it differs from the host in use: a value being typed, or not valid.
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? (host === fallback ? '' : host);
  const invalid = value.trim() !== '' && hostOf(value) === null;
  const id = useId();

  const change = (next: string) => {
    setDraft(next);
    const typed = hostOf(next);
    if (next.trim() === '') setServerVariables({ host: fallback });
    else if (typed !== null) setServerVariables({ host: typed });
  };

  return (
    <div className="not-prose my-4 overflow-hidden rounded-xl border bg-fd-card text-sm text-fd-card-foreground">
      <p className="flex items-baseline gap-3 px-3.5 py-2.5 font-mono text-[0.8125rem]">
        <span
          className={`shrink-0 text-xs font-medium ${METHOD_COLOUR[method] ?? 'text-fd-muted-foreground'}`}
        >
          {method.toUpperCase()}
        </span>
        {/* Breaks after a slash where it can (<wbr>), anywhere only when a part is too long. */}
        <span className="min-w-0 [overflow-wrap:anywhere]">
          <span className="text-fd-muted-foreground">
            https://{host}/<wbr />
            api
          </span>
          {path.split(/(\{[^}]*\}|\/)/).map((part, i) =>
            part === '/' ? (
              <Fragment key={i}>
                <wbr />/
              </Fragment>
            ) : part.startsWith('{') ? (
              <span
                key={i}
                className="rounded-md bg-fd-primary/10 px-1 text-fd-primary"
              >
                {part}
              </span>
            ) : (
              part
            ),
          )}
        </span>
      </p>
      <div className="border-t px-3.5 py-3">
        <label htmlFor={id} className="block text-xs font-medium">
          Your instance’s host
        </label>
        <div
          className={`mt-1.5 flex items-center rounded-lg border bg-fd-background font-mono text-[0.8125rem] transition-[border-color,box-shadow] focus-within:border-fd-ring focus-within:ring-2 focus-within:ring-fd-ring/50 motion-reduce:transition-none ${invalid ? 'border-red-600! dark:border-red-400!' : ''}`}
        >
          <span
            aria-hidden
            className="ps-2.5 text-fd-muted-foreground select-none"
          >
            https://
          </span>
          <input
            id={id}
            type="text"
            inputMode="url"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            value={value}
            placeholder={fallback}
            aria-invalid={invalid || undefined}
            aria-describedby={`${id}-hint`}
            onChange={(e) => change(e.target.value)}
            onBlur={() => {
              if (!invalid) setDraft(null);
            }}
            className="min-w-0 flex-1 bg-transparent px-0.5 py-1.5 outline-none placeholder:text-fd-muted-foreground/70"
          />
          <span
            aria-hidden
            className="pe-2.5 text-fd-muted-foreground select-none"
          >
            /api
          </span>
        </div>
        <p
          id={`${id}-hint`}
          aria-live="polite"
          className="mt-1.5 text-xs leading-relaxed text-fd-muted-foreground"
        >
          {invalid ? (
            <span className="text-red-700 dark:text-red-400">
              Enter a host name, with a port if it has one, like{' '}
              <code>{fallback}</code> or <code>openfolia.example.com:8443</code>
              .
            </span>
          ) : (
            <>
              Hosted: <code>&lt;team&gt;.openfolia.com</code>. Self-hosted: your
              editor’s host. The examples use it; to send requests, open{' '}
              {host === fallback ? (
                <code>/api/docs</code>
              ) : (
                <a
                  className="text-fd-primary underline underline-offset-4"
                  href={`https://${host}/api/docs`}
                  target="_blank"
                  rel="noreferrer"
                >
                  https://{host}/api/docs
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              )}{' '}
              on your instance, its own interactive reference.
            </>
          )}
        </p>
      </div>
    </div>
  );
}

/** An operation of the API reference, with its schemas and code samples. */
export const OpenAPIPage = createOpenAPIPage({
  playground: {
    render: ({ path, method }) => <Endpoint path={path} method={method} />,
  },
});
