import type { z } from 'zod';
import type { Module } from '../lib/module.js';

type ModuleInput = z.input<typeof Module>;

const t = (text: string) => ({ type: 'text' as const, text });

/** A procedure using most block types: safety, variant, image, table, module reuse, inline attributes. */
export const chargingProcedure: ModuleInput = {
  schemaVersion: 1,
  id: 'battery-charging',
  meta: {
    title: 'Charging the battery',
    type: 'procedure',
    lang: 'en',
    audience: 'customer',
    facets: { 'product-line': ['lifters'] },
    keywords: ['battery', 'maintenance'],
    source: { system: 'legacy-cms', id: 'TOPIC-00412' },
  },
  blocks: [
    {
      type: 'paragraph',
      id: 'intro',
      content: [
        t('The '),
        { type: 'attribute', name: 'product-name' },
        t(
          ' charges automatically at the charging station. Charge manually only after a deep discharge.',
        ),
      ],
    },
    {
      type: 'safety',
      id: 'warn-voltage',
      severity: 'warning',
      hazard: [t('Electrical voltage at the charging contacts')],
      symbols: ['w012'],
      blocks: [
        {
          type: 'paragraph',
          id: 'warn-voltage-consequence',
          content: [t('Touching live contacts can cause burns.')],
        },
        {
          type: 'list',
          id: 'warn-voltage-measures',
          ordered: false,
          items: [
            {
              id: 'warn-voltage-m1',
              content: [
                t('Switch off the charger before you touch the contacts.'),
              ],
              blocks: [],
            },
            {
              id: 'warn-voltage-m2',
              content: [t('Wear insulating gloves.')],
              blocks: [],
            },
          ],
        },
      ],
    },
    {
      type: 'procedure',
      id: 'steps',
      title: [t('Charge manually')],
      steps: [
        {
          id: 'step-park',
          content: [
            t('Select '),
            { type: 'text', text: 'Park', marks: [{ type: 'ui' }] },
            t(' on the control panel.'),
          ],
          blocks: [],
        },
        {
          id: 'step-connect',
          content: [
            t('Connect the charging cable to the socket '),
            { type: 'calloutRef', block: 'img-socket', callout: 'socket' },
            t('.'),
          ],
          blocks: [
            {
              type: 'image',
              id: 'img-socket',
              asset:
                'sha256:9f2c1e5b8a7d6c4b3a2f1e0d9c8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f3e2d1c0b',
              alt: 'Charging socket on the rear panel, cable plugged in',
              width: 60,
              callouts: [
                {
                  id: 'socket',
                  anchor: { x: 0.42, y: 0.55 },
                  label: { x: 0.1, y: 0.2 },
                  legend: [t('Charging socket')],
                },
                {
                  id: 'status-light',
                  anchor: { x: 0.7, y: 0.3 },
                  legend: [
                    { type: 'text', text: 'Status', marks: [{ type: 'ui' }] },
                    t(' light'),
                  ],
                },
                {
                  id: 'app-pairing',
                  anchor: { x: 0.8, y: 0.75 },
                  legend: [t('Pairing button for the app')],
                  when: { op: 'in', attr: 'model', values: ['l-400'] },
                },
              ],
            },
          ],
        },
        {
          id: 'step-wait',
          content: [t('Wait until the status light turns green.')],
          blocks: [
            {
              type: 'variant',
              id: 'step-wait-l400',
              when: {
                op: 'all',
                of: [
                  { op: 'in', attr: 'model', values: ['l-400'] },
                  { op: 'cmp', attr: 'software', cmp: '>=', value: '2.3' },
                ],
              },
              blocks: [
                {
                  type: 'admonition',
                  id: 'step-wait-l400-note',
                  kind: 'note',
                  blocks: [
                    {
                      type: 'paragraph',
                      id: 'step-wait-l400-text',
                      content: [
                        t('The charging progress is also shown in the app.'),
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    {
      type: 'table',
      id: 'charge-times',
      title: [t('Charging times')],
      columns: [{ width: 2 }, { width: 1, align: 'right' }],
      header: true,
      rows: [
        {
          cells: [
            {
              blocks: [
                { type: 'paragraph', id: 'ct-h1', content: [t('Model')] },
              ],
            },
            {
              blocks: [
                { type: 'paragraph', id: 'ct-h2', content: [t('Time')] },
              ],
            },
          ],
        },
        {
          cells: [
            {
              blocks: [
                { type: 'paragraph', id: 'ct-r1c1', content: [t('L-200')] },
              ],
            },
            {
              blocks: [
                { type: 'paragraph', id: 'ct-r1c2', content: [t('2 h')] },
              ],
            },
          ],
        },
        {
          cells: [
            {
              blocks: [
                { type: 'paragraph', id: 'ct-r2c1', content: [t('L-400')] },
              ],
            },
            {
              blocks: [
                { type: 'paragraph', id: 'ct-r2c2', content: [t('3 h')] },
              ],
            },
          ],
        },
      ],
    },
    { type: 'moduleRef', id: 'ref-disposal', module: 'battery-disposal' },
    {
      type: 'paragraph',
      id: 'see-also',
      content: [
        t('See also '),
        { type: 'xref', module: 'charging-station', block: 'status-lights' },
        t('.'),
      ],
    },
  ],
};

/** A small reusable safety module, as referenced from many manuals. */
export const batteryDisposal: ModuleInput = {
  schemaVersion: 1,
  id: 'battery-disposal',
  meta: {
    title: 'Disposing of batteries',
    type: 'safety',
    lang: 'en',
    audience: 'public',
  },
  blocks: [
    {
      type: 'safety',
      id: 'notice-disposal',
      severity: 'notice',
      hazard: [t('Environmental damage from incorrect disposal')],
      symbols: [],
      blocks: [
        {
          type: 'paragraph',
          id: 'notice-disposal-text',
          content: [
            t(
              'Return used batteries to the manufacturer or a certified recycler.',
            ),
          ],
        },
      ],
    },
  ],
};
