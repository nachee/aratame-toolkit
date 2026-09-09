import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { compileScenario, exploreCase } from "./exploration.mjs";

export async function safePath(project, relative, createParents = false) {
  if (
    typeof relative !== "string" ||
    path.isAbsolute(relative) ||
    relative.includes("\\") ||
    relative.split("/").some((p) => !p || p === "." || p === "..")
  )
    throw new Error("Unsafe project path");
  const parts = relative.split("/");
  let current = project;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink())
        throw new Error(`Symlink paths are forbidden: ${relative}`);
      if (i < parts.length - 1 && !stat.isDirectory())
        throw new Error("Parent is not a directory");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (i < parts.length - 1 && createParents)
        await fs.mkdir(current, { mode: 0o700 });
      else if (i < parts.length - 1) throw error;
    }
  }
  return current;
}
export async function writeGenerated(project, relative, content) {
  if (!relative.startsWith("e2e/aratame/"))
    throw new Error("Writes are restricted to e2e/aratame");
  const target = await safePath(project, relative, true);
  const handle = await fs.open(target, "wx", 0o600);
  try {
    await handle.writeFile(content);
  } finally {
    await handle.close();
  }
  return target;
}
export async function processRun(
  command,
  args,
  { cwd, signal, timeout = 180_000, env = {} },
) {
  signal.throwIfAborted();
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let output = "",
      timedOut = false;
    const capture = (chunk) => {
      output = (output + chunk.toString()).slice(-80_000);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    const stop = () => {
      try {
        if (process.platform === "win32") child.kill("SIGTERM");
        else process.kill(-child.pid, "SIGTERM");
      } catch {}
      const force = setTimeout(() => {
        try {
          if (process.platform === "win32") child.kill("SIGKILL");
          else process.kill(-child.pid, "SIGKILL");
        } catch {}
      }, 2000);
      force.unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeout);
    signal.addEventListener("abort", stop, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
    };
    child.on("error", (error) => {
      cleanup();
      reject(error);
    });
    child.on("close", (code) => {
      cleanup();
      if (signal.aborted) reject(signal.reason || new Error("Cancelled"));
      else resolve({ code, output, timedOut });
    });
  });
}
function testsFromReport(report) {
  const tests = [];
  const visit = (suite) => {
    for (const spec of suite.specs || [])
      for (const test of spec.tests || [])
        tests.push({ ...test, title: spec.title });
    for (const child of suite.suites || []) visit(child);
  };
  for (const suite of report.suites || []) visit(suite);
  return tests;
}
export async function executeJob(config, job, api, signal) {
  const { run, cases, leaseToken } = job;
  const project = await fs.realpath(config.project);
  const artifactRoot = `e2e/aratame/.artifacts/${run.id}-${Date.now()}`;
  const logs = [];
  const reviews = [];
  const results = [];
  const baseUrl = config.baseUrl || job.settings?.baseUrl;
  if (
    config.deploymentLabel !== undefined &&
    (typeof config.deploymentLabel !== "string" ||
      !config.deploymentLabel.trim() ||
      config.deploymentLabel.trim().length > 200)
  )
    throw new Error(
      "deploymentLabel must be a non-empty operator label of at most 200 characters",
    );
  const localReceipt = {
    runId: run.id,
    deploymentLabel: config.deploymentLabel?.trim() ?? null,
    target: baseUrl || null,
    targetScope: "configured runner target; existing specs may override",
    cases: cases.map((item) => ({
      caseId: item.id,
      caseVersion: item.version,
    })),
    startedAt: new Date().toISOString(),
    artifactRoot: path.join(project, artifactRoot),
  };
  try {
    if (baseUrl) {
      const target = new URL(baseUrl);
      if (
        !["http:", "https:"].includes(target.protocol) ||
        target.username ||
        target.password
      )
        throw new Error(
          "Target baseUrl must use HTTP(S) without embedded credentials",
        );
    }
    await writeGenerated(
      project,
      `${artifactRoot}/deployment-receipt.json`,
      JSON.stringify(localReceipt, null, 2),
    );
    let playwright;
    try {
      playwright = createRequire(path.join(project, "package.json")).resolve(
        "@playwright/test/cli",
      );
    } catch {
      throw new Error(
        "Project Playwright dependency missing: install @playwright/test in the customer project and run npx playwright install chromium there.",
      );
    }
    await writeGenerated(
      project,
      `${artifactRoot}/assignment.json`,
      JSON.stringify(
        { runId: run.id, cases, startedAt: localReceipt.startedAt },
        null,
        2,
      ),
    );
    const runFixture = async (phase) => {
      if (!config.fixture) return;
      if (
        !Array.isArray(config.fixture) ||
        !config.fixture.length ||
        config.fixture.length > 100 ||
        config.fixture.some(
          (s) => typeof s !== "string" || s.length > 10_000 || s.includes("\0"),
        ) ||
        !config.fixture[0]
      )
        throw new Error(
          "Local fixture must be a bounded executable/argv array, not a shell string",
        );
      const fixture = await processRun(
        config.fixture[0],
        config.fixture.slice(1),
        { cwd: project, signal, timeout: 120_000 },
      );
      await writeGenerated(
        project,
        `${artifactRoot}/fixture-${phase}.log`,
        fixture.output,
      );
      logs.push(
        `Fixture ${phase} exit ${fixture.code}; output retained locally at ${artifactRoot}/fixture-${phase}.log`,
      );
      if (fixture.code !== 0 || fixture.timedOut)
        throw new Error(
          `Locally configured fixture command failed during ${phase}`,
        );
    };
    await runFixture("initial");
    const runSpec = async (
      item,
      specPath,
      specTag,
      generated = false,
      phase = "verify",
    ) => {
      signal.throwIfAborted();
      await api("/heartbeat", { runId: run.id, leaseToken }, signal);
      const absolute = await safePath(project, specPath);
      if (!(await fs.stat(absolute)).isFile())
        throw new Error(`Spec is not a regular file: ${specPath}`);
      const reportRelative = `${artifactRoot}/${item.id}-${phase}.json`;
      const reportPath = await safePath(project, reportRelative, true);
      const tracePath = await safePath(
        project,
        `${artifactRoot}/${item.id}-${phase}-traces`,
        true,
      );
      const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const args = [
        playwright,
        "test",
        escape(absolute),
        "--reporter=json",
        "--workers=1",
        "--retries=0",
        "--forbid-only",
        "--trace=on",
        "--timeout=30000",
        `--output=${tracePath}`,
      ];
      if (specTag) args.push("--grep", escape(specTag));
      if (generated) args.push("--config", await generatedConfig());
      else if (config.playwrightConfig)
        args.push("--config", await safePath(project, config.playwrightConfig));
      const execution = await processRun(process.execPath, args, {
        cwd: project,
        signal,
        timeout: config.testTimeoutMs || 180_000,
        env: {
          PLAYWRIGHT_JSON_OUTPUT_FILE: reportPath,
          ...(baseUrl ? { ARATAME_BASE_URL: baseUrl } : {}),
        },
      });
      logs.push(
        `${phase} ${specPath}: exit ${execution.code}\n${execution.output}`,
      );
      let report;
      try {
        report = JSON.parse(await fs.readFile(reportPath, "utf8"));
      } catch {
        return {
          status: "blocked",
          detail: `Infrastructure blocked: Playwright produced no readable JSON report. ${execution.output.slice(-3000)}`,
          testCount: 0,
        };
      }
      const tests = testsFromReport(report);
      const executed = tests.filter(
        (t) =>
          Array.isArray(t.results) &&
          t.results.some((r) => r.status !== "skipped"),
      );
      const failures = tests.filter(
        (t) =>
          t.expectedStatus !== "passed" ||
          t.status !== "expected" ||
          t.results?.length !== 1 ||
          t.results[0].status !== "passed",
      );
      const browserMissing = tests.some((test) =>
        test.results?.some((result) =>
          /Executable doesn't exist|browserType\.launch:.*(?:ENOENT|Failed to launch|Target page, context or browser has been closed)/s.test(
            result.error?.message || "",
          ),
        ),
      );
      const infrastructure =
        execution.timedOut ||
        report.errors?.length ||
        !executed.length ||
        browserMissing;
      const status = infrastructure
        ? "blocked"
        : execution.code === 0 &&
            !failures.length &&
            tests.length === executed.length
          ? "passed"
          : "failed";
      const detail =
        status === "passed"
          ? `${executed.length} Playwright test(s) passed, no retries. Report: ${reportRelative}`
          : `${infrastructure ? "Infrastructure blocked. " : "Playwright verification failed. "}${executed.length} executed; ${failures.length} incomplete or failing. ${execution.timedOut ? "Process timed out. " : ""}${JSON.stringify(report.errors || []).slice(0, 2000)} ${failures
              .map(
                (t) =>
                  `${t.title}: ${t.results?.map((r) => r.error?.message || r.status).join(", ")}`,
              )
              .join("\n")
              .slice(0, 5000)} Report: ${reportRelative}`;
      return {
        status,
        detail,
        testCount: executed.length,
        evidence: reportRelative,
        specPath,
        ...(specTag ? { specTag } : {}),
      };
    };
    let configPath;
    async function generatedConfig() {
      if (configPath) return configPath;
      if (!baseUrl || !["http:", "https:"].includes(new URL(baseUrl).protocol))
        throw new Error(
          "Configure a valid target base URL before browser exploration",
        );
      const storageState = config.storageState
        ? await safePath(project, config.storageState)
        : undefined;
      configPath = await writeGenerated(
        project,
        `${artifactRoot}/playwright.config.mjs`,
        `export default ${JSON.stringify({ testDir: path.join(project, "e2e/aratame"), testMatch: "**/*.spec.mjs", timeout: 30000, fullyParallel: false, retries: 0, workers: 1, use: { baseURL: baseUrl, storageState, headless: true, trace: "on" } })};\n`,
      );
      return configPath;
    }
    const existing = cases.filter(
      (item) =>
        item.specPath &&
        (item.automatedVersion === undefined ||
          item.automatedVersion === item.version),
    );
    const uncovered = cases.filter((item) => !existing.includes(item));
    // Reuse first; do not explore or rewrite a linked failing test.
    for (const item of existing) {
      let result;
      try {
        result = await runSpec(
          item,
          item.specPath,
          item.specTag,
          item.specPath.startsWith("e2e/aratame/"),
          "existing",
        );
      } catch (error) {
        signal.throwIfAborted();
        result = { status: "blocked", detail: error.message, testCount: 0 };
      }
      results.push({ caseId: item.id, caseVersion: item.version, ...result });
      if (result.status === "failed")
        reviews.push({
          caseId: item.id,
          kind: "failure",
          title: `Review existing test: ${item.title}`,
          detail: `${result.detail}\nNo application, assertion, or selector changes were made. A human must approve any non-selector repair; selector repairs require unambiguous evidence.`,
        });
    }
    const generated = [];
    for (const item of uncovered) {
      signal.throwIfAborted();
      if (existing.length && results.some((r) => r.status !== "passed")) {
        results.push({
          caseId: item.id,
          caseVersion: item.version,
          status: "blocked",
          detail:
            "Existing suite did not pass; review it before exploring uncovered cases.",
          testCount: 0,
        });
        continue;
      }
      try {
        const approved = job.reviews.find(
          (review) =>
            review.caseId === item.id &&
            review.kind === "coverage" &&
            review.status === "approved" &&
            review.proposal,
        );
        let artifact;
        let approvedArtifact = false;
        if (approved) {
          try {
            const proposal = JSON.parse(approved.proposal);
            if (
              proposal.caseVersion === item.version &&
              proposal.expected === item.expected
            ) {
              if (
                Array.isArray(proposal.steps) &&
                proposal.steps.some((step) => !step?.mapping)
              ) {
                logs.push(
                  `Legacy unmapped proposal for ${item.id} is not reusable; this explicitly authorized run regenerates coverage requiring new approval.`,
                );
              } else {
                artifact = proposal;
                approvedArtifact = true;
              }
            }
          } catch {}
        }
        if (!artifact)
          artifact = await exploreCase({
            config,
            job,
            item,
            baseUrl,
            project,
            artifactRoot,
            api,
            signal,
          });
        // All generated assertions are reviewed before publishing automation links.
        const specPath = `e2e/aratame/${item.id}-v${item.version}-${run.id}.spec.mjs`;
        const specTag = `aratame:${item.id}:v${item.version}`;
        await writeGenerated(
          project,
          specPath,
          compileScenario(artifact, item, baseUrl),
        );
        generated.push({
          item,
          artifact,
          specPath,
          specTag,
          approved: approvedArtifact,
        });
      } catch (error) {
        signal.throwIfAborted();
        results.push({
          caseId: item.id,
          caseVersion: item.version,
          status: "blocked",
          detail: `Exploration blocked: ${error.message}`.slice(0, 10_000),
          testCount: 0,
          ...(error.evidence ? { evidence: error.evidence } : {}),
        });
      }
    }
    // Exploration may mutate fixture state; reset using only the operator's local command before verification.
    if (generated.length) await runFixture("verification");
    for (const entry of generated) {
      let result;
      try {
        result = await runSpec(
          entry.item,
          entry.specPath,
          entry.specTag,
          true,
          "generated",
        );
      } catch (error) {
        signal.throwIfAborted();
        result = { status: "blocked", detail: error.message, testCount: 0 };
      }
      results.push({
        caseId: entry.item.id,
        caseVersion: entry.item.version,
        ...result,
      });
      if (
        (result.status === "passed" && !entry.approved) ||
        result.status === "failed"
      )
        reviews.push({
          caseId: entry.item.id,
          kind: result.status === "failed" ? "failure" : "coverage",
          title: `Review generated coverage: ${entry.item.title}`,
          detail: `${result.detail}\nApprove the proposed browser actions and assertions before this automation is linked. Expected outcome was not modified.`,
          proposal: JSON.stringify(entry.artifact),
        });
    }
    // New tests can affect shared state: verify the pre-existing selection again, serially.
    if (generated.length)
      for (const item of existing) {
        let result;
        try {
          result = await runSpec(
            item,
            item.specPath,
            item.specTag,
            item.specPath.startsWith("e2e/aratame/"),
            "combined",
          );
        } catch (error) {
          signal.throwIfAborted();
          result = { status: "blocked", detail: error.message, testCount: 0 };
        }
        results[results.findIndex((r) => r.caseId === item.id)] = {
          caseId: item.id,
          caseVersion: item.version,
          ...result,
        };
        if (
          result.status === "failed" &&
          !reviews.some((r) => r.caseId === item.id)
        )
          reviews.push({
            caseId: item.id,
            kind: "failure",
            title: `Existing coverage failed after exploration: ${item.title}`,
            detail: result.detail,
          });
      }
    const status = reviews.length
      ? "review"
      : results.some((r) => r.status === "blocked" || r.status === "not_run")
        ? "blocked"
        : results.some((r) => r.status === "failed")
          ? "failed"
          : results.length === cases.length && results.length > 0
            ? "passed"
            : "blocked";
    const report = {
      results,
      reviews,
      status,
      logs: logs.join("\n").slice(-90_000),
    };
    await writeGenerated(
      project,
      `${artifactRoot}/result.json`,
      JSON.stringify(report, null, 2),
    );
    return { ...report, localReceipt };
  } catch (error) {
    error.localReceipt = localReceipt;
    throw error;
  }
}
