import noHtmlText from './no-html-text.mjs';
import noLiteralText from './no-literal-text.mjs';

/** Local lint rules of the frontend, shared by the UI library and the apps. */
export default {
  rules: { 'no-html-text': noHtmlText, 'no-literal-text': noLiteralText },
};
