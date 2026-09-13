import type { Context, Diagnostic, Rule } from "@oxlint/plugins";

/**
 * Runs a rule inside the vitest process, against a hand-built AST.
 *
 * `createOxlintRuleHarness` in `./utils.ts` spawns the real `oxlint` binary, so
 * it proves the plugin is wired up end to end — but the rule source then
 * executes in that child process, where nothing it does is visible to this
 * process's coverage or to a debugger. This harness is the other half: it calls
 * `create`/`createOnce` directly, so the rule's own logic runs here.
 *
 * The package ships no parser, so callers build the node shapes they need with
 * the builders below. The rules read a small, fixed set of ESTree properties,
 * which is what makes that practical.
 */
export interface TestNode {
  readonly type: string;
  readonly [key: string]: unknown;
}

/** One `context.report(...)` call, flattened to the parts a test asserts on. */
export interface RuleReport {
  readonly message: string;
  readonly reportedNode: TestNode | undefined;
}

export interface RunRuleOptions {
  /** Absolute path the rule sees as `context.filename`. */
  readonly filename?: string;
  /** Absolute path the rule sees as `context.cwd`. */
  readonly cwd?: string;
}

const DEFAULT_FILENAME = "/repo/apps/server/src/fixture.ts";
const DEFAULT_CWD = "/repo";

const isTestNode = (value: unknown): value is TestNode =>
  typeof value === "object" &&
  value !== null &&
  "type" in value &&
  typeof (value as { readonly type: unknown }).type === "string";

interface CapturedVisitor {
  readonly handlers: Record<string, ((node: TestNode) => void) | undefined>;
  readonly before: (() => boolean | void) | undefined;
  readonly after: (() => void) | undefined;
}

/**
 * `VisitorObject` carries an index signature of node handlers, so `before` and
 * `after` cannot be read off the union without a cast. Narrowing by `typeof`
 * keeps the cast honest.
 */
const captureVisitor = (created: unknown): CapturedVisitor => {
  const record = created as Record<string, unknown>;
  return {
    handlers: record as Record<string, ((node: TestNode) => void) | undefined>,
    before:
      typeof record.before === "function" ? (record.before as () => boolean | void) : undefined,
    after: typeof record.after === "function" ? (record.after as () => void) : undefined,
  };
};

/**
 * Depth-first walk in the order oxlint traverses: enter a node, descend into
 * its children, then fire the matching `:exit` handler. `parent` is assigned
 * before the enter handler runs, because rules read it (see
 * `isImmediatelyInvoked` in `no-inline-schema-compile`).
 */
const walk = (
  node: TestNode,
  parent: TestNode | undefined,
  handlers: CapturedVisitor["handlers"],
): void => {
  Object.assign(node, { parent });

  handlers[node.type]?.(node);

  for (const [key, value] of Object.entries(node)) {
    if (key === "parent") continue;
    if (isTestNode(value)) {
      walk(value, node, handlers);
      continue;
    }
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (isTestNode(item)) walk(item, node, handlers);
    }
  }

  handlers[`${node.type}:exit`]?.(node);
};

export interface RuleSession {
  /** Lints one file's AST and returns everything the rule reported for it. */
  readonly lint: (ast: TestNode, options?: RunRuleOptions) => RuleReport[];
}

/**
 * Mirrors how oxlint drives a rule across several files in one lint run.
 *
 * A `createOnce` rule is constructed once and keeps its closure state for every
 * later file, relying on its `before` hook to reset per file. Linting two files
 * through one session is therefore the only way a test can catch state leaking
 * from one file into the next. A `create` rule is rebuilt per file, as oxlint
 * does, because it reads `context.filename` at construction time.
 */
export const createRuleSession = (rule: Rule): RuleSession => {
  let filename = DEFAULT_FILENAME;
  let cwd = DEFAULT_CWD;
  let reports: RuleReport[] = [];

  const context = {
    id: "ch3/rule-under-test",
    options: [],
    get filename() {
      return filename;
    },
    get cwd() {
      return cwd;
    },
    report: (diagnostic: Diagnostic) => {
      reports.push({
        message: diagnostic.message ?? "",
        reportedNode: isTestNode(diagnostic.node) ? diagnostic.node : undefined,
      });
    },
  } as unknown as Context;

  let sharedVisitor: CapturedVisitor | undefined;
  let createPerFile: ((context: Context) => unknown) | undefined;
  if ("createOnce" in rule) sharedVisitor = captureVisitor(rule.createOnce(context));
  else createPerFile = rule.create;

  return {
    lint(ast, options = {}) {
      reports = [];
      filename = options.filename ?? DEFAULT_FILENAME;
      cwd = options.cwd ?? DEFAULT_CWD;

      const visitor = sharedVisitor ?? captureVisitor(createPerFile?.(context));
      if (visitor.before?.() === false) return reports;
      walk(ast, undefined, visitor.handlers);
      visitor.after?.();

      return reports;
    },
  };
};

/** Lints a single AST with a fresh rule instance. */
export const runRule = (rule: Rule, ast: TestNode, options: RunRuleOptions = {}): RuleReport[] =>
  createRuleSession(rule).lint(ast, options);

/** `runRule`, reduced to the diagnostic messages. */
export const runRuleMessages = (
  rule: Rule,
  ast: TestNode,
  options: RunRuleOptions = {},
): string[] => runRule(rule, ast, options).map((report) => report.message);

// --- node builders ----------------------------------------------------------

export const identifier = (name: string): TestNode => ({ type: "Identifier", name });

export const privateIdentifier = (name: string): TestNode => ({
  type: "PrivateIdentifier",
  name,
});

export const literal = (value: string | number | boolean | null): TestNode => ({
  type: "Literal",
  value,
});

export const member = (object: TestNode, property: TestNode, computed = false): TestNode => ({
  type: "MemberExpression",
  object,
  property,
  computed,
  optional: false,
});

export const call = (callee: TestNode, args: readonly TestNode[] = []): TestNode => ({
  type: "CallExpression",
  callee,
  arguments: [...args],
  optional: false,
});

export const arrow = (body: TestNode): TestNode => ({
  type: "ArrowFunctionExpression",
  params: [],
  body,
});

export const functionDeclaration = (name: string, body: readonly TestNode[]): TestNode => ({
  type: "FunctionDeclaration",
  id: identifier(name),
  params: [],
  body: { type: "BlockStatement", body: [...body] },
});

export const functionExpression = (body: readonly TestNode[]): TestNode => ({
  type: "FunctionExpression",
  id: null,
  params: [],
  body: { type: "BlockStatement", body: [...body] },
});

export const expressionStatement = (expression: TestNode): TestNode => ({
  type: "ExpressionStatement",
  expression,
});

export const variableDeclaration = (name: string, init: TestNode): TestNode => ({
  type: "VariableDeclaration",
  kind: "const",
  declarations: [{ type: "VariableDeclarator", id: identifier(name), init }],
});

export const program = (body: readonly TestNode[]): TestNode => ({
  type: "Program",
  body: [...body],
});

export const namespaceSpecifier = (local: string): TestNode => ({
  type: "ImportNamespaceSpecifier",
  local: identifier(local),
});

export const defaultSpecifier = (local: string): TestNode => ({
  type: "ImportDefaultSpecifier",
  local: identifier(local),
});

export const namedSpecifier = (imported: string, local = imported): TestNode => ({
  type: "ImportSpecifier",
  imported: identifier(imported),
  local: identifier(local),
});

export const importDeclaration = (
  source: TestNode | string,
  specifiers: readonly TestNode[] = [],
): TestNode => ({
  type: "ImportDeclaration",
  source: typeof source === "string" ? literal(source) : source,
  specifiers: [...specifiers],
});

// Expression wrappers `utils.ts#unwrapExpression` is expected to see through.
export const asExpression = (expression: TestNode): TestNode => ({
  type: "TSAsExpression",
  expression,
  typeAnnotation: { type: "TSUnknownKeyword" },
});

export const nonNullExpression = (expression: TestNode): TestNode => ({
  type: "TSNonNullExpression",
  expression,
});

export const parenthesized = (expression: TestNode): TestNode => ({
  type: "ParenthesizedExpression",
  expression,
});

export const chain = (expression: TestNode): TestNode => ({
  type: "ChainExpression",
  expression,
});
