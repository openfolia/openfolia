/**
 * Every text a person reads comes from a translation (`'ui.…' | transloco`), never from the
 * template itself. This rule refuses, in Angular templates (inline ones too, through
 * `angular.processInlineTemplates`):
 *
 * - static text with a letter in it (`<button>Save</button>`, `Page {{ n }}`);
 * - a static text attribute with a letter in it (`aria-label="Close"`, `title="…"`, an input
 *   such as `heading="…"` or `emptyTitle="…"`; the names are in `TEXT_ATTRIBUTE` and
 *   `TEXT_SUFFIX`);
 * - a string literal with a letter in it inside an interpolation or a bound text attribute
 *   (`{{ open ? 'Open' : 'Closed' }}`, `[attr.aria-label]="'Account: ' + name"`), unless it is a
 *   translation key (`ui.…`, `editor.…`) that goes into the `transloco` pipe, `t(…)` or
 *   `translated(…)`, a parameter name or a property name (`labels['draft']`).
 *
 * Text without a letter (symbols, digits, punctuation) passes; `allow` lists more exceptions
 * (a keyboard key's name, say). Strings in TypeScript code are not checked here: the
 * pseudo-locale shows those (`frontend/ui/README.md`, "Internationalisation").
 */

const LETTER = /\p{L}/u;
/** Attribute and input names that hold a text a person reads. */
const TEXT_ATTRIBUTE =
  /^(aria-label|aria-description|aria-placeholder|aria-roledescription|aria-valuetext|alt|title|placeholder|label|heading|description|detail|message|tooltip|z(Tooltip|Label|AriaLabel|Title|Description|Placeholder|OkText|CancelText|EmptyText|Content|Text))$/;
/** An input whose name ends like this holds a text too (`emptyTitle`, `actionLabel`). */
const TEXT_SUFFIX =
  /[a-z0-9](Label|Text|Title|Description|Placeholder|Message|Heading|Tooltip)$/;
/** The safety notice's content inputs. */
const NOTICE_INPUT = /^(hazard|consequence|measure)$/;
/** Pipes and functions that turn a key into its text. */
const TRANSLATING_PIPE = new Set(['transloco']);
const TRANSLATING_CALL = new Set(['t', 'translated']);
/** A translation key: a scope, then dotted segments. */
const KEY = /^(ui|editor)\.[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)+$/;

function isText(value, allow) {
  const text = value.trim();
  return text.length > 0 && LETTER.test(text) && !allow.has(text);
}

function isTextAttribute(name) {
  return (
    TEXT_ATTRIBUTE.test(name) ||
    TEXT_SUFFIX.test(name) ||
    NOTICE_INPUT.test(name)
  );
}

/** The name a call goes to (`t` in `t('ui.x')`), if it is a plain name. */
function calleeName(ast) {
  const receiver = ast.receiver;
  return receiver?.constructor?.name === 'PropertyRead'
    ? receiver.name
    : undefined;
}

/**
 * The string literals in an expression AST that are not keys on their way to a translation.
 * `keyOk` is true inside the key argument of the `transloco` pipe, `t(…)` or `translated(…)`.
 */
function literalStrings(ast, out = [], seen = new Set(), keyOk = false) {
  if (!ast || typeof ast !== 'object' || seen.has(ast)) return out;
  seen.add(ast);
  const kind = ast.constructor?.name;
  if (kind === 'LiteralPrimitive' && typeof ast.value === 'string') {
    if (!(keyOk && KEY.test(ast.value))) out.push(ast.value);
    return out;
  }
  if (kind === 'TemplateLiteralElement' && typeof ast.text === 'string') {
    out.push(ast.text);
    return out;
  }
  // A comparison's operands are values the code tests, not texts (`theme === 'dark'`).
  if (kind === 'Binary' && /^[!=]==?$/.test(ast.operation)) return out;
  // A literal map's keys are parameter names; its values are checked.
  if (kind === 'LiteralMap') {
    for (const value of ast.values ?? []) literalStrings(value, out, seen);
    return out;
  }
  // A property name (`labels['draft']`) is not a text; the object it reads from is checked.
  if (kind === 'KeyedRead' || kind === 'SafeKeyedRead') {
    if (ast.key?.constructor?.name !== 'LiteralPrimitive')
      literalStrings(ast.key, out, seen);
    return literalStrings(ast.receiver, out, seen, keyOk);
  }
  if (kind === 'BindingPipe' && TRANSLATING_PIPE.has(ast.name)) {
    literalStrings(ast.exp, out, seen, true);
    for (const arg of ast.args ?? []) literalStrings(arg, out, seen);
    return out;
  }
  if (
    (kind === 'Call' || kind === 'SafeCall') &&
    TRANSLATING_CALL.has(calleeName(ast))
  ) {
    const [key, ...rest] = ast.args ?? [];
    literalStrings(key, out, seen, true);
    for (const arg of rest) literalStrings(arg, out, seen);
    return out;
  }
  // Through a choice or a fallback, a key still goes to the translation
  // (`(open ? 'ui.a' : 'ui.b') | transloco`); anywhere else, it is shown as it is.
  const passesKey =
    kind === 'Conditional' ||
    kind === 'ParenthesizedExpression' ||
    (kind === 'Binary' && /^(\?\?|\|\||&&)$/.test(ast.operation));
  for (const [name, child] of Object.entries(ast)) {
    // Not `parent`: angular-eslint links every node to its parent, the rest of the template.
    if (name === 'parent' || name.endsWith('Span') || name === 'span') continue;
    const childKeyOk = passesKey && name !== 'condition' && keyOk;
    if (Array.isArray(child))
      for (const item of child) literalStrings(item, out, seen, childKeyOk);
    else if (child && typeof child === 'object')
      literalStrings(child, out, seen, childKeyOk);
  }
  return out;
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Texts in templates come from translations, not from literal text.',
    },
    schema: [
      {
        type: 'object',
        properties: { allow: { type: 'array', items: { type: 'string' } } },
        additionalProperties: false,
      },
    ],
    messages: {
      text: 'Literal text "{{text}}" in a template: use a translation key (`… | transloco`).',
      attribute:
        'Literal text in "{{name}}": use a translation key (`[{{name}}]="\'…\' | transloco"`).',
    },
  },
  create(context) {
    const allow = new Set(context.options[0]?.allow ?? []);
    const services = context.sourceCode.parserServices;
    if (!services?.convertNodeSourceSpanToLoc) return {};
    const report = (node, messageId, data) =>
      context.report({
        loc: services.convertNodeSourceSpanToLoc(node.sourceSpan),
        messageId,
        data,
      });
    const checkExpression = (node, value, messageId, data) => {
      for (const text of literalStrings(value)) {
        if (isText(text, allow)) {
          report(node, messageId, { ...data, text: text.trim() });
          return;
        }
      }
    };
    return {
      Text(node) {
        if (isText(node.value, allow))
          report(node, 'text', { text: node.value.trim().slice(0, 40) });
      },
      BoundText(node) {
        const strings = node.value?.ast?.strings ?? [];
        const literal = strings.find((s) => isText(s, allow));
        if (literal !== undefined) {
          report(node, 'text', { text: literal.trim().slice(0, 40) });
          return;
        }
        checkExpression(node, node.value?.ast, 'text', {});
      },
      TextAttribute(node) {
        if (isTextAttribute(node.name) && isText(node.value, allow))
          report(node, 'attribute', { name: node.name });
      },
      BoundAttribute(node) {
        if (isTextAttribute(node.name))
          checkExpression(node, node.value?.ast, 'attribute', {
            name: node.name,
          });
      },
    };
  },
};
