import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { executeJob, processRun } from "./execution.mjs";
import { createRepairProposal } from "./repair.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");

test("approved repair preserves dependency setup, cwd-relative auth, original config, imports and snapshot goldens without minting baselines", async (t) => {
  const project = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "aratame-repair-runtime-")),
  );
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  await fs.symlink(
    fileURLToPath(new URL("./node_modules", import.meta.url)),
    path.join(project, "node_modules"),
    "dir",
  );
  await fs.mkdir(path.join(project, "tests"));
  await fs.writeFile(path.join(project, "package.json"), '{"type":"module"}');
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(
      `<button>Save now</button><p>Waiting</p><script>document.querySelector('button').onclick=()=>{document.querySelector('p').textContent='Saved'}</script>`,
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  await fs.mkdir(path.join(project, "configs"));
  await fs.mkdir(path.join(project, "tests/goldens/save.spec.mjs"), {
    recursive: true,
  });
  const golden = path.join(project, "tests/goldens/save.spec.mjs/state.txt");
  await fs.writeFile(golden, "Saved");
  await fs.writeFile(
    path.join(project, "configs/playwright.config.mjs"),
    `export default {
    testDir:'../tests', snapshotPathTemplate:'{testDir}/goldens/{testFileName}/{arg}{ext}',
    use:{baseURL:${JSON.stringify(baseUrl)},headless:true},
    projects:[
      {name:'setup',testMatch:'**/*.setup.mjs',teardown:'cleanup'},
      {name:'chromium',testMatch:'**/*.spec.mjs',dependencies:['setup'],use:{storageState:'playwright/auth.json'}},
      {name:'cleanup',testMatch:'**/*.cleanup.mjs'}
    ]
  };`,
  );
  await fs.writeFile(
    path.join(project, "tests/auth.setup.mjs"),
    `import {test} from '@playwright/test'; import fs from 'node:fs/promises'; test('setup auth',async()=>{await fs.mkdir('playwright',{recursive:true});await fs.writeFile('playwright/auth.json',JSON.stringify({cookies:[{name:'fixture',value:'ready',domain:'127.0.0.1',path:'/',expires:-1,httpOnly:false,secure:false,sameSite:'Lax'}],origins:[]}));await fs.appendFile('setup-count','S');});`,
  );
  await fs.writeFile(
    path.join(project, "tests/auth.cleanup.mjs"),
    `import {test} from '@playwright/test'; import fs from 'node:fs/promises'; test('cleanup auth',async()=>{await fs.unlink('playwright/auth.json');await fs.appendFile('cleanup-count','C');});`,
  );
  const config = { project, playwrightConfig: "configs/playwright.config.mjs" };
  await fs.writeFile(
    path.join(project, "tests/support.mjs"),
    "export const expected = 'Saved';",
  );
  const before = "page.getByRole('button', { name: 'Save old' })";
  const after = "page.getByRole('button', { name: 'Save now' })";
  const source = `import {test, expect} from '@playwright/test';
import {expected} from './support.mjs';
test('save', async ({page, baseURL}) => {
  expect(baseURL).toBe(${JSON.stringify(baseUrl)});
  await page.goto('/');
  expect(await page.context().cookies()).toContainEqual(expect.objectContaining({name:'fixture',value:'ready'}));
  await ${before}.click({timeout:100});
  await expect(page.getByText(expected, {exact:true})).toBeVisible();
  expect(expected).toMatchSnapshot('state.txt');
});\n`;
  const item = {
    id: "save",
    version: 1,
    title: "Save record",
    specPath: "tests/save.spec.mjs",
    steps: ["Save the record"],
    expected: "Saved is visible",
  };
  const regression = {
    id: "regression",
    version: 1,
    title: "Original regression",
    specPath: "tests/regression.spec.mjs",
    steps: ["Check baseline"],
    expected: "Baseline remains unchanged",
  };
  await fs.writeFile(path.join(project, item.specPath), source);
  await fs.writeFile(
    path.join(project, regression.specPath),
    `import {test,expect} from '@playwright/test'; import fs from 'node:fs/promises'; test('regression',async()=>{expect(await fs.readFile('tests/save.spec.mjs','utf8')).toBe(${JSON.stringify(source)});await fs.appendFile('regression-count','R');});`,
  );
  const original = await executeJob(
    config,
    {
      run: { id: "original" },
      cases: [item, regression],
      reviews: [],
      settings: { baseUrl },
    },
    async () => ({}),
    AbortSignal.timeout(60_000),
  );
  assert.equal(original.results[0].status, "failed");
  const proposal = createRepairProposal({
    source,
    item,
    baseUrl,
    changes: [
      {
        start: source.indexOf(before),
        end: source.indexOf(before) + before.length,
        before,
        after,
      },
    ],
    originalFailure: original.results[0],
  });
  const bindings = [];
  const job = {
    run: { id: "approved", changeSetId: "feature" },
    cases: [item, regression],
    reviews: [
      {
        caseId: item.id,
        kind: "repair",
        status: "approved",
        proposal: JSON.stringify(proposal),
      },
    ],
    settings: { baseUrl, repairEnabled: false },
  };
  const approved = await executeJob(
    config,
    job,
    async (endpoint, body) => {
      if (endpoint.endsWith("/scripts")) bindings.push(body);
      return {};
    },
    AbortSignal.timeout(60_000),
  );
  assert.equal(approved.status, "passed", JSON.stringify(approved));
  assert.equal(approved.repairs[0].originalFailure.status, "failed");
  assert.equal(approved.repairs[0].verification.status, "passed");
  assert.equal(approved.repairs[0].regression.status, "passed");
  assert.deepEqual(
    bindings
      .filter((entry) => entry.caseId === item.id)
      .map(({ specPath, sha256 }) => ({ specPath, sha256 })),
    Array(2).fill({
      specPath: proposal.proposedSpecPath,
      sha256: proposal.proposedSha256,
    }),
  );
  assert.equal(
    await fs.readFile(path.join(project, "regression-count"), "utf8"),
    "RRR",
  );
  assert.equal(
    await fs.readFile(path.join(project, item.specPath), "utf8"),
    source,
  );
  assert.equal(
    digest(await fs.readFile(path.join(project, proposal.proposedSpecPath))),
    proposal.proposedSha256,
  );
  assert.equal(
    await fs.readFile(path.join(project, "setup-count"), "utf8"),
    "SSSSSS",
  );
  assert.equal(
    await fs.readFile(path.join(project, "cleanup-count"), "utf8"),
    "CCCCCC",
  );
  assert.equal(await fs.readFile(golden, "utf8"), "Saved");
  await fs.unlink(golden);
  for (const id of ["missing-golden-first", "missing-golden-again"]) {
    const missing = await executeJob(
      config,
      { ...job, run: { ...job.run, id } },
      async () => ({}),
      AbortSignal.timeout(60_000),
    );
    assert.equal(
      missing.results.find((result) => result.caseId === item.id).status,
      "failed",
      JSON.stringify(missing),
    );
    await assert.rejects(fs.stat(golden), { code: "ENOENT" });
  }
  await fs.writeFile(
    path.join(project, proposal.proposedSpecPath),
    "// unrelated existing file\n",
  );
  bindings.length = 0;
  const blocked = await executeJob(
    config,
    { ...job, run: { ...job.run, id: "changed" } },
    async (endpoint, body) => {
      if (endpoint.endsWith("/scripts")) bindings.push(body);
      return {};
    },
    AbortSignal.timeout(60_000),
  );
  assert.equal(
    blocked.results.find((result) => result.caseId === item.id).status,
    "blocked",
  );
  assert.equal(
    bindings.some((entry) => entry.caseId === item.id),
    false,
  );
  assert.equal(
    await fs.readFile(path.join(project, proposal.proposedSpecPath), "utf8"),
    "// unrelated existing file\n",
  );
});

test("linked Toolkit-generated failures and approved repairs retain generated discovery outside the project testDir", async (t) => {
  const project = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "aratame-linked-generated-")),
  );
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  await fs.symlink(
    fileURLToPath(new URL("./node_modules", import.meta.url)),
    path.join(project, "node_modules"),
    "dir",
  );
  await fs.mkdir(path.join(project, "tests"));
  await fs.mkdir(path.join(project, "e2e/aratame"), { recursive: true });
  await fs.writeFile(path.join(project, "package.json"), '{"type":"module"}');
  await fs.writeFile(
    path.join(project, "playwright.config.mjs"),
    "export default {testDir:'tests'};",
  );
  const specPath = "e2e/aratame/already-linked.spec.mjs";
  const before = "page.getByText('Old')";
  const source = `import {test,expect} from '@playwright/test'; test('linked generated',async({page})=>{await page.setContent('<button>Ready</button>');await ${before}.click({timeout:100});await expect(page.getByRole('button')).toHaveText('Ready');});`;
  await fs.writeFile(path.join(project, specPath), source);
  const item = {
    id: "generated",
    version: 1,
    title: "Linked generated",
    specPath,
    steps: ["Click the ready button"],
    expected: "Ready remains visible",
  };
  const baseUrl = "http://127.0.0.1:3000";
  const report = await executeJob(
    { project },
    {
      run: { id: "linked-generated" },
      cases: [item],
      reviews: [],
      settings: { baseUrl },
    },
    async () => ({}),
    AbortSignal.timeout(30_000),
  );
  assert.equal(report.results[0].status, "failed", JSON.stringify(report));
  assert.equal(report.results[0].testCount, 1);
  const proposal = createRepairProposal({
    source,
    item,
    baseUrl,
    changes: [
      {
        start: source.indexOf(before),
        end: source.indexOf(before) + before.length,
        before,
        after: "page.getByText('Ready')",
      },
    ],
    originalFailure: report.results[0],
  });
  const verified = await executeJob(
    { project },
    {
      run: { id: "repair-linked-generated" },
      cases: [item],
      reviews: [
        {
          caseId: item.id,
          kind: "repair",
          status: "approved",
          proposal: JSON.stringify(proposal),
        },
      ],
      settings: { baseUrl },
    },
    async () => ({}),
    AbortSignal.timeout(30_000),
  );
  assert.equal(verified.status, "passed", JSON.stringify(verified));
  assert.equal(verified.repairs[0].regression.status, "passed");
  assert.equal(await fs.readFile(path.join(project, specPath), "utf8"), source);
});

test("local repair approval is separate from plan approval and rejects changed report bytes before execution", async (t) => {
  const project = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "aratame-repair-cli-")),
  );
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  const baseUrl = "http://127.0.0.1:3000";
  const item = {
    id: "save",
    version: 1,
    title: "Save record",
    surface: "form",
    category: "functional",
    priority: "P1",
    preconditions: "Declared disposable account",
    steps: ["Save record"],
    expected: "Saved is visible",
    specPath: "tests/save.spec.mjs",
  };
  const source =
    "import {test,expect} from '@playwright/test'; test('save',async({page})=>{await page.getByText('Old').click();await expect(page.getByText('Saved')).toBeVisible();});";
  const before = "page.getByText('Old')";
  const proposal = createRepairProposal({
    source,
    item,
    baseUrl,
    changes: [
      {
        start: source.indexOf(before),
        end: source.indexOf(before) + before.length,
        before,
        after: "page.getByText('New')",
      },
    ],
    originalFailure: {
      status: "failed",
      detail: "Playwright failed",
      testCount: 1,
    },
  });
  const plan = JSON.stringify({
    schemaVersion: 1,
    title: "Save records",
    baseUrl,
    requirements: "Save record",
    sources: [],
    rationale: "Exercise save",
    gaps: [],
    cases: [item],
  });
  const report = JSON.stringify({
    planSha256: digest(plan),
    baseUrl,
    reviews: [
      { caseId: item.id, kind: "repair", proposal: JSON.stringify(proposal) },
    ],
  });
  await fs.writeFile(path.join(project, "plan.json"), plan);
  await fs.writeFile(path.join(project, "report.json"), report);
  await fs.writeFile(
    path.join(project, "config.json"),
    JSON.stringify({ baseUrl, repair: { enabled: true } }),
  );
  const args = [
    fileURLToPath(new URL("./cli.mjs", import.meta.url)),
    "run",
    "--project",
    project,
    "--config",
    "config.json",
    "--plan",
    "plan.json",
    "--approve",
    digest(plan),
    "--repair-review",
    "report.json",
  ];
  const missing = await processRun(process.execPath, args, {
    cwd: project,
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(missing.code, 1);
  assert.match(missing.output, /Repair requires --approve-repair/);
  await fs.appendFile(path.join(project, "report.json"), "\n");
  const stale = await processRun(
    process.execPath,
    [...args, "--approve-repair", digest(report)],
    { cwd: project, signal: AbortSignal.timeout(10_000) },
  );
  assert.equal(stale.code, 1);
  assert.match(stale.output, /Repair approval digest does not match/);
  await assert.rejects(fs.stat(path.join(project, "e2e")), { code: "ENOENT" });
});

test(
  "real CLI SIGINT after an actual repair MCP snapshot retains failed evidence and closes browser and child processes",
  { skip: process.platform === "win32", timeout: 90_000 },
  async (t) => {
    const project = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "aratame-repair-cancel-")),
    );
    let child,
      closed = false;
    const pidFile = path.join(project, "child-pids");
    t.after(async () => {
      if (child && !closed) child.kill("SIGTERM");
      const pids = (await fs.readFile(pidFile, "utf8").catch(() => ""))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(Number);
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGTERM");
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      }
      if (child && !closed)
        await new Promise((resolve) => {
          const deadline = setTimeout(() => {
            child.kill("SIGKILL");
            resolve();
          }, 2000);
          child.once("close", () => {
            clearTimeout(deadline);
            resolve();
          });
        });
      await fs.rm(project, { recursive: true, force: true });
    });
    await fs.symlink(
      fileURLToPath(new URL("./node_modules", import.meta.url)),
      path.join(project, "node_modules"),
      "dir",
    );
    await fs.mkdir(path.join(project, "tests"));
    await fs.writeFile(path.join(project, "package.json"), '{"type":"module"}');
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end("<button>Ready for cancellation</button>");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const item = {
      id: "failed",
      version: 1,
      title: "Original linked failure",
      surface: "form",
      category: "functional",
      priority: "P1",
      preconditions: "Disposable local page",
      steps: ["Click the ready button"],
      expected: "Ready for cancellation remains visible",
      specPath: "tests/failed.spec.mjs",
    };
    const uncovered = {
      ...item,
      id: "notstarted",
      title: "Unstarted coverage",
      specPath: undefined,
    };
    const source = `import {test,expect} from '@playwright/test'; test('failed',async({page})=>{await page.goto(${JSON.stringify(baseUrl)});await page.getByRole('button',{name:'Old'}).click({timeout:100});await expect(page.getByText('Ready for cancellation')).toBeVisible();});`;
    await fs.writeFile(path.join(project, item.specPath), source);
    const plan = JSON.stringify({
      schemaVersion: 1,
      title: "Cancellation evidence",
      baseUrl,
      requirements: "Click the ready button without changing required behavior",
      sources: [],
      rationale: "Exercise cancellation with a retained original failure",
      gaps: [],
      cases: [item, uncovered],
    });
    await fs.writeFile(path.join(project, "plan.json"), plan);
    await fs.writeFile(
      path.join(project, "config.json"),
      JSON.stringify({
        baseUrl,
        repair: { enabled: true },
        model: {
          provider: "openrouter",
          model: "controlled-cancellation",
          apiKeyEnv: "ARATAME_CANCELLATION_KEY",
        },
      }),
    );
    // Only the provider response is controlled. Chromium, MCP, browser observations,
    // process signals, abort handling, local summaries and child shutdown are real.
    async function providerPreload() {
      const assert = (await import("node:assert/strict")).default;
      const fs = (await import("node:fs")).default;
      const childProcess = (await import("node:child_process")).default;
      const { syncBuiltinESMExports } = await import("node:module");
      const originalSpawn = childProcess.spawn;
      childProcess.spawn = function (...args) {
        const child = originalSpawn.apply(this, args);
        if (child.pid)
          fs.appendFileSync(process.env.ARATAME_CHILD_PIDS, `${child.pid}\n`);
        return child;
      };
      syncBuiltinESMExports();
      process.env.ARATAME_CANCELLATION_KEY =
        "synthetic-cancellation-fixture-not-a-credential";
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input, init = {}) => {
        const url = new URL(
          typeof input === "string" || input instanceof URL ? input : input.url,
        );
        if (url.href !== "https://openrouter.ai/api/v1/chat/completions") {
          assert.ok(
            ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname),
            "No external fixture network",
          );
          return originalFetch(input, init);
        }
        const request = JSON.parse(init.body);
        assert.equal(request.model, "controlled-cancellation");
        assert.ok(
          request.tools.some(
            (tool) => tool.function.name === "propose_linked_repair",
          ),
        );
        const calls = request.messages.flatMap(
          (message) => message.tool_calls || [],
        );
        const replies = new Map(
          request.messages
            .filter((message) => message.role === "tool")
            .map((message) => [message.tool_call_id, message.content]),
        );
        const completed = (name) =>
          calls.filter(
            (call) => call.function.name === name && replies.has(call.id),
          );
        const response = (name, args) =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  finish_reason: "tool_calls",
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: `cancel_${calls.length + 1}`,
                        type: "function",
                        function: { name, arguments: JSON.stringify(args) },
                      },
                    ],
                  },
                },
              ],
            }),
            { headers: { "content-type": "application/json" } },
          );
        if (!completed("list_pages").length) return response("list_pages", {});
        const pages = String(
          replies.get(completed("list_pages").at(-1).id),
        ).replaceAll("\\n", "\n");
        const match = pages.match(/(?:^|\n)\s*(\d+):/);
        assert.ok(match, "Page ID must come from the real MCP response");
        const pageId = Number(match[1]);
        const prompt = request.messages
          .filter((message) => message.role === "user")
          .map((message) => JSON.parse(message.content))
          .find((value) => value.repairLocators);
        if (!completed("navigate_page").length)
          return response("navigate_page", {
            pageId,
            type: "url",
            url: prompt.target,
          });
        if (!completed("take_snapshot").length)
          return response("take_snapshot", { pageId });
        assert.match(
          String(replies.get(completed("take_snapshot").at(-1).id)),
          /Ready for cancellation/,
        );
        console.log("ARATAME_CANCEL_AFTER_REAL_SNAPSHOT");
        await new Promise((_resolve, reject) => {
          if (init.signal.aborted) reject(init.signal.reason);
          else
            init.signal.addEventListener(
              "abort",
              () => reject(init.signal.reason),
              { once: true },
            );
        });
        throw new Error(
          "Cancellation fixture cannot propose or report success",
        );
      };
    }
    const preload = path.join(project, "provider-preload.mjs");
    await fs.writeFile(preload, `await (${providerPreload.toString()})();\n`);
    child = spawn(
      process.execPath,
      [
        "--import",
        preload,
        fileURLToPath(new URL("./cli.mjs", import.meta.url)),
        "run",
        "--project",
        project,
        "--config",
        "config.json",
        "--plan",
        "plan.json",
        "--approve",
        digest(plan),
      ],
      {
        cwd: project,
        env: { ...process.env, ARATAME_CHILD_PIDS: pidFile },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "",
      browserUrl;
    const exited = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        closed = true;
        resolve({ code, signal });
      });
    });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`Repair snapshot was not reached:\n${output}`)),
        60_000,
      );
      const capture = (chunk) => {
        output += chunk.toString();
        if (output.includes("ARATAME_CANCEL_AFTER_REAL_SNAPSHOT")) {
          clearTimeout(timeout);
          resolve();
        }
      };
      child.stdout.on("data", capture);
      child.stderr.on("data", capture);
      exited.then((result) => {
        clearTimeout(timeout);
        reject(
          new Error(
            `CLI exited before cancellation readiness: ${JSON.stringify(result)}\n${output}`,
          ),
        );
      }, reject);
    });
    const artifactBase = path.join(project, "e2e/aratame/.artifacts");
    const [artifactDirectory] = await fs.readdir(artifactBase);
    const artifactRoot = path.join(artifactBase, artifactDirectory);
    const port = Number(
      (
        await fs.readFile(
          path.join(artifactRoot, "chrome-failed/DevToolsActivePort"),
          "utf8",
        )
      ).split("\n")[0],
    );
    browserUrl = `http://127.0.0.1:${port}/json/version`;
    assert.match(
      (await (await fetch(browserUrl)).json()).webSocketDebuggerUrl,
      /^ws:/,
    );
    const spawnedPids = [
      ...new Set(
        (await fs.readFile(pidFile, "utf8")).trim().split("\n").map(Number),
      ),
    ];
    child.kill("SIGINT");
    const termination = await Promise.race([
      exited,
      new Promise((_resolve, reject) =>
        setTimeout(
          () => reject(new Error("CLI did not shut down after SIGINT")),
          15_000,
        ).unref(),
      ),
    ]);
    assert.deepEqual(termination, { code: 1, signal: null }, output);
    const summaries = (
      await fs.readdir(path.join(project, "e2e/aratame"))
    ).filter((name) => /^local-.*\.json$/.test(name));
    assert.equal(summaries.length, 1, output);
    const summary = JSON.parse(
      await fs.readFile(
        path.join(project, "e2e/aratame", summaries[0]),
        "utf8",
      ),
    );
    assert.equal(summary.status, "blocked");
    assert.equal(
      summary.results.find((result) => result.caseId === "failed").status,
      "failed",
    );
    assert.equal(
      summary.results.find((result) => result.caseId === "notstarted").status,
      "blocked",
    );
    assert.equal(
      summary.reviews.some((review) => review.kind === "repair"),
      false,
    );
    assert.equal(
      await fs.readFile(path.join(project, item.specPath), "utf8"),
      source,
    );
    await fs.access(
      path.join(
        project,
        summary.results.find((result) => result.caseId === "failed").evidence,
      ),
    );
    const interrupted = JSON.parse(
      await fs.readFile(
        path.join(artifactRoot, "interrupted-result.json"),
        "utf8",
      ),
    );
    assert.equal(interrupted.results[0].status, "failed");
    await assert.rejects(fs.stat(path.join(project, "e2e/aratame/repairs")), {
      code: "ENOENT",
    });
    await assert.rejects(
      fetch(browserUrl, { signal: AbortSignal.timeout(2000) }),
    );
    for (const pid of spawnedPids)
      assert.throws(
        () => process.kill(pid, 0),
        { code: "ESRCH" },
        `Owned child ${pid} survived CLI cancellation`,
      );
  },
);
