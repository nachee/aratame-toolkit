import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { chromium } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  analyzeRepairSource,
  applyRepairProposal,
  classifyRepairProposal,
  createRepairProposal,
  relocateRepairSource,
  repairRequestSchema,
  validateRepairProposal,
} from "./repair.mjs";
import { exploreRepairCase } from "./exploration.mjs";

const item = {
  id: "save",
  version: 2,
  steps: ["Enter draft", "Save draft"],
  expected: "Draft saved",
  specPath: "tests/save.spec.mjs",
};
const baseUrl = "http://127.0.0.1:3000";
const source = `import { test, expect } from '@playwright/test';
test('save draft', async ({ page }) => {
  await page.getByLabel('Old draft').fill('Required argument');
  await page.getByRole('button', { name: 'Old save', exact: true }).click({ button: 'left' });
  await expect(page.getByTestId('result')).toHaveText('Draft saved');
});
`;
const originalFailure = {
  status: "failed",
  detail: "Private original failure DOM",
  testCount: 1,
  evidence: "e2e/aratame/.artifacts/original.json",
};
const change = (before, after, original = source) => ({
  start: original.indexOf(before),
  end: original.indexOf(before) + before.length,
  before,
  after,
});
const first = () =>
  change("page.getByLabel('Old draft')", "page.getByLabel('Draft')");
const second = () =>
  change(
    "page.getByRole('button', { name: 'Old save', exact: true })",
    "page.getByRole('button', { name: 'Save', exact: true })",
  );
const propose = (changes = [first()], options = {}) =>
  createRepairProposal({
    source,
    item,
    baseUrl,
    changes,
    originalFailure,
    ...options,
  });

async function consume(script, available = ["Draft", "Save"]) {
  const events = [];
  let running;
  const target = (name) => ({
    fill: async (value) => {
      assert.ok(available.includes(name), `Missing locator ${name}`);
      events.push(["fill", name, value]);
    },
    click: async (options) => {
      assert.ok(available.includes(name), `Missing locator ${name}`);
      events.push(["click", name, options.button]);
    },
  });
  vm.runInNewContext(script.slice(script.indexOf("\n") + 1), {
    test: (_title, body) => {
      running = body({
        page: {
          getByLabel: target,
          getByRole: (_role, options) => target(options.name),
          getByTestId: (name) => name,
        },
      });
    },
    expect: (target) => ({
      toHaveText: async (expected) => {
        assert.equal(target, "result");
        assert.equal(expected, "Draft saved");
        events.push(["assert", target, expected]);
      },
    }),
  });
  await running;
  return events;
}

test("multiple action locator repairs restore the consumer flow without changing arguments, order or expected outcome", async () => {
  await assert.rejects(consume(source), /Missing locator/);
  const proposal = propose([first(), second()]);
  assert.equal(proposal.classification.category, "behavior_preserving");
  const repaired = applyRepairProposal(proposal, source, item, baseUrl);
  assert.deepEqual(await consume(repaired), [
    ["fill", "Draft", "Required argument"],
    ["click", "Save", "left"],
    ["assert", "result", "Draft saved"],
  ]);
  assert.equal(
    createHash("sha256").update(repaired).digest("hex"),
    proposal.proposedSha256,
  );
  assert.equal(
    proposal.originalFailure.detail.includes(originalFailure.detail),
    false,
  );
});

test("one same-family literal qualifies locator_only but strategy changes require ambiguous mechanical review", () => {
  assert.equal(propose().classification.category, "locator_only");
  const strategy = propose([
    change("page.getByLabel('Old draft')", "page.getByText('Draft')"),
  ]);
  assert.deepEqual(
    {
      category: strategy.classification.category,
      ambiguous: strategy.classification.ambiguous,
      applicable: strategy.classification.applicable,
    },
    { category: "behavior_preserving", ambiguous: true, applicable: true },
  );
  const forged = structuredClone(strategy);
  forged.classification = {
    ...forged.classification,
    category: "locator_only",
    ambiguous: false,
  };
  assert.equal(classifyRepairProposal(forged).ambiguous, true);
  assert.equal(classifyRepairProposal(forged).category, "behavior_preserving");
});

test("model cannot supply source, category, proof or approval", () => {
  for (const extra of [
    { source: "test.skip()" },
    { category: "locator_only" },
    { proof: {} },
    { approved: true },
  ]) {
    assert.throws(() =>
      repairRequestSchema.parse({
        kind: "locator",
        changes: [first()],
        ...extra,
      }),
    );
  }
});

test("code injection and hidden execution are rejected rather than manually approvable", () => {
  for (const after of [
    "page.getByLabel((process.exit(), 'Draft'))",
    "page.getByLabel(`Draft${process.exit()}`)",
    "page.getByLabel('Draft'); process.exit()",
    "page.getByLabel('Draft') /* secret */",
    "page.getByLabel('Draft', { ...options })",
    "page.getByLabel('Draft', { get exact() { return false } })",
    "page['getByLabel']('Draft')",
    "page.getByLabel('Draft').first()",
    "page.locator('custom=execute')",
  ])
    assert.throws(() =>
      propose([change("page.getByLabel('Old draft')", after)]),
    );
});

test("assertion targets, expected values, action arguments, retries and skips cannot be edited", () => {
  for (const [before, after] of [
    ["page.getByTestId('result')", "page.getByTestId('unrelated')"],
    ["'Draft saved'", "'Broken state'"],
    [".toHaveText('Draft saved')", ".toBeVisible()"],
    [".fill('Required argument')", ".fill('Different argument')"],
    ["test('save draft'", "test.skip('save draft'"],
    [
      "await page.getByLabel('Old draft').fill('Required argument');",
      "test.describe.configure({ retries: 2 });",
    ],
  ])
    assert.throws(() => propose([change(before, after)]));
  assert.throws(
    () =>
      propose([
        change(
          second().before,
          "page.getByRole('button', { name: 'Save', exact: false })",
        ),
      ]),
    /exact/,
  );
});

test("an approved envelope cannot change source bytes, source proof, proposed digest or target identity", () => {
  const proposal = propose();
  assert.throws(
    () => applyRepairProposal(proposal, source + "\n", item, baseUrl),
    /revision/,
  );
  assert.throws(
    () => applyRepairProposal(proposal, source, item, "http://127.0.0.1:3001"),
    /target/,
  );
  for (const field of [
    "unchangedSha256",
    "actionsSha256",
    "assertionsSha256",
  ]) {
    const forged = structuredClone(proposal);
    forged.proof[field] = "0".repeat(64);
    assert.throws(
      () => applyRepairProposal(forged, source, item, baseUrl),
      /proof/,
    );
  }
  assert.throws(
    () =>
      applyRepairProposal(
        { ...proposal, proposedSha256: "0".repeat(64) },
        source,
        item,
        baseUrl,
      ),
    /digest/,
  );
  assert.throws(
    () =>
      validateRepairProposal({
        ...proposal,
        proposedSpecPath: "e2e/aratame/other.spec.mjs",
      }),
    /destination/,
  );
  for (const mutated of [
    { ...item, version: 3 },
    { ...item, expected: "Anything passes" },
    { ...item, steps: [...item.steps].reverse() },
    { ...item, specTag: "other" },
  ])
    assert.throws(
      () => validateRepairProposal(proposal, mutated),
      /approved case/,
    );
});

test("a forged full-envelope locator edit at an assertion target is rejected again on application", () => {
  const proposal = propose();
  const forgedChanges = [
    change("page.getByTestId('result')", "page.getByTestId('elsewhere')"),
  ];
  const forged = { ...proposal, changes: forgedChanges };
  const suffix = createHash("sha256")
    .update(proposal.original.sha256 + JSON.stringify(forgedChanges))
    .digest("hex");
  forged.proposedSpecPath = `e2e/aratame/repairs/save-${suffix}.spec.mjs`;
  forged.diff = `@@ ${forgedChanges[0].start}:${forgedChanges[0].end} @@\n- ${forgedChanges[0].before}\n+ ${forgedChanges[0].after}`;
  assert.throws(
    () => applyRepairProposal(forged, source, item, baseUrl),
    /action-receiver/,
  );
});

test("unrelated tests are never repair slots and ambiguous selections cannot execute", () => {
  const other = `test('unrelated', async ({ page }) => { await page.getByText('Other').click(); await expect(page.getByText('Done')).toBeVisible(); });\n`;
  const original = source + other;
  const selectedItem = { ...item, specTag: "save draft" };
  assert.throws(
    () =>
      propose(
        [
          change(
            "page.getByText('Other')",
            "page.getByText('Changed')",
            original,
          ),
        ],
        { source: original, item: selectedItem },
      ),
    /action-receiver/,
  );
  assert.throws(() => propose([first()], { source: original }), /binding/);
  const proposal = propose([first()], { source: original, item: selectedItem });
  const repaired = applyRepairProposal(
    proposal,
    original,
    selectedItem,
    baseUrl,
  );
  assert.equal(repaired.slice(-other.length), other);
  const repeated =
    original + other.replace("unrelated", "save draft duplicate");
  assert.throws(
    () => propose([first()], { source: repeated, item: selectedItem }),
    /binding/,
  );
});

test("aliases, shadowed page fixtures and assertion-free selected cases have no applicable slots", () => {
  const variants = [
    source.replace(
      "await page.getByLabel",
      "const alias = page; await page.getByLabel",
    ),
    source.replace("({ page })", "({ page = fakePage })"),
    source.replace(
      "await expect(page.getByTestId('result')).toHaveText('Draft saved');",
      "",
    ),
    source.replace("test('save draft'", "test.skip('save draft'"),
    source.replace(
      "import { test, expect } from '@playwright/test';",
      "import { test, expect } from './custom-fixtures.mjs';",
    ),
    source.replace(
      "test('save draft'",
      "test.use({page: fakePage}); test('save draft'",
    ),
    source.replace(
      "test('save draft'",
      "test.use({...unknownFixtures}); test('save draft'",
    ),
  ];
  for (const original of variants)
    assert.equal(analyzeRepairSource(original, item).locators.length, 0);
});

test("repair limits reject no-op, overlapping, oversize and repeated proposals", () => {
  assert.throws(() => propose([first(), first()]), /overlap/);
  assert.throws(
    () => propose([{ ...first(), after: first().before }]),
    /empty|overlap/,
  );
  assert.throws(
    () => propose([change(first().before, 'page.getByLabel("Old draft")')]),
    /semantic locator progress/,
  );
  assert.throws(() => propose(Array.from({ length: 13 }, first)));
  assert.throws(() => propose([{ ...first(), after: "x".repeat(2001) }]));
  assert.throws(() => propose([first()], { source: " ".repeat(500_001) }));
  const prior = propose();
  assert.throws(
    () =>
      propose([first()], {
        attempt: 2,
        history: [{ status: "rejected", proposal: JSON.stringify(prior) }],
      }),
    /No progress/,
  );
  assert.throws(
    () => propose([second()], { attempt: 1, history: [prior] }),
    /attempt/,
  );
  assert.throws(() => propose([second()], { attempt: 4 }), /budget/);
  assert.throws(
    () => validateRepairProposal(JSON.stringify(prior) + " ".repeat(50_000)),
    /50000/,
  );
});

test("behavioral differences stay review-only even if an envelope claims automatic approval", () => {
  const proposal = propose([], {
    behavioralReason:
      "The save action returns a server error instead of the approved outcome",
  });
  assert.equal(proposal.classification.category, "behavioral");
  assert.equal(proposal.classification.applicable, false);
  assert.match(proposal.classification.rationale, /server error/);
  const forged = structuredClone(proposal);
  forged.classification = {
    category: "locator_only",
    applicable: true,
    ambiguous: false,
    rationale: "Automatically approved",
  };
  assert.equal(classifyRepairProposal(forged).applicable, false);
  assert.throws(
    () => applyRepairProposal(forged, source, item, baseUrl),
    /cannot be applied/,
  );
  assert.throws(
    () =>
      propose([first()], {
        originalFailure: { status: "passed", testCount: 1 },
      }),
    /failed linked/,
  );
});

test("relative static, export and dynamic imports retain their resolved targets in the immutable copy", () => {
  const originalPath = "tests/nested/save.spec.mjs";
  const candidatePath = "e2e/aratame/repairs/save.spec.mjs";
  const moduleSource = `import data from '../fixtures/data.mjs';\nexport { value } from './helper.mjs';\nconst lazy = import('../../shared/lazy.mjs');\nconst common = require('./common.cjs');\nconst resolved = require.resolve('./resolved.cjs');\n`;
  const relocated = relocateRepairSource(
    moduleSource,
    originalPath,
    candidatePath,
  );
  // Compare module resolution as observed by a consumer, not quote style or printed source.
  const before = [...moduleSource.matchAll(/['"]([^'"]+)['"]/g)].map((match) =>
    path.posix.normalize(
      path.posix.join(path.posix.dirname(originalPath), match[1]),
    ),
  );
  const after = [...relocated.matchAll(/['"]([^'"]+)['"]/g)].map((match) =>
    path.posix.normalize(
      path.posix.join(path.posix.dirname(candidatePath), match[1]),
    ),
  );
  assert.deepEqual(after, before);
  assert.throws(
    () =>
      relocateRepairSource(
        "const data = import(moduleName)",
        originalPath,
        candidatePath,
      ),
    /Dynamic module/,
  );
  assert.throws(
    () =>
      relocateRepairSource(
        "const data = new URL('./data', import.meta.url)",
        originalPath,
        candidatePath,
      ),
    /Location-dependent/,
  );
  for (const custom of [
    "function require(value) { return value; } require('./not-a-module')",
    "import require from './ordinary-function.mjs'; require('./not-a-module')",
    "const load = require; load('./module.cjs')",
    "require.resolve('./module.cjs', { paths: ['/custom'] })",
  ])
    assert.throws(
      () => relocateRepairSource(custom, originalPath, candidatePath),
      /relocated/,
    );
});

test("candidate digest covers final relocated imports, not just edited locator bytes", () => {
  const original = source.replace(
    "import { test",
    "import './helper.mjs';\nimport { test",
  );
  const proposal = propose([change(first().before, first().after, original)], {
    source: original,
  });
  const result = applyRepairProposal(proposal, original, item, baseUrl);
  assert.equal(
    createHash("sha256").update(result).digest("hex"),
    proposal.proposedSha256,
  );
  assert.notEqual(
    createHash("sha256")
      .update(original.replace(first().before, first().after))
      .digest("hex"),
    proposal.proposedSha256,
  );
});

async function browserRepair(t, calls, options = {}) {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "aratame-repair-"));
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  t.mock.method(chromium, "launchPersistentContext", async (profile) => {
    await fs.mkdir(profile, { recursive: true });
    await fs.writeFile(path.join(profile, "DevToolsActivePort"), "9222\n");
    return { route: async () => {}, close: async () => {} };
  });
  t.mock.method(Client.prototype, "connect", async () => {});
  t.mock.method(Client.prototype, "close", async () => {});
  t.mock.method(Client.prototype, "listTools", async () => ({
    tools: ["take_snapshot", "navigate_page", "list_pages"].map((name) => ({
      name,
      inputSchema: { type: "object" },
    })),
  }));
  t.mock.method(Client.prototype, "callTool", async ({ name }) => ({
    content: [
      {
        type: "text",
        text: name === "list_pages" ? baseUrl : "Observed draft form",
      },
    ],
  }));
  let turn = 0;
  const sent = [];
  const result = await exploreRepairCase({
    config: {},
    job: { run: { id: "repair" }, plan: { requirements: "Save a draft" } },
    item,
    source,
    originalFailure,
    baseUrl,
    project,
    artifactRoot: "e2e/aratame/.artifacts/repair",
    signal: options.signal || new AbortController().signal,
    api: async (_endpoint, request) => {
      sent.push(JSON.stringify(request));
      const call = calls[turn++];
      if (!call) throw new Error("Unexpected model turn");
      return { toolCalls: [{ id: String(turn), ...call }] };
    },
  });
  return { result, sent, project };
}

test("origin-bound browser repair receives only bounded projection and produces an unapplied review", async (t) => {
  const { result, sent, project } = await browserRepair(t, [
    { name: "take_snapshot", arguments: { pageId: 1 } },
    {
      name: "propose_linked_repair",
      arguments: { kind: "locator", changes: [first()] },
    },
  ]);
  assert.equal(result.proposal.classification.category, "locator_only");
  assert.equal(
    sent.some(
      (entry) =>
        entry.includes("Required argument") ||
        entry.includes("Private original failure DOM"),
    ),
    false,
  );
  await assert.rejects(
    fs.readFile(path.join(project, result.proposal.proposedSpecPath)),
    { code: "ENOENT" },
  );
  const evidence = JSON.parse(
    await fs.readFile(path.join(project, result.evidence), "utf8"),
  );
  assert.equal(
    evidence.scenario.proposedSha256,
    result.proposal.proposedSha256,
  );
});

test("browser repair refuses a model verdict without an observed snapshot", async (t) => {
  await assert.rejects(
    browserRepair(t, [
      {
        name: "propose_linked_repair",
        arguments: { kind: "locator", changes: [first()] },
      },
    ]),
    /snapshot/,
  );
});

test("browser product mismatch yields non-applicable replan review, not replacement assertions", async (t) => {
  const { result } = await browserRepair(t, [
    { name: "take_snapshot", arguments: { pageId: 1 } },
    {
      name: "propose_linked_repair",
      arguments: {
        kind: "behavioral",
        reason: "Observed save failure rather than the required confirmation",
      },
    },
  ]);
  assert.equal(result.proposal.classification.applicable, false);
  assert.equal(result.proposal.changes.length, 0);
});

test("browser repair preserves bounded no-progress and cancellation stops", async (t) => {
  await assert.rejects(
    browserRepair(
      t,
      Array.from({ length: 3 }, () => ({
        name: "take_snapshot",
        arguments: { pageId: 1 },
      })),
    ),
    /No progress/,
  );
});

test("cancelled repair never calls the model or creates a candidate", async (t) => {
  const controller = new AbortController();
  controller.abort(new Error("Repair cancelled"));
  await assert.rejects(
    browserRepair(t, [], { signal: controller.signal }),
    /cancelled/,
  );
});

test("legacy action normalization preserves first-match selection, literal arguments and assertion behavior", async () => {
  const original = `import { test, expect } from '@playwright/test';
test('save', async ({ page }) => {
  await page.fill('#old-name', 'Ada', { strict: false });
  await page.click('#old-save', { strict: false });
  await expect(page.getByTestId('result')).toHaveText('Draft saved');
});`;
  const approved = { ...item, steps: ["Enter Ada in name", "Save draft"] };
  const slots = analyzeRepairSource(original, approved).locators;
  const requested = slots.map((slot) => ({
    start: slot.start,
    end: slot.end,
    before: slot.before,
    after: `page.locator('${slot.action === "fill" ? "#name" : "#save"}').first()`,
  }));
  assert.equal(JSON.stringify(slots).includes("Ada"), false);
  const proposal = propose(requested, { source: original, item: approved });
  assert.equal(proposal.classification.category, "behavior_preserving");
  assert.equal(proposal.classification.ambiguous, false);
  const repaired = applyRepairProposal(proposal, original, approved, baseUrl);
  let running;
  const events = [];
  vm.runInNewContext(repaired.slice(repaired.indexOf("\n") + 1), {
    test: (_title, body) => {
      running = body({
        page: {
          locator: (selector) => ({
            // Duplicate matches require the explicit first-match normalization.
            first: () => ({
              fill: async (value) => events.push(["fill", selector, 0, value]),
              click: async () => events.push(["click", selector, 0]),
            }),
          }),
          getByTestId: (id) => id,
        },
      });
    },
    expect: (id) => ({
      toHaveText: async (value) => events.push(["assert", id, value]),
    }),
  });
  await running;
  assert.deepEqual(events, [
    ["fill", "#name", 0, "Ada"],
    ["click", "#save", 0],
    ["assert", "result", "Draft saved"],
  ]);
});

test("legacy normalization refuses changed values, method switches, strictness changes and undeclared data exposure", () => {
  const original = `import { test, expect } from '@playwright/test';
test('save', async ({ page }) => {
  await page.fill('#name', 'Ada', { strict: false });
  await expect(page.getByTestId('result')).toHaveText('Draft saved');
});`;
  const approved = { ...item, steps: ["Enter Ada", "Save"] };
  const before = "page.fill('#name', 'Ada', { strict: false })";
  for (const after of [
    "page.locator('#new').first().fill( 'Changed')",
    "page.locator('#new').first().press( 'Ada')",
    "page.locator('#new').fill( 'Ada')",
    "page.locator('#new').nth(1).fill( 'Ada')",
    "page.locator('#new').first().fill( 'Ada', { force: true })",
  ])
    assert.throws(() =>
      propose([change(before, after, original)], {
        source: original,
        item: approved,
      }),
    );
  assert.throws(
    () =>
      propose(
        [change(before, "page.locator('#new').first().fill( 'Ada')", original)],
        { source: original },
      ),
    /explicitly present/,
  );
  for (const replacement of [
    "page.fill('#name', 'Ada')",
    "page.fill('#name', 'Ada', { strict: false, force: true })",
    "page.fill('#name', 'Ada', { strict: setting })",
  ]) {
    const options = original.replace(before, replacement);
    assert.equal(analyzeRepairSource(options, approved).locators.length, 0);
  }
});

test("explicit strict legacy calls retain unique-target semantics and cannot gain first-match selection", () => {
  const original = `import { test, expect } from '@playwright/test';
test('save', async ({ page }) => {
  await page.click('#old', { strict: true });
  await expect(page.getByTestId('result')).toHaveText('Draft saved');
});`;
  const before = "page.click('#old', { strict: true })";
  const accepted = propose(
    [change(before, "page.locator('#new').click()", original)],
    { source: original },
  );
  assert.equal(accepted.classification.category, "behavior_preserving");
  const repaired = applyRepairProposal(accepted, original, item, baseUrl);
  assert.equal(
    createHash("sha256").update(repaired).digest("hex"),
    accepted.proposedSha256,
  );
  assert.throws(
    () =>
      propose(
        [change(before, "page.locator('#new').first().click()", original)],
        { source: original },
      ),
    /locator/,
  );
  const unknown = original.replace(before, "page.click('#old')");
  assert.throws(() =>
    propose(
      [
        change(
          "page.click('#old')",
          "page.locator('#new').first().click()",
          unknown,
        ),
      ],
      { source: unknown },
    ),
  );
});

test("legacy fill values declared only in text preconditions remain eligible without exposing undeclared values", () => {
  const original = `import { test, expect } from '@playwright/test';
test('save', async ({ page }) => {
  await page.fill('#name', 'Ada', { strict: false });
  await expect(page.getByTestId('result')).toHaveText('Draft saved');
});`;
  const approved = {
    ...item,
    preconditions: "The authorized synthetic user is Ada.",
  };
  const changes = [
    change(
      "page.fill('#name', 'Ada', { strict: false })",
      "page.locator('#new-name').first().fill( 'Ada')",
      original,
    ),
  ];
  const proposal = propose(changes, { source: original, item: approved });
  assert.equal(proposal.classification.category, "behavior_preserving");
  const repaired = applyRepairProposal(proposal, original, approved, baseUrl);
  assert.equal(
    createHash("sha256").update(repaired).digest("hex"),
    proposal.proposedSha256,
  );
  assert.throws(
    () =>
      applyRepairProposal(
        proposal,
        original,
        { ...approved, preconditions: "No synthetic user has been declared." },
        baseUrl,
      ),
    /explicitly present/,
  );
});

test("CSS repair rejects Playwright engine dispatch hidden by whitespace or extended engine names", () => {
  const before = 'page.locator("#old")';
  const original = source.replace(first().before, before);
  for (const selector of [
    " custom=payload",
    "custom =payload",
    " text =Save",
    "_engine=payload",
    "internal:control=payload",
    "engine+suffix=payload",
    "1engine=payload",
    "*css=button",
    '"Save"',
    "'Save'",
    "//button",
    "(//button)",
    "..",
  ]) {
    const after = `page.locator(${JSON.stringify(selector)})`;
    assert.throws(
      () => propose([change(before, after, original)], { source: original }),
      /Only CSS selectors/,
    );
  }
});

test("CSS attribute equality and explicit whitespace-trimmed css engine remain repairable", () => {
  const before = 'page.locator("#old")';
  const original = source.replace(first().before, before);
  for (const selector of [
    'button[data-action="save"]',
    '[data-label="text =Save"]',
    ' css = button[data-action="save"]',
  ]) {
    const after = `page.locator(${JSON.stringify(selector)})`;
    const proposal = propose([change(before, after, original)], {
      source: original,
    });
    assert.equal(proposal.classification.category, "locator_only");
    const repaired = applyRepairProposal(proposal, original, item, baseUrl);
    assert.equal(
      createHash("sha256").update(repaired).digest("hex"),
      proposal.proposedSha256,
    );
  }
});
