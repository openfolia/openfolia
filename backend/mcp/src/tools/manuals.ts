import { z } from 'zod';
import {
  Paged,
  parseAnswer,
  segments,
  ToolError,
  type ContentApi,
} from '../api-client.js';
import { MAX_LOOKUP_PAGES, RefArgument } from '../released.js';
import { ChunkPage, getChunks, leftOutReason } from './chunks.js';
import {
  apiUrl,
  defineTool,
  escapeMarkdown,
  idMarkdown,
  Id,
  Lang,
  LocalizedText,
  localizedFields,
  nextPage,
  PageCursor,
  pageOf,
  sliceText,
  TextCursor,
  VariantSlug,
} from './tool.js';

/** Manuals per `list_manuals` page. */
export const MANUALS_PAGE_SIZE = 50;
/** The most characters of a manual's text one `read_manual` call gives. */
export const MANUAL_TEXT_LIMIT = 100_000;
/** The most modules a manual is read with; one with more is refused. */
export const MAX_MANUAL_MODULES = 2_000;

const Variant = z.looseObject({ slug: z.string(), label: z.string() });

export const ManualPage = Paged.extend({
  data: z.array(
    z.looseObject({
      id: z.string(),
      attributes: z
        .looseObject({
          title: LocalizedText,
          audience: z.string().optional(),
        })
        .optional(),
      meta: z
        .looseObject({
          variants: z.array(Variant).optional(),
          error: z.string().optional(),
        })
        .optional(),
    }),
  ),
});

const Config = z.object({
  data: z.looseObject({
    attributes: z.looseObject({
      languages: z.looseObject({
        source: z.string(),
        targets: z.array(z.string()),
      }),
    }),
  }),
});

/** The configured languages at `ref`: the source language first. */
export async function languagesAt(
  api: ContentApi,
  ref: string,
): Promise<string[]> {
  const config = parseAnswer(Config, (await api.get('/config', { ref })).body);
  const { source, targets } = config.data.attributes.languages;
  return [source, ...targets];
}

/** A manual's title for a tool's answer: `title`, and `titles` when it is written per language (#731). */
export function titleFields(
  title: LocalizedText,
  source: string,
): { title: string; titles?: Record<string, string> } {
  const { text, byLanguage } = localizedFields(title, source);
  return { title: text, ...(byLanguage && { titles: byLanguage }) };
}

export const listManualsTool = defineTool({
  name: 'list_manuals',
  title: 'List the manuals',
  description:
    'The released manuals (`GET /manuals`), up to 50 per call: each with its `id`, `title` (in the source language; `titles` gives every language’s when the title is written per language), `audience` and the `variants` it is published in (`slug`, for `read_manual`, and `label`), plus the configured `languages` (the source language first). A manifest that cannot be read is listed with an `error`. `total` counts the manuals, `nextCursor` gives the next page (null after the last). Only manuals this server’s service account may read are listed or counted.',
  inputSchema: {
    ref: RefArgument.optional(),
    cursor: PageCursor.optional(),
  },
  async run({ api, refs, signal }, args) {
    const ref = await refs.resolve(args.ref, signal);
    const [{ body, commit }, languages] = await Promise.all([
      api.get('/manuals', {
        ref,
        'page[number]': String(pageOf(args.cursor)),
        'page[size]': String(MANUALS_PAGE_SIZE),
      }),
      languagesAt(api, ref),
    ]);
    const page = parseAnswer(ManualPage, body);
    return {
      structured: {
        ref,
        commit: commit ?? null,
        languages,
        total: page.meta.page.total,
        nextCursor: nextPage(page.meta.page),
        manuals: page.data.map((m) =>
          m.meta?.error !== undefined || !m.attributes
            ? { id: m.id, error: m.meta?.error ?? 'unreadable' }
            : {
                id: m.id,
                ...titleFields(m.attributes.title, languages[0] ?? ''),
                audience: m.attributes.audience ?? null,
                variants: (m.meta?.variants ?? []).map((v) => ({
                  slug: v.slug,
                  label: v.label,
                })),
                url: apiUrl(api, segments('manuals', m.id), ref),
              },
        ),
      },
    };
  },
});

type Entry =
  | { kind: 'module'; module: string; title: string; lang: string }
  | { kind: 'group'; title: string; entries: Entry[] };

const Entry: z.ZodType<Entry> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.looseObject({
      kind: z.literal('module'),
      module: z.string(),
      title: z.string(),
      lang: z.string(),
    }),
    z.looseObject({
      kind: z.literal('group'),
      title: z.string(),
      entries: z.array(Entry),
    }),
  ]),
) as z.ZodType<Entry>;

const ResolvedManual = z.object({
  data: z.looseObject({
    attributes: z.looseObject({
      title: z.string(),
      lang: z.string(),
      entries: z.array(Entry),
    }),
  }),
});

interface ManualText {
  readonly title: string;
  readonly commit: string | null;
  /** The modules in the order the manual has them. */
  readonly modules: { id: string; lang: string; section: string[] }[];
  readonly markdown: string;
}

/**
 * A manual resolved for a variant and language, as Markdown: a heading,
 * then each module the reader may see, in the manual's order, introduced
 * by its ID, language and section, its text its retrieval chunk for the
 * variant (`GET /chunks?filter[manual]=…&filter[variant]=…`).
 */
export async function manualMarkdown(
  api: ContentApi,
  ref: string,
  id: string,
  variant: string,
  lang: string,
): Promise<ManualText> {
  const { body, commit } = await api.get(
    segments('manuals', id, 'variants', variant, lang),
    { ref },
  );
  const manual = parseAnswer(ResolvedManual, body).data.attributes;
  const modules: ManualText['modules'] = [];
  const walk = (entries: Entry[], section: string[]) => {
    for (const entry of entries) {
      if (entry.kind === 'group')
        walk(entry.entries, [...section, entry.title]);
      else modules.push({ id: entry.module, lang: entry.lang, section });
    }
  };
  walk(manual.entries, []);
  if (modules.length > MAX_MANUAL_MODULES) {
    throw new ToolError(
      'manual-too-large',
      'The manual is too large to read here',
      `It has more than ${MAX_MANUAL_MODULES} modules; read them with \`get_chunks\` and \`manual\`.`,
    );
  }
  const texts = new Map<string, string>();
  /** Modules the API left out of the chunks (#688), by `<lang>/<id>`: why. */
  const leftOut = new Map<string, string>();
  for (const language of new Set(modules.map((m) => m.lang))) {
    const wanted = new Set(
      modules
        .filter((m) => m.lang === language)
        .map((m) => `${language}/${m.id}`),
    );
    for (let number = 1; number <= MAX_LOOKUP_PAGES; number++) {
      const page = parseAnswer(
        ChunkPage,
        (
          await getChunks(api, {
            ref,
            'filter[manual]': id,
            'filter[variant]': variant,
            'filter[lang]': language,
            'page[number]': String(number),
            'page[size]': '200',
          })
        ).body,
      );
      for (const m of page.meta.leftOut ?? []) {
        leftOut.set(`${m.lang}/${m.moduleId}`, leftOutReason(m));
        wanted.delete(`${m.lang}/${m.moduleId}`);
      }
      // A module's own chunk holds its FAQ entries too: their chunks are left out.
      for (const chunk of page.data) {
        if (chunk.attributes.entry) continue;
        texts.set(chunk.id, chunk.attributes.text);
        wanted.delete(chunk.id);
      }
      if (wanted.size === 0 || number >= page.meta.page.lastPage) break;
    }
  }
  const parts = [
    `# ${escapeMarkdown(manual.title)}`,
    `*Manual* ${idMarkdown(id)} · *variant* ${idMarkdown(variant)} · *language* ${idMarkdown(manual.lang)}`,
  ];
  for (const m of modules) {
    const section = m.section.map(escapeMarkdown).join(' › ');
    parts.push(
      '---',
      `*Module* ${idMarkdown(m.id)} · *language* ${idMarkdown(m.lang)}` +
        (section === '' ? '' : ` · *section* ${section}`),
      texts.get(`${m.lang}/${m.id}`) ??
        (leftOut.has(`${m.lang}/${m.id}`)
          ? `*(Left out: the module is too large to cut, as ${leftOut.get(`${m.lang}/${m.id}`)}.)*`
          : '*(No text for this module.)*'),
    );
  }
  return {
    title: manual.title,
    commit: commit ?? null,
    modules,
    markdown: parts.join('\n\n') + '\n',
  };
}

export const readManualTool = defineTool({
  name: 'read_manual',
  title: 'Read a manual',
  description:
    'A released manual resolved for one variant and language, as Markdown: its title, then each module in the manual’s order, introduced by a line naming its module ID, language (a missing translation falls back to the source language) and section, followed by the module’s text as `read_module` gives it for that variant. Returns `text` (at most 100,000 characters per call; `nextCursor` continues, null at the end), `title` and `modules` (each module’s `id`, `lang` and `section`, in order). Take `variant` from `list_manuals`. Modules this server’s service account may not read are left out; a module too large to cut once the modules it refers to are included says so in place of its text; a manual or language it may not read is `not-found`.',
  inputSchema: {
    id: Id.describe('The manual ID, as `list_manuals` gives it.'),
    variant: VariantSlug,
    lang: Lang.describe('The language to read it in.'),
    ref: RefArgument.optional(),
    cursor: TextCursor.optional(),
  },
  async run({ api, refs, signal }, args) {
    const ref = await refs.resolve(args.ref, signal);
    const manual = await manualMarkdown(
      api,
      ref,
      args.id,
      args.variant,
      args.lang,
    );
    const slice = sliceText(manual.markdown, args.cursor, MANUAL_TEXT_LIMIT);
    return {
      text: slice.text,
      structured: {
        id: args.id,
        variant: args.variant,
        lang: args.lang,
        title: manual.title,
        ref,
        commit: manual.commit,
        modules: manual.modules,
        text: slice.text,
        length: slice.total,
        nextCursor: slice.nextCursor,
        url: apiUrl(
          api,
          segments('manuals', args.id, 'variants', args.variant, args.lang),
          ref,
        ),
      },
    };
  },
});
