import { isLang, type Lang } from '@/lib/i18n';

const TEXT = {
  en: {
    download: 'Download OpenAPI',
    note: 'The document imports into Postman, Insomnia or Bruno (in Postman: File › Import, then the file or its address). Its server is https://{host}/api: after importing, set host (or the base URL the tool made from it) to your instance’s host, <team>.openfolia.com for a hosted team or your editor’s host when you host it yourself.',
  },
  de: {
    download: 'OpenAPI herunterladen',
    note: 'Das Dokument lässt sich in Postman, Insomnia oder Bruno importieren (in Postman: File › Import, dann die Datei oder ihre Adresse). Sein Server ist https://{host}/api: Setzen Sie nach dem Import host (oder die Basis-URL, die das Werkzeug daraus gemacht hat) auf den Host Ihrer Instanz, <team>.openfolia.com für ein gehostetes Team oder den Host Ihres Editors, wenn Sie es selbst betreiben.',
  },
} satisfies Record<Lang, Record<string, string>>;

/**
 * Links to an API's whole OpenAPI document (`/openapi/<api>.yaml` and `.json`, `app/openapi/`),
 * with a note on importing it (#618). Plain links, not client navigation: they are files.
 */
export function OpenAPIDownload({
  api,
  lang = 'en',
}: {
  api: 'delivery' | 'management';
  lang?: string;
}) {
  const text = TEXT[isLang(lang) ? lang : 'en'];
  return (
    <div className="not-prose my-4 rounded-xl border bg-fd-card p-4 text-sm">
      <p className="font-medium">
        {api === 'delivery' ? 'Delivery API' : 'Management API'}:{' '}
        {text.download} (
        <a
          className="text-fd-primary underline underline-offset-4"
          href={`/openapi/${api}.yaml`}
          download
        >
          YAML
        </a>{' '}
        /{' '}
        <a
          className="text-fd-primary underline underline-offset-4"
          href={`/openapi/${api}.json`}
          download
        >
          JSON
        </a>
        )
      </p>
      <p className="mt-1 text-fd-muted-foreground">{text.note}</p>
    </div>
  );
}
