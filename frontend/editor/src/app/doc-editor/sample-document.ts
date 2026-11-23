import type { JSONContent } from '@tiptap/core';

/**
 * What the playground opens with: one of each block the editor has today. Neutral words only.
 * Once the content model's schema (#28) is in, a sample module loaded through `toEditor` takes
 * its place.
 */
export const SAMPLE_DOCUMENT: JSONContent = {
  type: 'doc',
  content: [
    {
      type: 'heading',
      attrs: { level: 1 },
      content: [{ type: 'text', text: 'Charging the vehicle' }],
    },
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'Park the vehicle at the station and wait for the ',
        },
        { type: 'text', marks: [{ type: 'bold' }], text: 'ready' },
        { type: 'text', text: ' light. Type ' },
        { type: 'text', marks: [{ type: 'code' }], text: '/' },
        { type: 'text', text: ' on an empty line to insert a block.' },
      ],
    },
    {
      type: 'heading',
      attrs: { level: 2 },
      content: [{ type: 'text', text: 'Before you start' }],
    },
    {
      type: 'bulletList',
      content: [
        listItem('The station is switched on.'),
        listItem('Nothing blocks the contacts.'),
      ],
    },
    {
      type: 'heading',
      attrs: { level: 2 },
      content: [{ type: 'text', text: 'Steps' }],
    },
    {
      type: 'orderedList',
      attrs: { start: 1 },
      content: [
        listItem('Drive onto the station slowly.'),
        listItem('Stop when the contacts touch.'),
        listItem('Check that charging has started.'),
      ],
    },
    { type: 'horizontalRule' },
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          marks: [{ type: 'italic' }],
          text: 'Drag a block by its grip, or move it with Alt+Up and Alt+Down.',
        },
      ],
    },
  ],
};

function listItem(text: string): JSONContent {
  return {
    type: 'listItem',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
}
