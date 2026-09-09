import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { standalone, planSchema } from "./standalone.mjs";

function behavior(
  title,
  preconditions = "A declared isolated account with an empty inbox.",
  expected = "The inbox empty-state message is visible.",
) {
  return {
    title,
    surface: "inbox",
    category: "functional",
    priority: "P1",
    preconditions,
    steps: ["Open the inbox"],
    expected,
  };
}

test("controlled standalone review retains named findings without changing the strict legacy plan format", async (context) => {
  const project = await fs.mkdtemp(
    path.join(os.tmpdir(), "aratame-standalone-recoveries-"),
  );
  context.after(() => fs.rm(project, { recursive: true, force: true }));
  const previousKey = process.env.ARATAME_RECOVERY_SYNTHETIC_KEY;
  context.after(() => {
    if (previousKey === undefined)
      delete process.env.ARATAME_RECOVERY_SYNTHETIC_KEY;
    else process.env.ARATAME_RECOVERY_SYNTHETIC_KEY = previousKey;
  });
  process.env.ARATAME_RECOVERY_SYNTHETIC_KEY = "standalone-synthetic-key";
  await fs.writeFile(
    path.join(project, "config.json"),
    JSON.stringify({
      baseUrl: "http://127.0.0.1:3000",
      deploymentLabel: "controlled-build",
      model: {
        provider: "openai",
        model: "controlled",
        apiKeyEnv: "ARATAME_RECOVERY_SYNTHETIC_KEY",
      },
    }),
  );
  await fs.writeFile(
    path.join(project, "requirements.txt"),
    "Review an ambiguous list count and a previous-test account dependency alongside an explicitly declared population.",
  );
  const cases = [
    behavior(
      "Ambiguous inbox count",
      "An authenticated account.",
      "List shows 3.",
    ),
    behavior("Previous-test account", "Use account created in previous test."),
    behavior(
      "Declared population",
      "The supplied baseline account owns exactly three messages; no filter or pagination.",
      "The inbox list shows the three baseline messages.",
    ),
  ];
  const gaps = [
    "Ambiguous inbox count: missing named population baseline.",
    "Previous-test account: missing independent account baseline.",
  ];
  const draft = {
    title: "Local inbox",
    cases,
    gaps: [],
    rationale: "Controlled local review",
  };
  const outputs = [draft, { critique: "Missing prerequisites", gaps }, draft];
  context.mock.method(globalThis, "fetch", async () => {
    assert.ok(outputs.length, "unexpected model request");
    return new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: "stop",
            message: { content: JSON.stringify(outputs.shift()) },
          },
        ],
      }),
      { headers: { "content-type": "application/json" } },
    );
  });
  context.mock.method(console, "log", () => {});
  await standalone("plan", {
    project,
    config: "config.json",
    requirements: "requirements.txt",
  });
  const plan = JSON.parse(
    await fs.readFile(path.join(project, "e2e/aratame/plan.json"), "utf8"),
  );
  assert.deepEqual(plan.gaps, gaps);
  assert.equal(plan.cases.length, 3);
  assert.equal(plan.cases[2].expected, cases[2].expected);
  assert.equal(planSchema.safeParse(plan).success, true);
  assert.equal(
    planSchema.safeParse({ ...plan, deploymentLabel: "not-a-plan-field" })
      .success,
    false,
  );
  assert.equal(outputs.length, 0);
});
