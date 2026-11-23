// The API's error codes, collected from its source, and the catalogue that describes them
// (`error-codes.yaml`): `tests/error-codes.spec.ts` fails when a code the source raises has no
// entry there (or an entry names a code the source no longer raises, or a status it cannot have),
// and the docs site (`frontend/docs`) renders the catalogue as its error code reference.
//
// A code is found where it is written as a literal in a non-spec file under `src/`:
//   - a `code = '…'` property of a class extending `DomainError` (its status from the base class);
//   - the first argument of `new X('…', …)`, where X is a `DomainError` whose constructor takes
//     the code first (`ConflictError`, `UnavailableError`, …), or `JsonApiException` (its status
//     the first argument when that is a number or an `HttpStatus` member);
//   - the argument a local helper takes as its `code` parameter (`refuse('token-revoked', …)`,
//     `this.step('upload-failed', …)`), the helper found by name in the same file: its status a
//     `status` parameter's literal argument, or the error it raises with that code (a helper with a
//     `severity` parameter makes an issue, not an error);
//   - a code forwarded from another error (`new UnprocessableError(error.code, …)`) under an `if`
//     that names it: `error.code === '…'`, or `SET.has(error.code)` where SET is a
//     `new Set(['…', …])` of the same file;
//   - a `code: '…'` member of an object literal with a `detail` (the error objects the HTTP layer
//     writes, the problems of an `UnprocessableProblems`, a job's or an output's error): its
//     status is left to the catalogue. A check's issues (`{ code, message, severity }`) are not
//     error codes.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const apiRoot = join(import.meta.dirname, '..');

/** The HTTP status each domain error class is answered with (`api-exception.filter.ts`). */
export const DOMAIN_STATUS: Readonly<Record<string, number>> = {
  NotFoundError: 404,
  NotConfiguredError: 404,
  GoneError: 410,
  InvalidParameterError: 400,
  ForbiddenError: 403,
  ConflictError: 409,
  InvalidContentError: 422,
  UnprocessableError: 422,
  UnprocessableProblems: 422,
  UnavailableError: 503,
  TooManyRequestsError: 429,
  FailedError: 500,
};

const HTTP_STATUS: Readonly<Record<string, number>> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  NOT_ACCEPTABLE: 406,
  CONFLICT: 409,
  GONE: 410,
  LENGTH_REQUIRED: 411,
  PRECONDITION_FAILED: 412,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  RANGE_NOT_SATISFIABLE: 416,
  UNPROCESSABLE_ENTITY: 422,
  PRECONDITION_REQUIRED: 428,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  NOT_IMPLEMENTED: 501,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
  GATEWAY_TIMEOUT: 504,
};

const CODE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (
      /\.ts$/.test(entry.name) &&
      !/\.(spec|test|d)\.ts$/.test(entry.name)
    )
      files.push(path);
  }
  return files.sort();
}

/** A message's text, its substitutions as `…` (`` `Module ${id} is locked.` `` → `Module … is locked.`). */
const text = (node: ts.Node | undefined): string | undefined => {
  if (!node) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return node.text;
  if (ts.isTemplateExpression(node))
    return (
      node.head.text +
      node.templateSpans.map((s) => '…' + s.literal.text).join('')
    );
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken
  )
    return (text(node.left) ?? '…') + (text(node.right) ?? '…');
  return undefined;
};

const literal = (node: ts.Node | undefined): string | undefined =>
  node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : undefined;

function statusOf(node: ts.Node | undefined): number | undefined {
  if (!node) return undefined;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'HttpStatus'
  )
    return HTTP_STATUS[node.name.text];
  return undefined;
}

/**
 * An error object or a problem (`{ code, detail, … }`), not a check's issue (`{ code, message,
 * severity }`) or a schema refinement (`ctx.addIssue({ code: 'custom', message })`).
 */
const isErrorObject = (
  object: ts.ObjectLiteralExpression,
  file: ts.SourceFile,
) => object.properties.some((p) => p.name?.getText(file) === 'detail');

/** A code, its statuses (empty where the source does not say), where it is raised and its details. */
export interface FoundCode {
  readonly statuses: Set<number>;
  readonly places: string[];
  readonly messages: string[];
}

interface FoundClass {
  readonly base?: string;
  readonly code?: string;
  readonly codeFirst?: boolean;
  readonly path: string;
  readonly node: ts.ClassDeclaration & { name: ts.Identifier };
}

/** Every error code the API's source raises (`messages`: the details it is raised with, where literal). */
export function collectErrorCodes(srcDir = join(apiRoot, 'src')): {
  /** The codes found. */
  readonly codes: Map<string, FoundCode>;
  /**
   * Where a domain error is raised with a code this cannot read (computed, or forwarded without
   * an `if` naming it): each place is to be made readable, so that no code goes uncatalogued.
   */
  readonly unresolved: string[];
} {
  const parsed = sourceFiles(srcDir).map((path) => ({
    path,
    file: ts.createSourceFile(
      path,
      readFileSync(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    ),
  }));

  // Classes: their base, their own `code`, whether their constructor takes the code first.
  const classes = new Map<string, FoundClass>();
  for (const { path, file } of parsed) {
    const visit = (node: ts.Node): void => {
      if (ts.isClassDeclaration(node) && node.name) {
        const heritage = node.heritageClauses?.find(
          (h) => h.token === ts.SyntaxKind.ExtendsKeyword,
        );
        const base = heritage?.types[0]?.expression;
        let code: string | undefined;
        let codeFirst: boolean | undefined;
        for (const member of node.members) {
          if (
            ts.isPropertyDeclaration(member) &&
            member.name.getText(file) === 'code' &&
            !member.modifiers?.some(
              (m) => m.kind === ts.SyntaxKind.AbstractKeyword,
            )
          )
            code = literal(member.initializer);
          if (ts.isConstructorDeclaration(member))
            codeFirst = member.parameters[0]?.name.getText(file) === 'code';
        }
        classes.set(node.name.text, {
          base: base && ts.isIdentifier(base) ? base.text : undefined,
          code,
          codeFirst,
          path,
          node: node as FoundClass['node'],
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  const ancestry = (name: string): string[] => {
    const chain: string[] = [];
    for (
      let at: string | undefined = name;
      at && classes.has(at) && chain.length < 20;
      at = classes.get(at)?.base
    )
      chain.push(at);
    return chain;
  };
  const isDomain = (name: string) => ancestry(name).includes('DomainError');
  const domainStatus = (name: string): number | undefined => {
    for (const at of ancestry(name))
      if (DOMAIN_STATUS[at]) return DOMAIN_STATUS[at];
    // A new kind of domain error needs its status here, as the exception filter has it.
    if (isDomain(name) && name !== 'DomainError')
      throw new Error(
        `error-codes.ts: ${name} is a DomainError whose HTTP status DOMAIN_STATUS does not know; add its kind there.`,
      );
    return undefined;
  };
  /** Whether `new name(…)` takes the code as its first argument (its own constructor or the nearest one). */
  const takesCodeFirst = (name: string): boolean => {
    for (const at of ancestry(name)) {
      const cls = classes.get(at);
      if (cls?.codeFirst !== undefined) return cls.codeFirst;
    }
    return false;
  };

  const codes = new Map<string, FoundCode>();
  const unresolved: string[] = [];
  /** `code` inside a function taking a `code` parameter: its callers' literals are read instead. */
  const inHelper = (node: ts.Node, first: ts.Node, file: ts.SourceFile) => {
    if (!ts.isIdentifier(first) || first.text !== 'code') return false;
    for (let at: ts.Node | undefined = node.parent; at; at = at.parent)
      if (
        ts.isFunctionLike(at) &&
        at.parameters.some((p) => p.name.getText(file) === 'code')
      )
        return true;
    return false;
  };
  const add = (
    code: string,
    status: number | undefined,
    path: string,
    node: ts.Node,
    file: ts.SourceFile,
    message: string | undefined,
  ) => {
    if (!CODE.test(code)) return;
    const entry = codes.get(code) ?? {
      statuses: new Set(),
      places: [],
      messages: [],
    };
    if (status !== undefined) entry.statuses.add(status);
    if (message) entry.messages.push(message);
    const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
    entry.places.push(`${relative(apiRoot, path)}:${line + 1}`);
    codes.set(code, entry);
  };

  for (const [name, cls] of classes) {
    if (cls.code !== undefined && isDomain(name)) {
      const file = cls.node.getSourceFile();
      add(
        cls.code,
        domainStatus(name),
        cls.path,
        cls.node.name,
        file,
        undefined,
      );
    }
  }
  // Local helpers that take a code (a `code` parameter) and raise an error with it.
  interface Helper {
    readonly code: number;
    readonly status?: number;
    readonly message?: number;
    readonly raised?: number;
  }
  const raisesAnything = (body: ts.Node): boolean => {
    let found = false;
    const visit = (node: ts.Node): void => {
      if (found) return;
      if (ts.isNewExpression(node) || ts.isThrowStatement(node)) found = true;
      else ts.forEachChild(node, visit);
    };
    visit(body);
    return found;
  };
  const helpersOf = (file: ts.SourceFile): Map<string, Helper> => {
    const helpers = new Map<string, Helper>();
    const consider = (
      name: string,
      fn: ts.SignatureDeclaration & { body?: ts.Node },
    ) => {
      const params = fn.parameters.map((p) => p.name.getText(file));
      const code = params.indexOf('code');
      // A helper making a check's or a plan's issue (`issue(severity, code, message)`) is not one.
      if (code < 0 || !fn.body || params.includes('severity')) return;
      let raised: number | undefined;
      const find = (node: ts.Node): void => {
        if (raised !== undefined) return;
        if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
          const cls = node.expression.text;
          const args = node.arguments ?? [];
          const passes = (n: ts.Node): boolean =>
            (ts.isIdentifier(n) && n.text === 'code') ||
            (ts.isShorthandPropertyAssignment(n) && n.name.text === 'code') ||
            n.getChildren(file).some(passes);
          if (cls === 'JsonApiException' && args[1] && passes(args[1]))
            raised = statusOf(args[0]);
          else if (isDomain(cls) && args[0] && passes(args[0]))
            raised = domainStatus(cls);
        }
        ts.forEachChild(node, find);
      };
      find(fn.body);
      const message = ['detail', 'message', 'title']
        .map((m) => params.indexOf(m))
        .find((i) => i >= 0);
      const status = params.indexOf('status');
      // A function that only reads a code (`isCheckCode(code)`) raises nothing: not a helper.
      if (raised === undefined && status < 0 && !raisesAnything(fn.body))
        return;
      helpers.set(name, {
        code,
        status: status >= 0 ? status : undefined,
        message,
        raised,
      });
    };
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name)
        consider(node.name.text, node);
      else if (ts.isMethodDeclaration(node))
        consider(node.name.getText(file), node);
      else if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        (ts.isArrowFunction(node.initializer) ||
          ts.isFunctionExpression(node.initializer))
      )
        consider(node.name.text, node.initializer);
      ts.forEachChild(node, visit);
    };
    visit(file);
    return helpers;
  };

  // The error objects of a `new JsonApiException(status, [...])`, with that status.
  const statusOfObject = new Map<ts.Node, number>();
  /** `const NAME = new Set(['…', …])` of a file: its codes by name. */
  const setsOf = (file: ts.SourceFile): Map<string, string[]> => {
    const sets = new Map<string, string[]>();
    const visit = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isNewExpression(node.initializer) &&
        ts.isIdentifier(node.initializer.expression) &&
        node.initializer.expression.text === 'Set' &&
        node.initializer.arguments?.[0] &&
        ts.isArrayLiteralExpression(node.initializer.arguments[0])
      ) {
        const codes = node.initializer.arguments[0].elements.map(literal);
        if (codes.every((c) => c !== undefined))
          sets.set(node.name.text, codes as string[]);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    return sets;
  };
  const unwrap = (node: ts.Node): ts.Node =>
    ts.isNonNullExpression(node) ||
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node)
      ? unwrap(node.expression)
      : node;
  const isCodeOf = (node: ts.Node) => {
    const at = unwrap(node);
    return ts.isPropertyAccessExpression(at) && at.name.text === 'code';
  };
  /** `const NAME = '…'` and `const NAME = { key: '…', … }` of every file, by name. */
  const constants = new Map<string, ts.Expression>();
  for (const { file } of parsed) {
    const visit = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isVariableDeclarationList(node.parent) &&
        node.parent.flags & ts.NodeFlags.Const
      )
        constants.set(node.name.text, node.initializer);
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  /**
   * The codes an expression can be: a literal, either branch of a `? :`, a constant, any value of
   * a constant object indexed (`XLIFF_CODES[error.reason]`).
   */
  const codesOf = (
    node: ts.Node,
    file: ts.SourceFile,
    sets: Map<string, string[]>,
    depth = 0,
  ): string[] | undefined => {
    const at = unwrap(node);
    const value = literal(at);
    if (value !== undefined) return [value];
    if (depth > 5) return undefined;
    if (ts.isConditionalExpression(at)) {
      const a = codesOf(at.whenTrue, file, sets, depth + 1);
      const b = codesOf(at.whenFalse, file, sets, depth + 1);
      return Array.isArray(a) && Array.isArray(b) ? [...a, ...b] : undefined;
    }
    if (ts.isIdentifier(at) && constants.has(at.text))
      return codesOf(constants.get(at.text)!, file, sets, depth + 1);
    if (ts.isElementAccessExpression(at) && ts.isIdentifier(at.expression)) {
      const object = constants.get(at.expression.text);
      const map = object && unwrap(object);
      if (map && ts.isObjectLiteralExpression(map)) {
        const values = map.properties.map((p) =>
          ts.isPropertyAssignment(p) ? literal(p.initializer) : undefined,
        );
        if (values.every((v) => v !== undefined)) return values as string[];
      }
      return undefined;
    }
    return undefined;
  };
  /** The codes the nearest `if` around `node` lets through, from its condition. */
  const guardedCodes = (
    node: ts.Node,
    file: ts.SourceFile,
    sets: Map<string, string[]>,
  ): string[] => {
    for (let at: ts.Node = node; at.parent; at = at.parent) {
      const parent = at.parent;
      if (!ts.isIfStatement(parent) || parent.thenStatement !== at) continue;
      const codes: string[] = [];
      const read = (n: ts.Node): void => {
        if (
          ts.isBinaryExpression(n) &&
          (n.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
            n.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken)
        ) {
          const [a, b] = [n.left, n.right];
          const value = isCodeOf(a)
            ? literal(b)
            : isCodeOf(b)
              ? literal(a)
              : undefined;
          if (value !== undefined) codes.push(value);
        }
        if (
          ts.isCallExpression(n) &&
          ts.isPropertyAccessExpression(n.expression) &&
          n.expression.name.text === 'has' &&
          ts.isIdentifier(n.expression.expression) &&
          n.arguments[0] &&
          isCodeOf(n.arguments[0])
        )
          codes.push(...(sets.get(n.expression.expression.text) ?? []));
        ts.forEachChild(n, read);
      };
      read(parent.expression);
      if (codes.length > 0) return codes;
    }
    return [];
  };

  for (const { path, file } of parsed) {
    const helpers = helpersOf(file);
    const sets = setsOf(file);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const name = ts.isIdentifier(callee)
          ? callee.text
          : ts.isPropertyAccessExpression(callee) &&
              callee.expression.kind === ts.SyntaxKind.ThisKeyword
            ? callee.name.text
            : undefined;
        const helper = name === undefined ? undefined : helpers.get(name);
        const arg = helper && node.arguments[helper.code];
        const code = literal(arg);
        if (helper && arg && code !== undefined)
          add(
            code,
            helper.status !== undefined
              ? statusOf(node.arguments[helper.status])
              : helper.raised,
            path,
            arg,
            file,
            helper.message !== undefined
              ? text(node.arguments[helper.message])
              : undefined,
          );
      }
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
        const name = node.expression.text;
        const args = node.arguments ?? [];
        if (name === 'JsonApiException') {
          // Its error objects' `code` members are found below; the status is its first argument.
          const status = statusOf(args[0]);
          if (status !== undefined && args[1]) {
            const mark = (child: ts.Node): void => {
              if (ts.isObjectLiteralExpression(child))
                statusOfObject.set(child, status);
              ts.forEachChild(child, mark);
            };
            mark(args[1]);
          }
        } else if (isDomain(name) && takesCodeFirst(name)) {
          const first = args[0];
          const read = first && codesOf(first, file, sets);
          if (
            first &&
            name === 'UnprocessableProblems' &&
            isCodeOf(first) &&
            args[2] !== undefined
          ) {
            // A problem's code (`new UnprocessableProblems(p.code, …, problems)`): the problems'
            // `{ code, detail }` objects are found where they are written.
          } else if (first && read && read.length > 0)
            for (const code of read)
              add(
                code,
                domainStatus(name),
                path,
                first,
                file,
                literal(first) !== undefined ? text(args[1]) : undefined,
              );
          else if (
            first &&
            isCodeOf(first) &&
            guardedCodes(node, file, sets).length > 0
          )
            for (const forwarded of guardedCodes(node, file, sets))
              add(forwarded, domainStatus(name), path, first, file, undefined);
          else if (first && !inHelper(node, first, file))
            unresolved.push(
              `${relative(apiRoot, path)}:${file.getLineAndCharacterOfPosition(first.getStart(file)).line + 1}: new ${name}(${first.getText(file)}, …)`,
            );
        }
      }
      if (
        ts.isPropertyAssignment(node) &&
        node.name.getText(file) === 'code' &&
        ts.isObjectLiteralExpression(node.parent) &&
        isErrorObject(node.parent, file)
      ) {
        const code = literal(node.initializer);
        const detail = node.parent.properties.find(
          (p): p is ts.PropertyAssignment =>
            ts.isPropertyAssignment(p) && p.name.getText(file) === 'detail',
        );
        if (code !== undefined)
          add(
            code,
            statusOfObject.get(node.parent),
            path,
            node,
            file,
            text(detail?.initializer),
          );
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return { codes, unresolved };
}
