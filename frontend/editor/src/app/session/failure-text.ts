import {
  injectTranslate,
  translated,
  type TranslatedText,
} from '@openfolia/ui/startup';

import type { ApiError } from '../api';
import { apiErrorText } from '../i18n';

/**
 * A failure for a toast: what was being done (a key with its parameters) and why (the API's
 * error, by its stable code). Built into one text when it is shown.
 */
export function injectFailureText(): (
  what: TranslatedText,
  error: ApiError,
) => string {
  const t = injectTranslate();
  return (what, error) => {
    const why = apiErrorText(error);
    return t(translated('editor.session.failure').key, {
      what: t(what.key, what.params),
      why: t(why.key, why.params),
    });
  };
}
