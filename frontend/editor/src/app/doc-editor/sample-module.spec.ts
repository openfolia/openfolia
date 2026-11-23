import {
  BLOCK_NODES,
  fromEditor,
  normalizeEditorDoc,
  toEditor,
} from '@openfolia/content-editor-model';
import { Module, normalizeModule, walk } from '@openfolia/content-model';

import { SAMPLE_MODULE } from './sample-module';

describe('the playground’s sample module', () => {
  it('is a valid module in normal form', () => {
    expect(Module.parse(SAMPLE_MODULE)).toEqual(SAMPLE_MODULE);
    expect(normalizeModule(SAMPLE_MODULE)).toEqual(SAMPLE_MODULE);
  });

  it('holds every block type of the content model', () => {
    const types = new Set<string>();
    for (const { node } of walk(SAMPLE_MODULE.blocks))
      if ('type' in node) types.add(node.type);
    expect([...types].sort()).toEqual(Object.keys(BLOCK_NODES).sort());
  });

  it('goes to the editor and back unchanged, and needs no repair', () => {
    const doc = toEditor(SAMPLE_MODULE);
    expect(normalizeEditorDoc(doc)).toEqual(doc);
    expect(fromEditor(doc)).toEqual(SAMPLE_MODULE);
  });
});
