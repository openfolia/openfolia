import { describe, expect, it } from 'vitest';
import { loadSettings } from './settings.js';

const required = {
  CCMS_EMBEDDER_MODEL: 'm',
  CCMS_EMBEDDER_DIMENSIONS: '384',
  CCMS_EMBEDDER_MODEL_SHA256: 'A'.repeat(64),
  CCMS_EMBEDDER_TOKENIZER_SHA256: 'b'.repeat(64),
};

describe('loadSettings', () => {
  it('reads the required settings and fills in the defaults', () => {
    expect(loadSettings(required)).toEqual({
      CCMS_EMBEDDER_MODEL: 'm',
      CCMS_EMBEDDER_DIMENSIONS: 384,
      CCMS_EMBEDDER_MODEL_DIR: '/models',
      CCMS_EMBEDDER_MODEL_SHA256: 'a'.repeat(64),
      CCMS_EMBEDDER_TOKENIZER_SHA256: 'b'.repeat(64),
      CCMS_EMBEDDER_POOLING: 'mean',
      CCMS_EMBEDDER_PREFIX: '',
      CCMS_EMBEDDER_THREADS: 2,
      CCMS_EMBEDDER_QUEUE: 8,
      CCMS_EMBEDDER_HOST: '127.0.0.1',
      CCMS_EMBEDDER_PORT: 8090,
    });
  });

  it('counts an empty value as unset', () => {
    expect(
      loadSettings({ ...required, CCMS_EMBEDDER_THREADS: '' })
        .CCMS_EMBEDDER_THREADS,
    ).toBe(2);
  });

  it('names every bad setting, never its value', () => {
    let message = '';
    try {
      loadSettings({
        CCMS_EMBEDDER_DIMENSIONS: '2001',
        CCMS_EMBEDDER_MODEL_SHA256: 'secret-ish',
        CCMS_EMBEDDER_POOLING: 'max',
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('CCMS_EMBEDDER_MODEL:');
    expect(message).toContain(
      'CCMS_EMBEDDER_DIMENSIONS: a whole number 1-2000',
    );
    expect(message).toContain('CCMS_EMBEDDER_MODEL_SHA256: the SHA-256');
    expect(message).toContain('CCMS_EMBEDDER_TOKENIZER_SHA256:');
    expect(message).toContain('CCMS_EMBEDDER_POOLING: must be mean or cls');
    expect(message).not.toContain('secret-ish');
  });
});
