import { MemoryTranslationImportStore } from '../../src/translations/repos/memory-translation-import-store.js';

/**
 * Translation imports kept in memory, as the server keeps them: the
 * store itself is in-memory, so its fake is the real one (#51).
 */
export class FakeTranslationImportStore extends MemoryTranslationImportStore {}
