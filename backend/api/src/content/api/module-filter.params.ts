import { applyDecorators } from '@nestjs/common';
import { ApiQuery } from '@nestjs/swagger';
import { ConfigKey, Keyword, MAX_KEYWORDS } from '@openfolia/content-model';
import { z } from 'zod';
import {
  AcceptsQuery,
  MAX_PAGE_SIZE,
} from '../../base/api/json-api.decorators.js';
import { params } from '../../base/api/schemas.js';
import type { FacetValue } from '../core/module-filter.js';

/** The most values of one repeated filter (`filter[facet]`, `filter[keyword]`). */
export const MAX_FILTER_VALUES = MAX_KEYWORDS;

/** One value, or the values of a repeated parameter (`?a=1&a=2`), as a list. */
const repeated = <T extends z.ZodType<unknown, string>>(
  item: T,
  name: string,
) =>
  z
    .union([z.string(), z.array(z.string())])
    .transform((v) => (Array.isArray(v) ? v : [v]))
    .pipe(
      z
        .array(item)
        .max(
          MAX_FILTER_VALUES,
          `At most ${MAX_FILTER_VALUES} values of ${name}.`,
        ),
    );

/** The most module IDs one list filter takes (`filter[id]`, `filter[module]`): a full page of them. */
export const MAX_MODULE_IDS = MAX_PAGE_SIZE;

/**
 * A list filter of module IDs (`name`: the parameter, for the error): comma-separated (`a,b,c`),
 * each a module ID, 1 to `MAX_MODULE_IDS`, as a set.
 */
export const moduleIdList = (name: string) =>
  z
    .string()
    // No longer than the most IDs of the longest kind and their commas: refused before splitting.
    .max(
      MAX_MODULE_IDS * 101,
      `At most ${MAX_MODULE_IDS} module IDs in ${name}.`,
    )
    .transform((v) => v.split(','))
    .pipe(
      z
        .array(params.moduleId)
        .min(1)
        .max(
          MAX_MODULE_IDS,
          `At most ${MAX_MODULE_IDS} module IDs in ${name}.`,
        ),
    )
    .transform((ids): ReadonlySet<string> => new Set(ids));

const FacetValueParam = z
  .string()
  .regex(
    /^[a-z][a-z0-9-]{0,63}:[a-z][a-z0-9-]{0,63}$/,
    '`<facet>:<value>`, e.g. `region:north`',
  )
  .transform((v): FacetValue => {
    const [id = '', value = ''] = v.split(':');
    return { id, value };
  });

/** Query parameter schemas for `ModuleFilter`, shared by the routes that filter modules. */
export const moduleFilterParams = {
  type: ConfigKey,
  audience: ConfigKey,
  facet: repeated(FacetValueParam, 'filter[facet]'),
  keyword: repeated(Keyword, 'filter[keyword]'),
};

/**
 * Supports `filter[type]`, `filter[audience]`, `filter[facet]` and
 * `filter[keyword]` (the last two repeatable, every value has to match):
 * read them with `@Query('filter[…]', { schema: moduleFilterParams.… })`.
 * `type` documents itself unless the route describes it (`typeDescription`).
 */
export const ModuleFilters = (options: { typeDescription?: string } = {}) =>
  applyDecorators(
    AcceptsQuery(
      'filter[type]',
      'filter[audience]',
      'filter[facet]',
      'filter[keyword]',
    ),
    ApiQuery({
      name: 'filter[type]',
      required: false,
      description:
        options.typeDescription ?? 'Only modules of this module type.',
      schema: { type: 'string' },
    }),
    ApiQuery({
      name: 'filter[audience]',
      required: false,
      description:
        'Only modules that count as this audience level: their own, or the last, most restricted level for a module naming none, as manuals and the access check place it. A level the configuration does not list matches nothing, and a module naming such a level matches no level.',
      schema: { type: 'string' },
    }),
    ApiQuery({
      name: 'filter[facet]',
      required: false,
      description: `Only modules with this facet value, as \`<facet>:<value>\` (e.g. \`region:north\`). Repeat it for several, at most ${MAX_FILTER_VALUES}: a module has to have every one.`,
      schema: { type: 'array', items: { type: 'string' } },
      style: 'form',
      explode: true,
    }),
    ApiQuery({
      name: 'filter[keyword]',
      required: false,
      description: `Only modules with this keyword, case and diacritics aside (\`Wärme\` is \`warme\`); 1 to 64 characters, no comma. Repeat it for several, at most ${MAX_FILTER_VALUES}: a module has to have every one.`,
      schema: { type: 'array', items: { type: 'string' } },
      style: 'form',
      explode: true,
    }),
  );
