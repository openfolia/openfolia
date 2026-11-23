/**
 * A text built from a translation and its parameters (a person's name, a group, a title) is
 * shown as text, never as HTML: a name with markup in it would otherwise render as markup. This
 * rule refuses the places that would show such a text as HTML:
 *
 * - in Angular templates (inline ones too, through `angular.processInlineTemplates`), a binding
 *   to `innerHTML` or `outerHTML` (`[innerHTML]="…"`; in any case, since Angular maps
 *   `[innerHtml]` to the same property);
 * - in TypeScript, a host binding to them (`host: { '[innerHTML]': … }`,
 *   `@HostBinding('innerHTML')`), an assignment to `.innerHTML` or `.outerHTML`, an object key
 *   `innerHTML` (`Object.assign(el, { innerHTML })`), `renderer.setProperty(el, 'innerHTML', …)`
 *   and a call to `insertAdjacentHTML`;
 * - in TypeScript, a string given as a dialog's or sheet's `zContent` (`zContent: this.t(…)`,
 *   `zContent: '…'`, a template literal, a concatenation): the container shows a string
 *   `zContent` as HTML. Text goes into `zDescription`, which is plain text, and a translation
 *   that needs its own markup into the alert dialog's `zDescriptionHtml`, which escapes the
 *   parameters itself (`frontend/ui/README.md`, the alert dialog in "What belongs here").
 *
 * A place that has to show HTML says why with an `eslint-disable-next-line` comment. A string
 * that reaches `zContent` through a variable is not seen: the rule reads syntax, not types.
 */

/** `innerHTML` or `outerHTML`, in any case (Angular maps `[innerHtml]` to `innerHTML`). */
const HTML_PROPERTY = /^(innerhtml|outerhtml)$/i;
const HTML_HOST_KEY = /^\[(innerhtml|outerhtml)\]$/i;
const isHtmlProperty = (name) =>
  typeof name === 'string' && HTML_PROPERTY.test(name);
/** The first string argument of a call or decorator (`'innerHTML'` in `@HostBinding('innerHTML')`). */
const stringArgument = (call, index) => {
  const arg = call.arguments?.[index];
  return arg?.type === 'Literal' && typeof arg.value === 'string'
    ? arg.value
    : undefined;
};
/** Calls that return a translated string. */
const TRANSLATING = new Set(['t', 'translate', 'instant']);

/** The name of a property key (`zContent`, `'zContent'`, `'[innerHTML]'`). */
function keyName(property) {
  if (property.computed) return undefined;
  const key = property.key;
  if (key.type === 'Identifier') return key.name;
  if (key.type === 'Literal' && typeof key.value === 'string') return key.value;
  return undefined;
}

/** The name a call goes to: `t` in `t(…)`, `this.t(…)` and `transloco.translate(…)`. */
function calleeName(call) {
  const callee = call.callee;
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type === 'MemberExpression' && !callee.computed) {
    return callee.property.name;
  }
  return undefined;
}

/** Whether an expression is plainly a string: a literal, a template, a concatenation, a translation. */
function isString(node) {
  switch (node.type) {
    case 'Literal':
      return typeof node.value === 'string';
    case 'TemplateLiteral':
      return true;
    case 'BinaryExpression':
      return (
        node.operator === '+' && (isString(node.left) || isString(node.right))
      );
    case 'CallExpression':
      return TRANSLATING.has(calleeName(node) ?? '');
    case 'ConditionalExpression':
      return isString(node.consequent) || isString(node.alternate);
    case 'LogicalExpression':
      return isString(node.left) || isString(node.right);
    case 'TSAsExpression':
    case 'TSNonNullExpression':
      return isString(node.expression);
    default:
      return false;
  }
}

/** The property a member expression names (`innerHTML` in `el.innerHTML`). */
function memberName(node) {
  if (node.type !== 'MemberExpression') return undefined;
  if (!node.computed) return node.property.name;
  return node.property.type === 'Literal' ? node.property.value : undefined;
}

const MESSAGES = {
  binding:
    '`{{name}}` shows its value as HTML: a name in it would render as markup. Bind it as text (an interpolation).',
  dom: '`{{name}}` writes HTML: a name in it would render as markup. Set `textContent` instead.',
  content:
    "A string `zContent` is shown as HTML: a name in it would render as markup. Put text into `zDescription` (plain text), a translation with markup into the alert dialog's `zDescriptionHtml`, or pass a template.",
};

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Refuses showing a text as HTML (innerHTML, a string dialog zContent), where a name in it would render as markup.',
    },
    schema: [],
    messages: MESSAGES,
  },
  create(context) {
    return {
      // Angular templates (@angular-eslint/template-parser).
      BoundAttribute(node) {
        if (isHtmlProperty(node.name)) {
          context.report({
            node,
            messageId: 'binding',
            data: { name: `[${node.name}]` },
          });
        }
      },
      // TypeScript.
      Property(node) {
        const name = keyName(node);
        if (name && HTML_HOST_KEY.test(name)) {
          context.report({ node, messageId: 'binding', data: { name } });
        } else if (isHtmlProperty(name)) {
          context.report({ node, messageId: 'dom', data: { name } });
        } else if (name === 'zContent' && isString(node.value)) {
          context.report({ node, messageId: 'content' });
        }
      },
      AssignmentExpression(node) {
        const name = memberName(node.left);
        if (isHtmlProperty(name)) {
          context.report({ node, messageId: 'dom', data: { name } });
        }
      },
      CallExpression(node) {
        const callee = calleeName(node);
        if (callee === 'insertAdjacentHTML') {
          context.report({
            node,
            messageId: 'dom',
            data: { name: 'insertAdjacentHTML' },
          });
        } else if (callee === 'setProperty') {
          const name = stringArgument(node, 1);
          if (isHtmlProperty(name)) {
            context.report({ node, messageId: 'dom', data: { name } });
          }
        } else if (callee === 'HostBinding') {
          const name = stringArgument(node, 0);
          if (isHtmlProperty(name)) {
            context.report({
              node,
              messageId: 'binding',
              data: { name: `@HostBinding('${name}')` },
            });
          }
        }
      },
    };
  },
};
