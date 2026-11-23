// Loaded only into a conversion child started from the TypeScript sources
// (tests): an import of `./x.js` from a `.ts` file resolves to `./x.ts`, as
// the TypeScript compiler has it. The built package never loads this file.
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (
        error?.code === 'ERR_MODULE_NOT_FOUND' &&
        specifier.startsWith('.') &&
        specifier.endsWith('.js') &&
        context.parentURL?.endsWith('.ts')
      ) {
        return next(`${specifier.slice(0, -3)}.ts`, context);
      }
      throw error;
    }
  },
});
