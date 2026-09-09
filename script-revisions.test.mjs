import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { executeJob, processRun } from "./execution.mjs";
import { compileScenario } from "./exploration.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const signal = () => AbortSignal.timeout(60_000);

async function projectFor(t) {
  const project = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "aratame-revisions-")),
  );
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  await fs.symlink(
    fileURLToPath(new URL("./node_modules", import.meta.url)),
    path.join(project, "node_modules"),
    "dir",
  );
  await fs.mkdir(path.join(project, "tests"));
  await fs.writeFile(path.join(project, "package.json"), '{"type":"module"}');
  await fs.writeFile(
    path.join(project, "tests/support.mjs"),
    "export const answer = 42;\n",
  );
  return project;
}

async function linkedCase(project, id, body) {
  const specPath = `tests/${id}.spec.mjs`;
  const source = `import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import { answer } from './support.mjs';
test('${id}', async () => {
  ${body}
});\n`;
  await fs.writeFile(path.join(project, specPath), source);
  return {
    id,
    title: id,
    version: 1,
    steps: ["Check answer"],
    expected: "42",
    specPath,
  };
}

function assignment(cases, run = {}) {
  return {
    run: { id: "revision-run", changeSetId: "feature", ...run },
    leaseToken: "lease",
    cases,
    reviews: [],
    plan: { requirements: "Check answer" },
  };
}

async function savedRevision(report, item, sha256) {
  return fs.readFile(
    path.join(
      report.localReceipt.artifactRoot,
      "scripts",
      `${item.id}-${sha256}${path.extname(item.specPath)}`,
    ),
  );
}

test("staged scripts bind before real Playwright execution, retain exact bytes and report passed and failed revision hashes", async (t) => {
  const project = await projectFor(t);
  const passed = await linkedCase(
    project,
    "passing",
    `expect(await fs.readFile('bound-passing', 'utf8')).toBe('yes'); expect(answer).toBe(42);`,
  );
  const failed = await linkedCase(
    project,
    "failing",
    `expect(await fs.readFile('bound-failing', 'utf8')).toBe('yes'); expect(answer).toBe(0);`,
  );
  const originals = new Map(
    await Promise.all(
      [passed, failed].map(async (item) => [
        item.id,
        await fs.readFile(path.join(project, item.specPath)),
      ]),
    ),
  );
  const report = await executeJob(
    { project, deploymentLabel: "local-label" },
    assignment([passed, failed], {
      deploymentIdentity: "cloud-declared-build",
    }),
    async (endpoint, body) => {
      if (endpoint === "/heartbeat") return {};
      assert.equal(endpoint, "/runs/revision-run/scripts");
      assert.equal(body.sha256, digest(originals.get(body.caseId)));
      assert.deepEqual(Object.keys(body).sort(), [
        "caseId",
        "caseVersion",
        "leaseToken",
        "sha256",
        "specPath",
      ]);
      await fs.writeFile(path.join(project, `bound-${body.caseId}`), "yes");
      return {};
    },
    signal(),
  );
  assert.deepEqual(
    report.results.map(({ status, testCount }) => ({ status, testCount })),
    [
      { status: "passed", testCount: 1 },
      { status: "failed", testCount: 1 },
    ],
  );
  for (const [index, item] of [passed, failed].entries()) {
    const hash = digest(originals.get(item.id));
    assert.equal(report.results[index].scriptSha256, hash);
    assert.deepEqual(
      await savedRevision(report, item, hash),
      originals.get(item.id),
    );
    const copy = path.join(
      report.localReceipt.artifactRoot,
      "scripts",
      `${item.id}-${hash}.mjs`,
    );
    assert.equal((await fs.stat(copy)).mode & 0o222, 0);
  }
  const receipt = JSON.parse(
    await fs.readFile(
      path.join(report.localReceipt.artifactRoot, "deployment-receipt.json"),
      "utf8",
    ),
  );
  assert.equal(receipt.cloudDeploymentIdentity, "cloud-declared-build");
  assert.equal(receipt.deploymentLabel, "local-label");
});

test("a script mutating itself during real execution cannot certify the original revision", async (t) => {
  const project = await projectFor(t);
  const item = await linkedCase(
    project,
    "mutating",
    `await fs.appendFile(new URL(import.meta.url), '// changed during execution\\n'); await fs.writeFile('executed', 'yes'); expect(answer).toBe(42);`,
  );
  const original = await fs.readFile(path.join(project, item.specPath));
  const report = await executeJob(
    { project },
    assignment([item]),
    async () => ({}),
    signal(),
  );
  assert.equal(
    await fs.readFile(path.join(project, "executed"), "utf8"),
    "yes",
  );
  assert.equal(report.status, "blocked");
  assert.equal(report.results[0].testCount, 0);
  assert.equal(report.results[0].scriptSha256, undefined);
  assert.match(report.results[0].detail, /cannot certify/);
  assert.notDeepEqual(
    await fs.readFile(path.join(project, item.specPath)),
    original,
  );
  assert.deepEqual(
    await savedRevision(report, item, digest(original)),
    original,
  );
});

test("server binding rejection and mutation during binding both stop execution without a claimed digest", async (t) => {
  for (const mode of ["rejected", "changed"]) {
    const project = await projectFor(t);
    const item = await linkedCase(
      project,
      mode,
      "await fs.writeFile('executed', 'yes'); expect(answer).toBe(42);",
    );
    const report = await executeJob(
      { project },
      assignment([item]),
      async (endpoint) => {
        if (!endpoint.endsWith("/scripts")) return {};
        if (mode === "rejected") throw new Error("Script revision conflict");
        await fs.appendFile(
          path.join(project, item.specPath),
          "// changed before execution\n",
        );
        return {};
      },
      signal(),
    );
    assert.equal(report.status, "blocked");
    assert.equal(report.results[0].testCount, 0);
    assert.equal(report.results[0].scriptSha256, undefined);
    await assert.rejects(fs.access(path.join(project, "executed")), {
      code: "ENOENT",
    });
  }
});

test("run-generated scripts require binding and retain compiler bytes even when Cloud rejects execution", async (t) => {
  const project = await projectFor(t);
  const item = {
    id: "generated",
    title: "Open target",
    version: 1,
    steps: ["Open target"],
    expected: "Target URL",
  };
  const scenario = {
    caseVersion: 1,
    expected: item.expected,
    rationale: "Approved navigation",
    steps: [
      { action: "navigate", path: "/", mapping: { kind: "declared", step: 1 } },
    ],
    assertions: [{ action: "assertUrl", path: "/" }],
  };
  const baseUrl = "http://127.0.0.1:3000";
  const job = assignment([item]);
  job.reviews = [
    {
      caseId: item.id,
      kind: "coverage",
      status: "approved",
      proposal: JSON.stringify(scenario),
    },
  ];
  const report = await executeJob(
    { project, baseUrl },
    job,
    async (endpoint) => {
      if (endpoint === "/heartbeat") return {};
      if (endpoint.endsWith("/scripts"))
        throw new Error("Feature cancelled before execution");
      throw new Error(`Unexpected hosted request: ${endpoint}`);
    },
    signal(),
  );
  assert.equal(report.status, "blocked");
  assert.match(report.results[0].detail, /Feature cancelled/);
  assert.equal(report.results[0].scriptSha256, undefined);
  const source = Buffer.from(compileScenario(scenario, item, baseUrl));
  const generated = {
    ...item,
    specPath: "e2e/aratame/generated-v1-revision-run.spec.mjs",
  };
  assert.deepEqual(
    await savedRevision(report, generated, digest(source)),
    source,
  );
  await assert.rejects(
    fs.access(
      path.join(report.localReceipt.artifactRoot, "generated-generated.json"),
    ),
    { code: "ENOENT" },
  );
});

test("legacy and standalone-shaped runs execute independently without hosted script binding or Cloud attribution inference", async (t) => {
  const project = await projectFor(t);
  const item = await linkedCase(
    project,
    "independent",
    "expect(answer).toBe(42);",
  );
  for (const id of ["legacy-run", "local-run"]) {
    const report = await executeJob(
      { project, deploymentLabel: "local-only" },
      assignment([item], { id, changeSetId: undefined }),
      async (endpoint) => {
        assert.equal(endpoint, "/heartbeat");
        return {};
      },
      signal(),
    );
    assert.equal(report.status, "passed");
    assert.equal(report.results[0].testCount, 1);
    assert.equal(report.results[0].scriptSha256, undefined);
    assert.equal(report.localReceipt.cloudDeploymentIdentity, null);
    assert.equal(report.localReceipt.deploymentLabel, "local-only");
  }
});

test("an already enrolled CLI worker advertises revision support and completes a bound staged assignment without uploading source or receipt", async (t) => {
  const project = await projectFor(t);
  const item = await linkedCase(project, "cli", "expect(answer).toBe(42);");
  const sha256 = digest(await fs.readFile(path.join(project, item.specPath)));
  let bound = false;
  let completed;
  const server = createServer(async (request, response) => {
    try {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      let result = {};
      if (request.url === "/api/runner/claim") {
        result = {
          job: body.capabilities?.includes("script-revisions-v1")
            ? assignment([item])
            : null,
        };
      } else if (request.url === "/api/runner/runs/revision-run/scripts") {
        assert.equal(body.sha256, sha256);
        assert.deepEqual(Object.keys(body).sort(), [
          "caseId",
          "caseVersion",
          "leaseToken",
          "sha256",
          "specPath",
        ]);
        bound = true;
      } else if (request.url === "/api/runner/runs/revision-run/report") {
        assert.equal(bound, true);
        assert.equal(body.results[0].scriptSha256, sha256);
        assert.equal(body.localReceipt, undefined);
        completed = body;
        result = { id: "revision-run", status: body.status };
      } else {
        assert.equal(request.url, "/api/runner/heartbeat");
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(409, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const filename = path.join(project, "runner.json");
  await fs.writeFile(
    filename,
    JSON.stringify({
      project,
      server: `http://127.0.0.1:${server.address().port}`,
      token: "runner-token",
      runnerId: "runner",
    }),
    { mode: 0o600 },
  );
  const execution = await processRun(
    process.execPath,
    [
      fileURLToPath(new URL("./cli.mjs", import.meta.url)),
      "start",
      "--once",
      "--config",
      filename,
    ],
    { cwd: project, signal: signal() },
  );
  assert.equal(execution.code, 0, execution.output);
  assert.equal(completed?.status, "passed", execution.output);
  assert.equal(completed.results[0].testCount, 1);
});

test("approved run-generated browser coverage executes the bound compiler revision against a real local target", async (t) => {
  const project = await projectFor(t);
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end('<!doctype html><p data-testid="result">Target ready</p>');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const item = {
    id: "browser",
    title: "Open target",
    version: 1,
    steps: ["Open target"],
    expected: "Target ready",
  };
  const scenario = {
    caseVersion: 1,
    expected: item.expected,
    rationale: "Approved target observation",
    steps: [
      { action: "navigate", path: "/", mapping: { kind: "declared", step: 1 } },
    ],
    assertions: [
      {
        action: "assertText",
        target: { by: "testId", value: "result" },
        text: "Target ready",
      },
    ],
  };
  const linked = await linkedCase(
    project,
    "combined",
    "const count = Number(await fs.readFile('executions', 'utf8').catch(() => '0')); await fs.writeFile('executions', String(count + 1)); expect(answer).toBe(42);",
  );
  const job = assignment([linked, item]);
  job.reviews = [
    {
      caseId: item.id,
      kind: "coverage",
      status: "approved",
      proposal: JSON.stringify(scenario),
    },
  ];
  const bindings = new Map();
  const report = await executeJob(
    { project, baseUrl },
    job,
    async (endpoint, body) => {
      if (endpoint === "/heartbeat") return {};
      assert.equal(endpoint, "/runs/revision-run/scripts");
      const prior = bindings.get(body.caseId);
      if (prior) assert.deepEqual(body, prior);
      else bindings.set(body.caseId, body);
      return {};
    },
    signal(),
  );
  assert.equal(report.status, "passed", JSON.stringify(report.results));
  assert.deepEqual(
    report.results.map(({ status, testCount }) => ({ status, testCount })),
    [
      { status: "passed", testCount: 1 },
      { status: "passed", testCount: 1 },
    ],
  );
  const result = report.results.find((result) => result.caseId === item.id);
  const source = Buffer.from(compileScenario(scenario, item, baseUrl));
  assert.equal(result.scriptSha256, digest(source));
  assert.equal(bindings.get(item.id).sha256, digest(source));
  assert.deepEqual(
    await savedRevision(
      report,
      { ...item, specPath: result.specPath },
      digest(source),
    ),
    source,
  );
  assert.equal(
    report.reviews.length,
    0,
    "approved staged coverage needs no replacement approval",
  );
  const linkedResult = report.results.find(
    (result) => result.caseId === linked.id,
  );
  assert.equal(
    await fs.readFile(path.join(project, "executions"), "utf8"),
    "2",
  );
  assert.equal(
    linkedResult.scriptSha256,
    digest(await fs.readFile(path.join(project, linked.specPath))),
  );
});
