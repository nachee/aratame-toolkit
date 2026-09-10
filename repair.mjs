import { createHash } from "node:crypto";
import path from "node:path";
import ts from "typescript";
import { z } from "zod";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().min(1).max(2000);
const scriptPath = z
  .string()
  .max(500)
  .refine(
    (value) =>
      !value.includes("\\") &&
      !value.startsWith("/") &&
      value.split("/").every((part) => part && part !== "." && part !== "..") &&
      /\.(?:[cm]?[jt]sx?)$/.test(value),
    "Unsafe script path",
  );
const changeSchema = z
  .object({
    start: z.number().int().min(0).max(500_000),
    end: z.number().int().min(1).max(500_000),
    before: text,
    after: text,
  })
  .strict();
export const repairRequestSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("locator"),
      changes: z.array(changeSchema).min(1).max(12),
    })
    .strict(),
  z.object({ kind: z.literal("behavioral"), reason: text }).strict(),
]);
const envelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("linked-script-repair"),
    caseId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
    caseVersion: z.number().int().positive(),
    expected: z.string().min(1).max(10_000),
    steps: z.array(z.string().min(1).max(2000)).min(1).max(50),
    baseUrl: z.string().max(2000),
    original: z
      .object({
        specPath: scriptPath,
        specTag: z.string().max(500).optional(),
        sha256: digest,
      })
      .strict(),
    proposedSpecPath: scriptPath,
    changes: z.array(changeSchema).max(12),
    proof: z
      .object({
        unchangedSha256: digest,
        actionsSha256: digest,
        assertionsSha256: digest,
        assertionCount: z.number().int().min(0).max(10_000),
      })
      .strict(),
    proposedSha256: digest,
    classification: z
      .object({
        category: z.enum(["locator_only", "behavior_preserving", "behavioral"]),
        rationale: text,
        ambiguous: z.boolean(),
        applicable: z.boolean(),
      })
      .strict(),
    attempt: z.number().int().min(1).max(3),
    originalFailure: z
      .object({
        status: z.literal("failed"),
        detail: text,
        evidence: z.string().max(1000).optional(),
        testCount: z.number().int().min(1),
      })
      .strict(),
    diff: z.string().max(48_000),
  })
  .strict();
const actions = new Set([
  "click",
  "dblclick",
  "fill",
  "check",
  "uncheck",
  "selectOption",
  "press",
  "hover",
  "focus",
  "blur",
  "tap",
  "clear",
]);
const locatorMethods = new Set([
  "locator",
  "getByRole",
  "getByLabel",
  "getByText",
  "getByPlaceholder",
  "getByTestId",
  "getByAltText",
  "getByTitle",
]);
const secretPattern =
  /-----BEGIN [A-Z ]*PRIVATE KEY|\bBearer\s+\S+|\b(?:sk|ghp|github_pat)[-_][A-Za-z0-9_-]{16,}|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|(?:password|passwd|api[_-]?key|access[_-]?token|secret)\s*[=:]\s*["']?[^\s"']{4,}|https?:\/\/[^\s/]+:[^\s/]+@/i;
export function redactRepairText(value) {
  return String(value).replace(
    new RegExp(secretPattern.source, "gi"),
    "[REDACTED]",
  );
}
function safeText(value) {
  if (redactRepairText(value) !== value)
    throw new Error(
      "Repair projection contains a possible secret; keep it local",
    );
  return value;
}
function parse(source, specPath = "repair.ts") {
  if (typeof source !== "string" || source.length > 500_000)
    throw new Error("Repair source exceeds 500000 characters");
  const file = ts.createSourceFile(
    specPath,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  if (file.parseDiagnostics.length)
    throw new Error("Repair source must parse without syntax errors");
  return file;
}
function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => {
    walk(child, visit);
  });
}
function member(node) {
  return ts.isPropertyAccessExpression(node) && !node.questionDotToken
    ? node.name.text
    : undefined;
}
function locator(expression) {
  safeText(expression);
  const file = parse(expression, "locator.ts");
  const statement = file.statements[0];
  if (file.statements.length !== 1 || !ts.isExpressionStatement(statement))
    throw new Error("Only a locator expression is allowed");
  const node = statement.expression;
  if (
    node.getStart(file) !== 0 ||
    node.end !== expression.length ||
    !ts.isCallExpression(node) ||
    node.questionDotToken ||
    node.typeArguments?.length
  )
    throw new Error(
      "Locator must be a complete direct call without extra syntax",
    );
  const method = member(node.expression);
  if (
    !locatorMethods.has(method) ||
    !ts.isIdentifier(node.expression.expression) ||
    node.expression.expression.text !== "page"
  )
    throw new Error("Only direct page locator calls are repairable");
  const args = node.arguments;
  if (
    args.length < 1 ||
    args.length > 2 ||
    !ts.isStringLiteral(args[0]) ||
    !args[0].text.trim()
  )
    throw new Error("Locator requires a nonempty literal string");
  if (method === "locator") {
    const selector = args[0].text.trim();
    const equals = selector.indexOf("=");
    const prefix = equals === -1 ? "" : selector.slice(0, equals).trim();
    // Playwright dispatches trimmed engine prefixes; CSS attribute brackets are not prefixes.
    let engine = "css";
    if (equals !== -1 && /^[a-zA-Z_0-9-+:*]+$/.test(prefix)) engine = prefix;
    else if (
      selector.length > 1 &&
      ((selector.startsWith('"') && selector.endsWith('"')) ||
        (selector.startsWith("'") && selector.endsWith("'")))
    )
      engine = "text";
    else if (/^\(*\/\//.test(selector) || selector.startsWith(".."))
      engine = "xpath";
    if (engine !== "css" || selector.includes(">>"))
      throw new Error(
        "Only CSS selectors without custom, implicit text/XPath, capture or chained engines can be repaired",
      );
  }
  const options = {};
  if (args[1]) {
    if (
      ["locator", "getByTestId"].includes(method) ||
      !ts.isObjectLiteralExpression(args[1])
    )
      throw new Error("Unsupported locator options");
    for (const prop of args[1].properties) {
      if (
        !ts.isPropertyAssignment(prop) ||
        !ts.isIdentifier(prop.name) ||
        Object.hasOwn(options, prop.name.text)
      )
        throw new Error("Only unique literal locator options are allowed");
      const key = prop.name.text;
      if (
        key === "exact" &&
        [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(
          prop.initializer.kind,
        )
      )
        options.exact = prop.initializer.kind === ts.SyntaxKind.TrueKeyword;
      else if (
        key === "name" &&
        method === "getByRole" &&
        ts.isStringLiteral(prop.initializer) &&
        prop.initializer.text.trim()
      )
        options.name = prop.initializer.text;
      else
        throw new Error(
          "Locator options cannot contain code or change filtering semantics",
        );
    }
  }
  if (method === "getByRole" && !options.name)
    throw new Error("Role locator requires a literal accessible name");
  // Comments and escapes can conceal credentials or syntax; inspect decoded literals as well.
  safeText(JSON.stringify([args[0].text, options]));
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    expression,
  );
  for (
    let token = scanner.scan();
    token !== ts.SyntaxKind.EndOfFileToken;
    token = scanner.scan()
  ) {
    if (
      [
        ts.SyntaxKind.SingleLineCommentTrivia,
        ts.SyntaxKind.MultiLineCommentTrivia,
      ].includes(token)
    )
      throw new Error("Locator comments are not repair syntax");
  }
  return { method, value: args[0].text, options };
}
function expressionCall(source) {
  safeText(source);
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    source,
  );
  for (
    let token = scanner.scan();
    token !== ts.SyntaxKind.EndOfFileToken;
    token = scanner.scan()
  ) {
    if (
      [
        ts.SyntaxKind.SingleLineCommentTrivia,
        ts.SyntaxKind.MultiLineCommentTrivia,
      ].includes(token)
    )
      throw new Error(
        "Repair call comments must remain local, not included in review diffs",
      );
  }
  const file = parse(source);
  const statement = file.statements[0],
    node = statement?.expression;
  if (
    file.statements.length !== 1 ||
    !ts.isExpressionStatement(statement) ||
    !node ||
    !ts.isCallExpression(node) ||
    node.getStart(file) !== 0 ||
    node.end !== source.length ||
    node.questionDotToken ||
    node.typeArguments?.length
  )
    throw new Error("Repair requires one complete bounded call");
  return { file, node };
}
function legacyAction(source) {
  const { file, node } = expressionCall(source);
  const method = member(node.expression);
  if (
    !["click", "fill"].includes(method) ||
    !ts.isIdentifier(node.expression.expression) ||
    node.expression.expression.text !== "page" ||
    node.arguments.length !== (method === "click" ? 2 : 3) ||
    !ts.isStringLiteral(node.arguments[0]) ||
    (method === "fill" && !ts.isStringLiteral(node.arguments[1]))
  )
    throw new Error(
      "Legacy page.click/page.fill require a sole explicit strict boolean option",
    );
  const options = node.arguments.at(-1);
  const option =
    ts.isObjectLiteralExpression(options) && options.properties.length === 1
      ? options.properties[0]
      : undefined;
  if (
    !option ||
    !ts.isPropertyAssignment(option) ||
    !ts.isIdentifier(option.name) ||
    option.name.text !== "strict" ||
    ![ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(
      option.initializer.kind,
    )
  )
    throw new Error(
      "Only explicit strict:true or strict:false may be mapped; other options are not repairable",
    );
  const strict = option.initializer.kind === ts.SyntaxKind.TrueKeyword;
  const selector = locator(`page.locator(${node.arguments[0].getText(file)})`);
  if (
    method === "fill" &&
    /password|passwd|secret|token|credential/i.test(selector.value)
  )
    throw new Error(
      "Credential-filling source cannot be included in a repair diff",
    );
  const remainder =
    method === "fill"
      ? source.slice(node.arguments[0].end, node.arguments[1].end)
      : "";
  if (method === "fill" && !remainder.startsWith(","))
    throw new Error("Unsupported legacy argument separator");
  const args = method === "fill" ? remainder.slice(1) : "";
  if (method === "fill") safeText(node.arguments[1].text);
  return {
    method,
    selector,
    args,
    strict,
    value: method === "fill" ? node.arguments[1].text : undefined,
  };
}
function selectionLocator(source, strict) {
  if (strict) {
    const target = locator(source);
    if (target.method !== "locator")
      throw new Error("Legacy normalization requires a literal CSS locator");
    return target;
  }
  const { file, node } = expressionCall(source);
  if (
    member(node.expression) !== "first" ||
    node.arguments.length ||
    !ts.isCallExpression(node.expression.expression)
  )
    throw new Error("Legacy normalization must preserve first-match selection");
  const target = locator(node.expression.expression.getText(file));
  if (target.method !== "locator")
    throw new Error("Legacy normalization requires a literal CSS locator");
  return target;
}
function changeMechanic(change) {
  let legacy;
  try {
    legacy = legacyAction(change.before);
  } catch {
    /* Not legacy action grammar. */
  }
  if (!legacy)
    return {
      before: locator(change.before),
      after: locator(change.after),
      legacy: false,
    };
  const { file, node } = expressionCall(change.after);
  if (
    member(node.expression) !== legacy.method ||
    !ts.isCallExpression(node.expression.expression) ||
    node.arguments.length !== (legacy.method === "click" ? 0 : 1)
  )
    throw new Error(
      "Legacy repair must preserve the exact action and argument count",
    );
  const target = selectionLocator(
    node.expression.expression.getText(file),
    legacy.strict,
  );
  if (change.after.slice(node.expression.end + 1, node.end - 1) !== legacy.args)
    throw new Error(
      "Legacy repair must preserve action argument bytes exactly",
    );
  return {
    before: legacy.selector,
    after: target,
    legacy: true,
    value: legacy.value,
  };
}
function declaredLegacyValue(value, item) {
  if (value === undefined) return;
  const preconditions = Array.isArray(item.preconditions)
    ? item.preconditions
    : [item.preconditions || ""];
  const approved = [...(item.steps || []), ...preconditions].join("\n");
  if (!value || !approved.includes(value))
    throw new Error(
      "Legacy fill value is not explicitly present in approved steps or preconditions; keep this source local and request manual automation revision",
    );
}
function expandRepairRequests(source, changes, item) {
  const slots = analyzeRepairSource(source, item).locators;
  return z
    .array(changeSchema)
    .max(12)
    .parse(changes)
    .map((change) => {
      const slot = slots.find(
        (entry) =>
          entry.legacy &&
          entry.start === change.start &&
          entry.end === change.end &&
          entry.before === change.before,
      );
      if (!slot) return change;
      selectionLocator(change.after, slot.strict);
      const before = source.slice(slot.start, slot.callEnd);
      const original = legacyAction(before);
      declaredLegacyValue(original.value, item);
      return {
        start: slot.start,
        end: slot.callEnd,
        before,
        after: `${change.after}.${original.method}(${original.args})`,
      };
    });
}
function actionFingerprint(node, source, file) {
  const original = source.slice(node.getStart(file), node.end);
  try {
    const legacy = legacyAction(original);
    return {
      method: legacy.method,
      args: legacy.args,
      selection: legacy.strict ? "strict" : "first",
    };
  } catch {
    /* Existing non-legacy actions retain their source shape. */
  }
  const receiver =
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.expression;
  if (receiver && ts.isCallExpression(receiver)) {
    const target = receiver.getText(file);
    let selection = "strict";
    try {
      locator(target);
    } catch {
      try {
        selectionLocator(target, false);
        selection = "first";
      } catch {
        return original;
      }
    }
    return {
      method: member(node.expression),
      args: source.slice(node.expression.end + 1, node.end - 1),
      selection,
    };
  }
  return original;
}
function normalizedChanges(changes) {
  const result = z
    .array(changeSchema)
    .max(12)
    .parse(changes)
    .sort((a, b) => a.start - b.start);
  let end = -1;
  for (const change of result) {
    if (
      change.start < end ||
      change.end <= change.start ||
      change.end - change.start !== change.before.length ||
      change.before === change.after
    )
      throw new Error(
        "Repair changes overlap, are empty, or do not match their original span",
      );
    changeMechanic(change);
    end = change.end;
  }
  return result;
}
function candidatePath(proposal) {
  const extension = proposal.original.specPath.split(".").at(-1);
  return `e2e/aratame/repairs/${proposal.caseId}-${hash(proposal.original.sha256 + JSON.stringify(proposal.changes))}.spec.${extension}`;
}
function reviewDiff(changes) {
  return changes
    .map(
      (change) =>
        `@@ ${change.start}:${change.end} @@\n- ${change.before}\n+ ${change.after}`,
    )
    .join("\n");
}
function classificationFor(proposal) {
  if (
    !proposal.changes.length ||
    !proposal.proof.assertionCount ||
    !proposal.classification.applicable
  )
    return {
      category: "behavioral",
      applicable: false,
      ambiguous: true,
      rationale: !proposal.changes.length
        ? proposal.classification.rationale
        : "Required behavior or source binding cannot be proven unchanged. Revise the feature plan; this proposal cannot execute.",
    };
  let literalOnly = proposal.changes.length === 1;
  let ambiguous = proposal.classification.ambiguous;
  for (const change of proposal.changes) {
    const mechanic = changeMechanic(change);
    if (mechanic.legacy) {
      if (mechanic.before.value === mechanic.after.value)
        throw new Error("Repair makes no semantic locator progress");
      literalOnly = false;
      continue;
    }
    const before = locator(change.before),
      after = locator(change.after);
    if (before.options.exact !== after.options.exact)
      throw new Error("Repair cannot weaken or alter exact locator matching");
    const sameFamily =
      before.method === after.method &&
      (before.method !== "getByRole" || before.value === after.value);
    if (JSON.stringify(before) === JSON.stringify(after))
      throw new Error("Repair makes no semantic locator progress");
    literalOnly &&= sameFamily;
    ambiguous ||= !sameFamily;
  }
  return {
    category: literalOnly ? "locator_only" : "behavior_preserving",
    applicable: true,
    ambiguous,
    rationale: ambiguous
      ? "Locator strategy changed; action arguments, ordering and assertions are byte-preserved by worker AST attestation. Manual review is required; target equivalence is not proven."
      : literalOnly
        ? "One direct action-receiver locator literal changed; worker AST attests unchanged action arguments, ordering and assertions. Independent verification remains required."
        : "Mechanical action-locator repairs preserve action arguments, ordering, first-match semantics where applicable and assertions by worker AST attestation. Independent verification remains required.",
  };
}
export function validateRepairProposal(input, item) {
  if (typeof input === "string") {
    if (input.length > 50_000)
      throw new Error("Repair envelope exceeds 50000 characters");
    input = JSON.parse(input);
  }
  if (JSON.stringify(input)?.length > 50_000)
    throw new Error("Repair envelope exceeds 50000 characters");
  const proposal = envelopeSchema.parse(input);
  safeText(JSON.stringify(proposal));
  const url = new URL(proposal.baseUrl);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Invalid repair target URL");
  proposal.changes = normalizedChanges(proposal.changes);
  if (proposal.proposedSpecPath !== candidatePath(proposal))
    throw new Error(
      "Repair destination is not the exact deterministic feature copy",
    );
  if (proposal.diff !== reviewDiff(proposal.changes))
    throw new Error("Repair diff does not match validated locator changes");
  if (
    item &&
    (proposal.caseId !== item.id ||
      proposal.caseVersion !== item.version ||
      proposal.expected !== item.expected ||
      JSON.stringify(proposal.steps) !== JSON.stringify(item.steps) ||
      (item.specPath !== undefined &&
        proposal.original.specPath !== item.specPath) ||
      ((item.specPath !== undefined || Object.hasOwn(item, "specTag")) &&
        proposal.original.specTag !== item.specTag))
  )
    throw new Error(
      "Repair does not match the approved case revision and original script",
    );
  if (item)
    for (const change of proposal.changes)
      declaredLegacyValue(changeMechanic(change).value, item);
  proposal.classification = classificationFor(proposal);
  if (JSON.stringify(proposal).length > 50_000)
    throw new Error("Normalized repair envelope exceeds 50000 characters");
  return proposal;
}
export function classifyRepairProposal(input, item) {
  return validateRepairProposal(input, item).classification;
}

export function analyzeRepairSource(
  source,
  { specPath = "repair.ts", specTag } = {},
) {
  const file = parse(source, specPath);
  const imports = new Set();
  for (const statement of file.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      statement.moduleSpecifier.text === "@playwright/test"
    ) {
      for (const binding of statement.importClause?.namedBindings?.elements ||
        []) {
        if (
          !binding.propertyName &&
          ["test", "expect"].includes(binding.name.text)
        )
          imports.add(binding.name.text);
      }
    }
  }
  const tests = [];
  walk(file, (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "test"
    )
      tests.push(node);
  });
  const selected = tests.filter((node) => {
    if (!node.arguments[0] || !ts.isStringLiteral(node.arguments[0]))
      return false;
    return specTag
      ? node.arguments[0].text.includes(specTag)
      : tests.length === 1;
  });
  const selectedTest = selected.length === 1 ? selected[0] : undefined;
  const withinSelected = (node) => {
    while (node && node !== selectedTest) node = node.parent;
    return Boolean(node && selectedTest);
  };
  let selectedAssertions = 0;
  const locators = [],
    assertions = [],
    actionSources = [];
  let unsafe = !imports.has("test") || !imports.has("expect") || !selectedTest;
  walk(file, (node) => {
    if (ts.isIdentifier(node) && ["test", "expect"].includes(node.text)) {
      const parent = node.parent;
      if (
        ((ts.isVariableDeclaration(parent) ||
          ts.isParameter(parent) ||
          ts.isBindingElement(parent) ||
          ts.isFunctionDeclaration(parent)) &&
          parent.name === node) ||
        (ts.isBinaryExpression(parent) &&
          parent.left === node &&
          parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
          parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment)
      )
        unsafe = true;
    }
    if (ts.isCallExpression(node)) {
      const name = member(node.expression);
      if (
        [
          "skip",
          "fixme",
          "fail",
          "only",
          "setTimeout",
          "configure",
          "extend",
        ].includes(name)
      )
        unsafe = true;
      if (
        name === "use" &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "test"
      ) {
        const options = node.arguments[0];
        if (
          node.arguments.length !== 1 ||
          !options ||
          !ts.isObjectLiteralExpression(options) ||
          options.properties.some(
            (property) =>
              !ts.isPropertyAssignment(property) ||
              !(
                ts.isIdentifier(property.name) ||
                ts.isStringLiteral(property.name)
              ) ||
              ["page", "context", "browser"].includes(property.name.text),
          )
        )
          unsafe = true;
      }
      if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "expect"
      ) {
        let assertion = node;
        while (
          assertion.parent &&
          (ts.isPropertyAccessExpression(assertion.parent) ||
            ts.isCallExpression(assertion.parent))
        )
          assertion = assertion.parent;
        assertions.push(source.slice(assertion.getStart(file), assertion.end));
        if (
          withinSelected(node) &&
          assertion !== node &&
          ts.isCallExpression(assertion)
        )
          selectedAssertions++;
      }
      if (actions.has(name))
        actionSources.push(actionFingerprint(node, source, file));
      const legacy =
        ["click", "fill"].includes(name) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "page";
      if (!legacy && !locatorMethods.has(name)) return;
      const start = node.getStart(file);
      let end = node.end,
        actionCall,
        action,
        strict;
      if (legacy) {
        try {
          strict = legacyAction(source.slice(start, node.end)).strict;
        } catch {
          return;
        }
        end = node.arguments[0].end;
        actionCall = node;
        action = name;
      } else {
        try {
          locator(source.slice(start, end));
        } catch {
          return;
        }
        const receiver = node.parent;
        actionCall = receiver?.parent;
        if (
          !ts.isPropertyAccessExpression(receiver) ||
          !actions.has(receiver.name.text) ||
          !ts.isCallExpression(actionCall) ||
          actionCall.expression !== receiver ||
          actionCall.questionDotToken
        )
          return;
        action = receiver.name.text;
      }
      const before = source.slice(start, end);
      // Only a lexical page fixture on the direct, unmodified Playwright test callback is proven.
      let scope = actionCall.parent;
      while (scope && !ts.isFunctionLike(scope)) scope = scope.parent;
      if (
        !scope ||
        !(ts.isArrowFunction(scope) || ts.isFunctionExpression(scope)) ||
        scope.parent !== selectedTest
      )
        return;
      const parameters = scope.parameters;
      if (
        !parameters.length ||
        parameters[0].initializer ||
        !ts.isObjectBindingPattern(parameters[0].name) ||
        !parameters[0].name.elements.some(
          (entry) =>
            !entry.propertyName &&
            !entry.initializer &&
            !entry.dotDotDotToken &&
            ts.isIdentifier(entry.name) &&
            entry.name.text === "page",
        )
      )
        return;
      let bindingUnsafe = false;
      walk(scope.body, (child) => {
        if (ts.isIdentifier(child) && child.text === "page") {
          // Aliasing, assignment, computed access and passing page to unknown code are not proven.
          if (
            !ts.isPropertyAccessExpression(child.parent) ||
            child.parent.expression !== child
          )
            bindingUnsafe = true;
          else if (
            !ts.isCallExpression(child.parent.parent) ||
            child.parent.parent.expression !== child.parent
          )
            bindingUnsafe = true;
        }
      });
      if (!bindingUnsafe)
        locators.push({
          start,
          end,
          before,
          action,
          ...(legacy ? { legacy: true, strict, callEnd: node.end } : {}),
        });
    }
  });
  unsafe ||= !selectedAssertions;
  return {
    locators: unsafe ? [] : locators,
    assertions,
    actionSources,
    unsafe,
    assertionCount: assertions.length,
  };
}
function replaceChanges(
  source,
  changes,
  replacement = (change) => change.after,
) {
  let output = "",
    offset = 0;
  for (const change of changes) {
    if (source.slice(change.start, change.end) !== change.before)
      throw new Error("Original locator span changed");
    output += source.slice(offset, change.start) + replacement(change);
    offset = change.end;
  }
  return output + source.slice(offset);
}
function prove(source, changes, specPath, specTag) {
  const analysis = analyzeRepairSource(source, { specPath, specTag });
  if (changes.length && (analysis.unsafe || !analysis.assertionCount))
    throw new Error("Required assertions and fixture binding cannot be proven");
  for (const change of changes) {
    if (
      !analysis.locators.some(
        (entry) =>
          entry.start === change.start &&
          (entry.legacy
            ? entry.callEnd === change.end &&
              source.slice(entry.start, entry.callEnd) === change.before
            : entry.end === change.end && entry.before === change.before),
      )
    )
      throw new Error(
        "Repair may change only a proven direct action-receiver locator, never assertions, arguments, control flow or fixtures",
      );
  }
  const repaired = replaceChanges(source, changes);
  const next = analyzeRepairSource(repaired, { specPath, specTag });
  if (JSON.stringify(analysis.assertions) !== JSON.stringify(next.assertions))
    throw new Error("Repair changed assertion semantics");
  if (
    JSON.stringify(analysis.actionSources) !==
    JSON.stringify(next.actionSources)
  )
    throw new Error(
      "Repair changed action order, argument bytes or strict selection semantics",
    );
  return {
    repaired,
    proof: {
      unchangedSha256: hash(
        replaceChanges(source, changes, () => "<ACTION_LOCATOR>"),
      ),
      actionsSha256: hash(JSON.stringify(analysis.actionSources)),
      assertionsSha256: hash(JSON.stringify(analysis.assertions)),
      assertionCount: analysis.assertionCount,
    },
  };
}
export function relocateRepairSource(source, originalPath, targetPath) {
  scriptPath.parse(originalPath);
  scriptPath.parse(targetPath);
  const file = parse(source, originalPath),
    changes = [];
  const relocate = (node) => {
    if (!node || !ts.isStringLiteral(node))
      throw new Error("Dynamic module paths cannot be safely relocated");
    const value = node.text;
    if (!value.startsWith(".")) return;
    let target = path.posix.relative(
      path.posix.dirname(targetPath),
      path.posix.normalize(
        path.posix.join(path.posix.dirname(originalPath), value),
      ),
    );
    if (!target.startsWith(".")) target = `./${target}`;
    changes.push({
      start: node.getStart(file),
      end: node.end,
      before: source.slice(node.getStart(file), node.end),
      after: JSON.stringify(target),
    });
  };
  walk(file, (node) => {
    if (ts.isIdentifier(node) && node.text === "require") {
      const direct =
        ts.isCallExpression(node.parent) && node.parent.expression === node;
      const resolve =
        ts.isPropertyAccessExpression(node.parent) &&
        node.parent.expression === node &&
        node.parent.name.text === "resolve" &&
        ts.isCallExpression(node.parent.parent) &&
        node.parent.parent.expression === node.parent;
      if (!direct && !resolve)
        throw new Error(
          "Shadowed, aliased or indirect require cannot be safely relocated",
        );
    }
    if (
      ts.isImportDeclaration(node) ||
      (ts.isExportDeclaration(node) && node.moduleSpecifier)
    )
      relocate(node.moduleSpecifier);
    if (ts.isImportEqualsDeclaration(node)) {
      if (!ts.isExternalModuleReference(node.moduleReference))
        throw new Error("Unsupported module alias relocation");
      relocate(node.moduleReference.expression);
    }
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    )
      relocate(node.arguments[0]);
    if (
      ts.isCallExpression(node) &&
      member(node.expression) === "resolve" &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "require"
    ) {
      if (node.arguments.length !== 1)
        throw new Error(
          "Custom require resolution paths cannot be safely relocated",
        );
      relocate(node.arguments[0]);
    }
    if (ts.isCallExpression(node) && member(node.expression) === "require")
      throw new Error("Indirect module loading cannot be safely relocated");
    if (
      (ts.isIdentifier(node) &&
        ["__dirname", "__filename"].includes(node.text)) ||
      (ts.isMetaProperty(node) &&
        node.keywordToken === ts.SyntaxKind.ImportKeyword)
    )
      throw new Error(
        "Location-dependent script cannot be safely copied; revise its automation manually",
      );
  });
  return replaceChanges(
    source,
    changes.sort((a, b) => a.start - b.start),
  );
}
export function normalizeRepairFailure(originalFailure) {
  if (
    originalFailure?.status !== "failed" ||
    !Number.isInteger(originalFailure.testCount) ||
    originalFailure.testCount < 1
  )
    throw new Error(
      "Only an original failed linked execution with executed tests can propose repair",
    );
  return {
    status: "failed",
    detail: `Original Playwright execution failed; ${originalFailure.testCount} test(s). Full failure and artifacts remain runner-local.`,
    ...(originalFailure.evidence
      ? { evidence: redactRepairText(originalFailure.evidence).slice(0, 1000) }
      : {}),
    testCount: originalFailure.testCount,
  };
}
export function createRepairProposal({
  source,
  item,
  baseUrl,
  changes = [],
  originalFailure,
  attempt = 1,
  history = [],
  behavioralReason,
}) {
  if (originalFailure?.status !== "failed")
    throw new Error("Only an original failed linked result can propose repair");
  const normalized = normalizedChanges(
    expandRepairRequests(source, changes, item),
  );
  for (const change of normalized)
    declaredLegacyValue(changeMechanic(change).value, item);
  if (!normalized.length && !behavioralReason)
    throw new Error("Repair must change a locator or explain a behavioral gap");
  const { repaired, proof } = prove(
    source,
    normalized,
    item.specPath,
    item.specTag,
  );
  const original = {
    specPath: item.specPath,
    ...(item.specTag ? { specTag: item.specTag } : {}),
    sha256: hash(source),
  };
  const proposal = {
    schemaVersion: 1,
    kind: "linked-script-repair",
    caseId: item.id,
    caseVersion: item.version,
    expected: item.expected,
    steps: item.steps,
    baseUrl,
    original,
    changes: normalized,
    proof,
    proposedSpecPath: "",
    proposedSha256: original.sha256,
    classification: {
      category: "behavioral",
      applicable: normalized.length > 0,
      ambiguous: false,
      rationale: behavioralReason
        ? `Replan required; no executable repair. Observed, not independently verified: ${redactRepairText(behavioralReason)}`.slice(
            0,
            2000,
          )
        : "Worker AST analysis",
    },
    attempt,
    originalFailure: normalizeRepairFailure(originalFailure),
    diff: reviewDiff(normalized),
  };
  proposal.proposedSpecPath = candidatePath(proposal);
  if (normalized.length)
    proposal.proposedSha256 = hash(
      relocateRepairSource(
        repaired,
        original.specPath,
        proposal.proposedSpecPath,
      ),
    );
  const previous = history
    .map((entry) => {
      try {
        return validateRepairProposal(entry.proposal || entry);
      } catch {
        return undefined;
      }
    })
    .filter(
      (entry) =>
        entry?.original.sha256 === original.sha256 && entry.caseId === item.id,
    );
  if (
    attempt > 3 ||
    previous.length >= 3 ||
    attempt <= Math.max(0, ...previous.map((entry) => entry.attempt))
  )
    throw new Error(
      "Repair attempt budget exhausted or attempt did not advance",
    );
  if (
    previous.some(
      (entry) => JSON.stringify(entry.changes) === JSON.stringify(normalized),
    )
  )
    throw new Error("No progress: this exact repair was already proposed");
  return validateRepairProposal(proposal, item);
}
export function applyRepairProposal(input, source, item, baseUrl) {
  const proposal = validateRepairProposal(input, item);
  if (!proposal.classification.applicable)
    throw new Error(
      "Behavioral or unproven repair cannot be applied, even with manual approval",
    );
  if (proposal.baseUrl !== baseUrl || hash(source) !== proposal.original.sha256)
    throw new Error("Repair target or original source revision changed");
  const { repaired, proof } = prove(
    source,
    proposal.changes,
    proposal.original.specPath,
    proposal.original.specTag,
  );
  if (JSON.stringify(proof) !== JSON.stringify(proposal.proof))
    throw new Error("Repair worker AST proof does not match original source");
  const relocated = relocateRepairSource(
    repaired,
    proposal.original.specPath,
    proposal.proposedSpecPath,
  );
  if (hash(relocated) !== proposal.proposedSha256)
    throw new Error("Repair proposed source digest changed");
  return relocated;
}
