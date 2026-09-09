import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { chromium } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  compileScenario,
  exploreCase,
  readonlyProgressDetector,
  validateExplorationGap,
  explorationGapDetail,
} from "./exploration.mjs";
import { executeJob } from "./execution.mjs";

const item = {
  id: "synthetic",
  title: "Submit a draft",
  version: 2,
  steps: ["Enter draft", "Submit draft"],
  expected: "Draft submitted",
};
const target = { by: "label", value: "Draft" };
const proposal = () => ({
  caseVersion: 2,
  expected: item.expected,
  rationale: "Observed the authorized synthetic flow",
  steps: [
    {
      action: "navigate",
      path: "/",
      mapping: { kind: "connective", reason: "Open the draft form" },
    },
    { action: "click", target, mapping: { kind: "declared", step: 1 } },
    {
      action: "fill",
      target,
      value: "Synthetic draft",
      mapping: { kind: "declared", step: 1 },
    },
    {
      action: "press",
      target,
      key: "Enter",
      mapping: { kind: "declared", step: 2 },
    },
  ],
  assertions: [
    {
      action: "assertText",
      target: { by: "testId", value: "result" },
      text: item.expected,
    },
  ],
});
const gap = () => ({
  reason: "missing_prerequisite",
  blockedStep: 2,
  observedFacts: ["Submit is disabled without an assigned reviewer"],
  missingPrerequisite:
    "Authorized synthetic reviewer account has not been supplied",
  manualCheck:
    "In the authorized disposable target, supply a test reviewer and verify draft submission manually",
});

async function temporary(t) {
  const project = await fs.mkdtemp(
    path.join(os.tmpdir(), "aratame-recoveries-"),
  );
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  return project;
}

test("compiled actions preserve ordered multi-action declared steps and connective navigation, with separate assertions", async () => {
  const source = compileScenario(proposal(), item, "http://127.0.0.1:3000");
  const events = [];
  let executed;
  const page = {
    route: async () => {},
    goto: async (url) => events.push(["navigate", url]),
    getByLabel: (name) => ({
      click: async () => events.push(["click", name]),
      fill: async (value) => events.push(["fill", name, value]),
      press: async (key) => events.push(["press", name, key]),
    }),
    getByTestId: (name) => name,
  };
  // Execute the compiler's body with a controlled browser consumer, not source-text assertions.
  vm.runInNewContext(source.slice(source.indexOf("\n") + 1), {
    URL,
    test: (_title, body) => {
      executed = body({ page });
    },
    expect: (name) => ({
      toHaveText: async (text) => events.push(["assert", name, text]),
    }),
  });
  await executed;
  assert.deepEqual(events, [
    ["navigate", "http://127.0.0.1:3000/"],
    ["click", "Draft"],
    ["fill", "Draft", "Synthetic draft"],
    ["press", "Draft", "Enter"],
    ["assert", "result", item.expected],
  ]);
});

test("partial, reordered, out-of-range, assertion-only and unmapped proposals cannot become runnable specs", () => {
  const omitted = proposal();
  omitted.steps.pop();
  assert.throws(
    () => compileScenario(omitted, item, "http://localhost"),
    /omitted/,
  );
  const reordered = proposal();
  reordered.steps[1].mapping.step = 2;
  assert.throws(
    () => compileScenario(reordered, item, "http://localhost"),
    /in order/,
  );
  const backwards = proposal();
  backwards.steps.push({ ...backwards.steps[1] });
  assert.throws(
    () => compileScenario(backwards, item, "http://localhost"),
    /in order/,
  );
  const outside = proposal();
  outside.steps[3].mapping.step = 3;
  assert.throws(
    () => compileScenario(outside, item, "http://localhost"),
    /bounds/,
  );
  const cheating = proposal();
  cheating.steps[3] = {
    ...cheating.assertions[0],
    mapping: { kind: "declared", step: 2 },
  };
  assert.throws(() => compileScenario(cheating, item, "http://localhost"));
  const assertionMapping = proposal();
  assertionMapping.steps.pop();
  assertionMapping.assertions[0].mapping = { kind: "declared", step: 2 };
  assert.throws(() =>
    compileScenario(assertionMapping, item, "http://localhost"),
  );
  const legacy = proposal();
  for (const step of legacy.steps) delete step.mapping;
  assert.throws(
    () => compileScenario(legacy, item, "http://localhost"),
    /regenerate.*approval/,
  );
  const unexplained = proposal();
  unexplained.steps[0].mapping.reason = "  ";
  assert.throws(() => compileScenario(unexplained, item, "http://localhost"));
});

test("readonly stop fingerprints full results beyond the model truncation and resets on changed args/results", () => {
  const observe = readonlyProgressDetector();
  const a = { content: [{ type: "text", text: "x".repeat(16_000) + "A" }] };
  const b = { content: [{ type: "text", text: "x".repeat(16_000) + "B" }] };
  assert.equal(observe("take_snapshot", { pageId: 1 }, a), undefined);
  assert.equal(observe("take_snapshot", { pageId: 1 }, a), undefined);
  assert.equal(observe("take_snapshot", { pageId: 1 }, b), undefined);
  assert.equal(observe("take_snapshot", { pageId: 2 }, b), undefined);
  assert.equal(observe("take_snapshot", { pageId: 2 }, b), undefined);
  assert.equal(observe("take_snapshot", { pageId: 2 }, b).consecutive, 3);
});

test("actions, explicit waits, failed reads, exceptions and different read channels break a successful read streak", () => {
  for (const [name, result] of [
    ["click", {}],
    ["wait_for", {}],
    ["take_snapshot", { isError: true }],
    ["take_snapshot", { error: "transport failed" }],
    ["list_pages", {}],
  ]) {
    const observe = readonlyProgressDetector();
    observe("take_snapshot", {}, { content: "same" });
    observe("take_snapshot", {}, { content: "same" });
    assert.equal(observe(name, {}, result), undefined);
    assert.equal(observe("take_snapshot", {}, { content: "same" }), undefined);
    assert.equal(observe("take_snapshot", {}, { content: "same" }), undefined);
    assert.equal(
      observe("take_snapshot", {}, { content: "same" }).consecutive,
      3,
    );
  }
});

function controlledBrowser(t, { launchError = false } = {}) {
  t.mock.method(chromium, "launchPersistentContext", async (profile) => {
    if (launchError) throw new Error("Synthetic launch failure");
    await fs.mkdir(profile, { recursive: true });
    await fs.writeFile(path.join(profile, "DevToolsActivePort"), "9222\n");
    return { route: async () => {}, close: async () => {} };
  });
  t.mock.method(Client.prototype, "connect", async () => {});
  t.mock.method(Client.prototype, "close", async () => {});
  t.mock.method(Client.prototype, "listTools", async () => ({
    tools: [
      "take_snapshot",
      "navigate_page",
      "list_pages",
      "wait_for",
      "click",
    ].map((name) => ({ name, inputSchema: { type: "object" } })),
  }));
  t.mock.method(Client.prototype, "callTool", async ({ name }) => ({
    content: [
      {
        type: "text",
        text:
          name === "list_pages"
            ? "http://127.0.0.1:3000/"
            : "Synthetic draft form",
      },
    ],
  }));
}

async function controlledExploration(t, calls, options = {}) {
  const project = await temporary(t);
  controlledBrowser(t, options);
  let turns = 0;
  let failure;
  try {
    await exploreCase({
      config: {},
      job: {
        run: { id: "synthetic" },
        plan: { requirements: "Submit a draft" },
      },
      item,
      baseUrl: "http://127.0.0.1:3000",
      project,
      artifactRoot: "e2e/aratame/.artifacts/synthetic",
      signal: new AbortController().signal,
      api: async () => ({
        toolCalls: [{ id: String(turns), ...calls[turns++] }],
      }),
    });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure, "scenario must stop without claiming coverage");
  const evidence = JSON.parse(
    await fs.readFile(path.join(project, failure.evidence), "utf8"),
  );
  return { failure, evidence, turns };
}

test("early no-progress stop preserves diagnostic fingerprint and every full successful read", async (t) => {
  const call = { name: "take_snapshot", arguments: {} };
  const { failure, evidence, turns } = await controlledExploration(t, [
    call,
    call,
    call,
  ]);
  assert.equal(turns, 3);
  assert.equal(failure.category, "no-progress");
  assert.equal(evidence.noProgress.consecutive, 3);
  assert.match(evidence.noProgress.fingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    evidence.transcript
      .filter((entry) => entry.tool)
      .map((entry) => entry.response.content[0].text),
    Array(3).fill("Synthetic draft form"),
  );
  assert.equal(evidence.scenario, undefined);
});

test("validated terminal gap keeps actionable manual evidence without producing a spec or pass", async (t) => {
  const { failure, evidence } = await controlledExploration(t, [
    { name: "take_snapshot", arguments: {} },
    { name: "report_exploration_gap", arguments: gap() },
  ]);
  assert.equal(failure.category, "model-reported-gap");
  assert.equal(evidence.gap.blockedStep, 2);
  assert.equal(evidence.gap.manualCheck, gap().manualCheck);
  assert.match(failure.message, /declared step 2: Submit draft/);
  assert.equal(
    evidence.transcript[1].response.content[0].text,
    "Synthetic draft form",
  );
  assert.equal(evidence.scenario, undefined);
});

test("invalid terminal gap preserves prior observations and rejected terminal output", async (t) => {
  const invalid = { ...gap(), reason: "passed", blockedStep: 3 };
  const { failure, evidence } = await controlledExploration(t, [
    { name: "take_snapshot", arguments: {} },
    { name: "report_exploration_gap", arguments: invalid },
  ]);
  assert.equal(failure.category, "invalid-model-output");
  assert.equal(evidence.gap, undefined);
  assert.equal(
    evidence.transcript[1].response.content[0].text,
    "Synthetic draft form",
  );
  assert.equal(evidence.transcript.at(-1).arguments.reason, "passed");
  assert.equal(evidence.scenario, undefined);
});

test("known blocked steps use approved bounds and deterministic launch errors are not model mismatch claims", async (t) => {
  assert.throws(() =>
    validateExplorationGap({ ...gap(), blockedStep: 3 }, item),
  );
  assert.throws(() =>
    validateExplorationGap({ ...gap(), manualCheck: " " }, item),
  );
  assert.equal(
    validateExplorationGap(
      { ...gap(), blockedStep: null, missingPrerequisite: "unknown" },
      item,
    ).blockedStep,
    null,
  );
  const { failure, evidence, turns } = await controlledExploration(t, [], {
    launchError: true,
  });
  assert.equal(turns, 0);
  assert.equal(failure.category, "infrastructure");
  assert.equal(evidence.gap, undefined);
});

test("local receipt distinguishes unknown from operator-declared deployment even when infrastructure blocks before tests", async (t) => {
  const project = await temporary(t);
  for (const [id, deploymentLabel] of [
    ["unknown", undefined],
    ["declared", " synthetic-build-17 "],
  ]) {
    let failure;
    try {
      await executeJob(
        {
          project,
          baseUrl: "http://127.0.0.1:3000",
          ...(deploymentLabel === undefined ? {} : { deploymentLabel }),
        },
        {
          run: { id },
          cases: [item],
          settings: { baseUrl: "http://127.0.0.1:4000" },
        },
        async () => {},
        new AbortController().signal,
      );
    } catch (error) {
      failure = error;
    }
    assert.match(failure.message, /Playwright dependency missing/);
    const receipt = JSON.parse(
      await fs.readFile(
        path.join(failure.localReceipt.artifactRoot, "deployment-receipt.json"),
        "utf8",
      ),
    );
    assert.equal(
      receipt.deploymentLabel,
      deploymentLabel ? "synthetic-build-17" : null,
    );
    assert.equal(receipt.target, "http://127.0.0.1:3000");
    assert.deepEqual(receipt.cases, [{ caseId: "synthetic", caseVersion: 2 }]);
    assert.equal(path.isAbsolute(receipt.artifactRoot), true);
    assert.equal(new Date(receipt.startedAt).toISOString(), receipt.startedAt);
    assert.deepEqual(failure.localReceipt, receipt);
  }
});

test("bounded hosted gap summaries retain the manual next step and disclose omitted local facts", () => {
  const large = validateExplorationGap(
    {
      ...gap(),
      observedFacts: Array(10).fill("f".repeat(2000)),
      missingPrerequisite: "p".repeat(2000),
      manualCheck: "m".repeat(2000),
    },
    item,
  );
  const detail = explorationGapDetail(large, item);
  assert.ok(detail.length < 9000);
  assert.ok(detail.includes(large.manualCheck));
  assert.match(detail, /truncated; full facts in local evidence/);
});

test("an explicitly requested run regenerates legacy unmapped coverage without inheriting its old approval", async (t) => {
  const project = await temporary(t);
  controlledBrowser(t);
  // Control only external browser/Playwright outcomes; execute the real approval-selection,
  // compiler, local-artifact and review-publication paths.
  const dependency = path.join(project, "node_modules/@playwright/test");
  await fs.mkdir(dependency, { recursive: true });
  await fs.writeFile(
    path.join(dependency, "package.json"),
    JSON.stringify({
      name: "@playwright/test",
      type: "module",
      exports: { "./cli": "./cli.mjs" },
    }),
  );
  const playwrightReport = {
    suites: [
      {
        specs: [
          {
            title: item.title,
            tests: [
              {
                expectedStatus: "passed",
                status: "expected",
                results: [{ status: "passed" }],
              },
            ],
          },
        ],
      },
    ],
  };
  await fs.writeFile(
    path.join(dependency, "cli.mjs"),
    `import fs from 'node:fs/promises'; await fs.writeFile(process.env.PLAYWRIGHT_JSON_OUTPUT_FILE, ${JSON.stringify(JSON.stringify(playwrightReport))});`,
  );
  const legacy = proposal();
  for (const step of legacy.steps) delete step.mapping;
  legacy.steps.push(...legacy.assertions);
  delete legacy.assertions;
  const job = {
    run: { id: "legacy" },
    cases: [item],
    plan: { requirements: "Submit draft" },
    reviews: [
      {
        caseId: item.id,
        kind: "coverage",
        status: "approved",
        proposal: JSON.stringify(legacy),
      },
    ],
  };
  const calls = [
    { name: "take_snapshot", arguments: {} },
    { name: "write_browser_test", arguments: proposal() },
  ];
  let turn = 0;
  const report = await executeJob(
    { project, baseUrl: "http://127.0.0.1:3000" },
    job,
    async (endpoint) =>
      endpoint.endsWith("/model")
        ? { toolCalls: [{ id: String(turn), ...calls[turn++] }] }
        : {},
    new AbortController().signal,
  );
  assert.equal(
    turn,
    2,
    "new exploration is required rather than fabricated legacy mappings",
  );
  assert.equal(report.results[0].status, "passed");
  assert.equal(
    report.status,
    "review",
    "old approval must not publish regenerated assertions",
  );
  assert.equal(report.reviews[0].kind, "coverage");
  assert.deepEqual(JSON.parse(report.reviews[0].proposal), proposal());
});
