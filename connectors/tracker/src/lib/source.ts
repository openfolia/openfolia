import { readFile } from 'node:fs/promises';
import { z } from 'zod';

const FieldValue = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.string()),
]);

/**
 * One item of an issue tracker (a feature, a change, a fix), as a source
 * hands it over. Generic on purpose: a source for a real tracker maps its
 * own fields onto these, and anything else into `fields`.
 */
export const TrackerItem = z.strictObject({
  /** Its key in the tracker, e.g. `PRJ-12` (one line, at most 200 characters). */
  id: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[^\n\r]+$/, 'one line'),
  /** What it is: `feature`, `bug`, … as the tracker calls it. */
  kind: z.string().min(1).max(100),
  /** Where it is: `done`, `open`, … as the tracker calls it. */
  state: z.string().min(1).max(100),
  title: z.string().min(1).max(500),
  /** Its description, in the wiki markup (`@openfolia/connector-wiki-markup`). */
  body: z.string().max(1_000_000).default(''),
  labels: z.array(z.string().min(1).max(200)).max(100).default([]),
  /** Any other field, by name. */
  fields: z.record(z.string(), FieldValue).default({}),
  /** When it last changed, as the tracker says (free text, for ordering). */
  updatedAt: z.string().max(100).optional(),
});
export type TrackerItem = z.output<typeof TrackerItem>;

/**
 * Port: where items come from. A source for a real tracker fetches them
 * through the tracker's API, from an address and with a credential the
 * person configured (never one of its own), and maps them onto
 * `TrackerItem`. The sample ships only `FixtureSource`.
 */
export interface ItemSource {
  /** For messages, e.g. the fixture file's path. */
  readonly name: string;
  items(): Promise<readonly TrackerItem[]>;
}

/** The most items a run reads. */
export const MAX_ITEMS = 2_000;

/** A file of the fixture format: `{ "items": [ … ] }`. */
export const FixtureFile = z.strictObject({
  items: z.array(TrackerItem).max(MAX_ITEMS),
});

/**
 * Items from a local JSON file (`{ "items": [ … ] }`), read again on every
 * run: the sample connector's source, standing in for a tracker's API. No
 * network.
 */
export class FixtureSource implements ItemSource {
  constructor(readonly name: string) {}

  async items(): Promise<readonly TrackerItem[]> {
    const parsed = FixtureFile.safeParse(
      JSON.parse(await readFile(this.name, 'utf8')),
    );
    if (!parsed.success) {
      throw new Error(
        `${this.name} is not a fixture file: ${parsed.error.issues
          .slice(0, 5)
          .map((i) => `${i.path.join('.') || '(top)'}: ${i.message}`)
          .join('; ')}`,
      );
    }
    return parsed.data.items;
  }
}
