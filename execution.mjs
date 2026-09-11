import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import {
  compileScenario,
  exploreCase,
  exploreRepairCase,
} from "./exploration.mjs";
import { applyRepairProposal, validateRepairProposal } from "./repair.mjs";
import { pathToFileURL } from "node:url";
import { artifactPathSchema, artifactRevisionSchema, readPublishedArtifacts } from "./published-artifacts.mjs";

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
  const assignedPins = [job.publishedRevision, run.publishedRevision, job.plan?.publishedRevision].filter((value) => value !== undefined);
  const publishedRevision = assignedPins.length ? artifactRevisionSchema.parse(assignedPins[0]) : undefined;
  for (const pin of assignedPins) {
    const parsed = artifactRevisionSchema.parse(pin);
    if (Object.keys(parsed).some((key) => parsed[key] !== publishedRevision[key]))
      throw new Error("Assigned published revisions disagree");
  }
  const candidatePins = [job.candidateRevision, run.candidateRevision].filter((value) => value !== undefined);
  const candidateRevision = candidatePins.length ? artifactRevisionSchema.parse(candidatePins[0]) : undefined;
  for (const pin of candidatePins) {
    const parsed = artifactRevisionSchema.parse(pin);
    if (Object.keys(parsed).some((key) => parsed[key] !== candidateRevision[key]))
      throw new Error("Assigned candidate revisions disagree");
  }
  // A proposed checkout is execution evidence, never accepted planning authority.
  const checkoutRevision = candidateRevision ?? publishedRevision;
  const project = await fs.realpath(config.project);
  const artifactRoot = `e2e/aratame/.artifacts/${run.id}-${Date.now()}`;
  const localFiles = new Map((config.localFiles || []).map((file) => [artifactPathSchema.parse(file.path), file.sha256]));
  const writeJobFile = async (root, relative, content) => {
    const written = await writeGenerated(root, relative, content);
    if (!relative.startsWith(`${artifactRoot}/`))
      localFiles.set(relative, createHash("sha256").update(content).digest("hex"));
    return written;
  };
  let inputsVerified = false;
  const logs = [];
  const reviews = [];
  const results = [];
  const scriptRevisions = new Map();
  const repairs = [];
  let supportingFileRevisions;
  const verifyInputs = async () => {
    const published = checkoutRevision
      ? await readPublishedArtifacts({
          projectDir: config.project, revision: checkoutRevision,
          localFiles: [...localFiles].map(([path, sha256]) => ({ path, sha256 })).concat(
            (job.supportingFiles || []).filter((file) => !localFiles.has(file?.path)),
          ),
          outputDirectories: [artifactRoot],
        })
      : undefined;
    const requested = job.supportingFiles || [];
    if (!Array.isArray(requested) || requested.length > 500)
      throw new Error("Supporting files must be a bounded explicit list");
    if (published?.files.some((file) => file.kind === "fixture" && !requested.some((entry) => entry?.path === file.path && entry.sha256 === file.sha256)))
      throw new Error("Assigned supporting files omit or replace a published fixture");
    const captured = [];
    let totalBytes = 0;
    for (const file of requested) {
      if (!file || Object.keys(file).some((key) => !["path", "sha256"].includes(key)) ||
        !artifactPathSchema.safeParse(file.path).success || !/^[a-f0-9]{64}$/.test(file.sha256))
        throw new Error("Invalid assigned supporting file");
      if (captured.some((entry) => entry.path === file.path))
        throw new Error("Duplicate assigned supporting file");
      const publishedFile = published?.files.find((entry) => entry.path === file.path);
      if (publishedFile && (publishedFile.kind !== "fixture" || publishedFile.sha256 !== file.sha256))
        throw new Error(`Supporting file conflicts with the published revision: ${file.path}`);
      const absolute = await safePath(project, file.path);
      const stat = await fs.stat(absolute);
      if (!stat.isFile() || stat.size > 1_000_000)
        throw new Error(`Supporting file is not a bounded ordinary file: ${file.path}`);
      const bytes = await fs.readFile(absolute);
      totalBytes += bytes.length;
      if (bytes.length > 1_000_000 || totalBytes > 10_000_000)
        throw new Error("Supporting files exceed the approved file budget");
      if (createHash("sha256").update(bytes).digest("hex") !== file.sha256)
        throw new Error(`Supporting file differs from approved bytes: ${file.path}`);
      captured.push({ path: file.path, sha256: file.sha256 });
    }
    supportingFileRevisions = captured;
  };
  const selections = new Map();
  const repairEnabled = job.settings?.repairEnabled === true;
  const repairHistory = job.repairHistory || job.run.repairHistory || [];
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
    cloudDeploymentIdentity: run.deploymentIdentity ?? null,
    ...(publishedRevision ? { publishedRevision } : {}),
    ...(candidateRevision ? { candidateRevision } : {}),
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
    if (checkoutRevision) {
      const capture = async (filename, expected) => {
        if (localFiles.has(filename)) return;
        const absolute = await safePath(project, artifactPathSchema.parse(filename));
        const stat = await fs.stat(absolute);
        if (!stat.isFile() || stat.size > 2_000_000) throw new Error(`Local input is not a bounded ordinary file: ${filename}`);
        const bytes = await fs.readFile(absolute);
        localFiles.set(filename, expected || createHash("sha256").update(bytes).digest("hex"));
      };
      for (const filename of [config.localConfigPath, config.playwrightConfig, config.storageState].filter(Boolean))
        await capture(filename);
      for (const item of cases.filter((entry) => entry.specPath))
        await capture(item.specPath, item.sha256);
      for (const review of (job.reviews || []).filter((entry) => entry.kind === "repair" && entry.status === "approved" && entry.proposal)) {
        const item = cases.find((entry) => entry.id === review.caseId);
        if (!item) throw new Error("Approved repair is not selected by this assignment");
        const proposal = validateRepairProposal(JSON.parse(review.proposal), item);
        if (proposal.baseUrl !== baseUrl) throw new Error("Repair target differs from the approved target");
        try {
          await fs.lstat(await safePath(project, proposal.proposedSpecPath));
          localFiles.set(proposal.proposedSpecPath, proposal.proposedSha256);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          // An absent approved candidate becomes mandatory only after our exclusive write.
        }
      }
    }
    // Reserve this run's output directory exclusively; never infer prior output ownership.
    await fs.mkdir(await safePath(project, artifactRoot, true), { mode: 0o700 });
    await verifyInputs();
    inputsVerified = true;
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
    await writeJobFile(project,
    `${artifactRoot}/deployment-receipt.json`,
    JSON.stringify(localReceipt, null, 2),);
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
    await writeJobFile(project,
    `${artifactRoot}/assignment.json`,
    JSON.stringify(
      { runId: run.id, cases, startedAt: localReceipt.startedAt },
      null,
      2,
    ),);
    const runFixture = async (phase) => {
      if (!config.fixture) return;
      await verifyInputs();
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
      await writeJobFile(project,
      `${artifactRoot}/fixture-${phase}.log`,
      fixture.output,);
      logs.push(
        `Fixture ${phase} exit ${fixture.code}; output retained locally at ${artifactRoot}/fixture-${phase}.log`,
      );
      if (fixture.code !== 0 || fixture.timedOut)
        throw new Error(
          `Locally configured fixture command failed during ${phase}`,
        );
    };
    await runFixture("initial");
    await verifyInputs();
    const runSpec = async (
      item,
      specPath,
      specTag,
      generated = false,
      phase = "verify",
    ) => {
      signal.throwIfAborted();
      await verifyInputs();
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
        "--update-snapshots=none",
        "--trace=on",
        "--timeout=30000",
        `--output=${tracePath}`,
      ];
      if (specTag) args.push("--grep", escape(specTag));
      if (selections.get(item.id)?.repair)
        args.push("--config", await repairedConfig(item, specPath));
      else if (generated) args.push("--config", await generatedConfig());
      else if (config.playwrightConfig)
        args.push("--config", await safePath(project, config.playwrightConfig));
      let revision;
      const verifyRevision = async () => {
        if (!revision) return;
        try {
          const current = await safePath(project, specPath);
          if (
            !(await fs.stat(current)).isFile() ||
            createHash("sha256")
              .update(await fs.readFile(current))
              .digest("hex") !== revision.sha256
          )
            throw new Error("Script bytes changed");
        } catch {
          throw new Error(
            `Script revision changed or became unreadable: ${specPath}. Execution cannot certify the bound bytes; original script evidence remains local at ${revision.evidence}.`,
          );
        }
      };
      if (run.changeSetId || repairEnabled || selections.get(item.id)?.repair) {
        revision = scriptRevisions.get(item.id);
        if (!revision) {
          const bytes = await fs.readFile(absolute);
          const sha256 = createHash("sha256").update(bytes).digest("hex");
          const evidence = `${artifactRoot}/scripts/${item.id}-${sha256}${path.extname(specPath)}`;
          const copy = await writeJobFile(project, evidence, bytes);
          await fs.chmod(copy, 0o400);
          revision = { sha256, specPath, specTag, evidence };
          scriptRevisions.set(item.id, revision);
        }
        if (revision.specPath !== specPath || revision.specTag !== specTag)
          throw new Error("Script selection changed within the assigned run");
        await verifyRevision();
        if (run.changeSetId)
          await api(
            `/runs/${run.id}/scripts`,
            {
              leaseToken,
              caseId: item.id,
              caseVersion: item.version,
              specPath,
              ...(specTag ? { specTag } : {}),
              sha256: revision.sha256,
            },
            signal,
          );
        // Source copies are evidence, not repository/dependency isolation.
        await verifyRevision();
      }
      let execution;
      try {
        await verifyInputs();
        execution = await processRun(process.execPath, args, {
          cwd: project,
          signal,
          timeout: config.testTimeoutMs || 180_000,
          env: {
            PLAYWRIGHT_JSON_OUTPUT_FILE: reportPath,
            ...(baseUrl ? { ARATAME_BASE_URL: baseUrl } : {}),
          },
        });
      } finally {
        // Even a failed/aborted process cannot certify mutated source bytes.
        await verifyRevision();
      }
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
        ...(revision && executed.length
          ? { scriptSha256: revision.sha256 }
          : {}),
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
      configPath = await writeJobFile(project,
      `${artifactRoot}/playwright.config.mjs`,
      `export default ${JSON.stringify({ testDir: path.join(project, "e2e/aratame"), testMatch: "**/*.spec.mjs", timeout: 30000, fullyParallel: false, retries: 0, workers: 1, use: { baseURL: baseUrl, storageState, headless: true, trace: "on" } })};\n`,);
      return configPath;
    }
    const repairConfigs = new Map();
    async function repairedConfig(item, specPath) {
      if (repairConfigs.has(item.id)) return repairConfigs.get(item.id);
      let originalConfig = config.playwrightConfig;
      if (!originalConfig) {
        for (const extension of ["ts", "js", "mts", "mjs", "cts", "cjs"]) {
          const candidate = `playwright.config.${extension}`;
          try {
            if ((await fs.stat(await safePath(project, candidate))).isFile()) {
              originalConfig = candidate;
              break;
            }
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
        }
      }
      const absolute = item.specPath.startsWith("e2e/aratame/")
        ? await generatedConfig()
        : originalConfig
          ? await safePath(project, originalConfig)
          : undefined;
      const root = absolute ? path.dirname(absolute) : project;
      const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const originalSpec = await safePath(project, item.specPath);
      const discoveryPath = await safePath(
        project,
        `${artifactRoot}/${item.id}-repair-projects.json`,
        true,
      );
      const discoveryArgs = [
        playwright,
        "test",
        escape(originalSpec),
        "--list",
        "--no-deps",
        "--reporter=json",
        "--forbid-only",
      ];
      if (absolute) discoveryArgs.push("--config", absolute);
      if (item.specTag) discoveryArgs.push("--grep", escape(item.specTag));
      await verifyInputs();
      const discovery = await processRun(process.execPath, discoveryArgs, {
        cwd: project,
        signal,
        timeout: config.testTimeoutMs || 180_000,
        env: {
          PLAYWRIGHT_JSON_OUTPUT_FILE: discoveryPath,
          ...(baseUrl ? { ARATAME_BASE_URL: baseUrl } : {}),
        },
      });
      await writeJobFile(project,
      `${artifactRoot}/${item.id}-repair-projects.log`,
      discovery.output,);
      if (discovery.code !== 0 || discovery.timedOut)
        throw new Error(
          "Original Playwright project selection could not be discovered; inspect local repair-projects evidence",
        );
      const discovered = JSON.parse(await fs.readFile(discoveryPath, "utf8"));
      const selectedNames = [
        ...new Set(testsFromReport(discovered).map((test) => test.projectName)),
      ];
      if (
        discovered.errors?.length ||
        !selectedNames.length ||
        selectedNames.some((name) => typeof name !== "string")
      )
        throw new Error(
          "Original linked test has no unambiguous Playwright project selection",
        );
      // Discover only direct execution projects. Dependencies and teardowns keep
      // their own files, fixtures and discovery rules; never run the repair as setup.
      const repairConfigPath = await writeJobFile(project,
      `${artifactRoot}/${item.id}-repair.config.mjs`,
      `
      ${absolute ? `import original from ${JSON.stringify(pathToFileURL(absolute).href)};` : "const original = {};"}
      import path from 'node:path';
      import fs from 'node:fs';
      import { createRequire } from 'node:module';
      const root = ${JSON.stringify(root)};
      const originalSpec = ${JSON.stringify(originalSpec)};
      const candidate = ${JSON.stringify(path.join(project, specPath))};
      const selected = new Set(${JSON.stringify(selectedNames)});
      const metadata = ${JSON.stringify(discovered.config.projects)};
      const resolve = value => typeof value === 'string' ? path.resolve(root, value) : value;
      const rootTemplate = template => path.isAbsolute(template) ? template : root + path.sep + template;
      const resolveTemplate = template => /^\\{\\/?(?:testDir|snapshotDir)\\}/.test(template) ? template : rootTemplate(template);
      const legacyTemplate = '{snapshotDir}/{testFileDir}/{testFileName}-snapshots/{arg}{-projectName}{-snapshotSuffix}{ext}';
      const ariaTemplate = '{snapshotDir}/{testFileDir}/{testFileName}-snapshots/{arg}{ext}';
      function projectConfig(value) {
        const name = value.name ?? original.name ?? '';
        const effective = metadata.find(project => project.name === name);
        if (!effective) throw new Error('Original project configuration changed during repair selection');
        const snapshotDir = resolve(value.snapshotDir ?? original.snapshotDir) || effective.testDir;
        const base = {...value, testDir: effective.testDir, outputDir: effective.outputDir, snapshotDir};
        if (value.tsconfig) base.tsconfig = resolve(value.tsconfig);
        const expectation = value.expect ?? original.expect ?? {};
        const screenshot = expectation.toHaveScreenshot || {};
        const stylePath = screenshot.stylePath;
        const screenshotOptions = {...screenshot, ...(stylePath ? {stylePath: (Array.isArray(stylePath) ? stylePath : [stylePath]).map(resolve)} : {})};
        base.expect = {...expectation, toHaveScreenshot: screenshotOptions};
        if (!selected.has(name)) {
          const template = value.snapshotPathTemplate ?? original.snapshotPathTemplate;
          if (template) base.snapshotPathTemplate = resolveTemplate(template);
          if (screenshot.pathTemplate) base.expect.toHaveScreenshot.pathTemplate = resolveTemplate(screenshot.pathTemplate);
          if (expectation.toMatchAriaSnapshot?.pathTemplate)
            base.expect.toMatchAriaSnapshot = {...expectation.toMatchAriaSnapshot, pathTemplate: resolveTemplate(expectation.toMatchAriaSnapshot.pathTemplate)};
          return base;
        }
        const relative = path.relative(effective.testDir, originalSpec);
        const tokens = {testDir: effective.testDir, snapshotDir, testFileDir: path.dirname(relative) === '.' ? '' : path.dirname(relative), testFileBaseName: path.parse(originalSpec).name, testFileName: path.basename(originalSpec), testFilePath: relative};
        const relocateTemplate = template => rootTemplate(template.replace(/\\{(.)?(testDir|snapshotDir|testFileDir|testFileBaseName|testFileName|testFilePath)\\}/g, (_match, prefix, token) => (prefix || '') + tokens[token]));
        const inheritedTemplate = value.snapshotPathTemplate ?? original.snapshotPathTemplate;
        return {...base, testDir: ${JSON.stringify(project)}, testMatch: candidate, testIgnore: [],
          snapshotPathTemplate: relocateTemplate(inheritedTemplate || legacyTemplate),
          expect: {...base.expect,
            toHaveScreenshot: {...screenshotOptions, pathTemplate: relocateTemplate(screenshot.pathTemplate || inheritedTemplate || legacyTemplate)},
            toMatchAriaSnapshot: {...expectation.toMatchAriaSnapshot, pathTemplate: relocateTemplate(expectation.toMatchAriaSnapshot?.pathTemplate || inheritedTemplate || ariaTemplate)}
          }
        };
      }
      const require = createRequire(path.join(root, 'package.json'));
      const hook = id => fs.existsSync(resolve(id)) ? resolve(id) : require.resolve(id, {paths:[root]});
      const hooks = value => Array.isArray(value) ? value.map(hook) : hook(value);
      export default {
        ...original,
        ...(original.projects ? {testDir: resolve(original.testDir) || root, projects: original.projects.map(projectConfig)} : projectConfig(original)),
        ...(original.tsconfig ? {tsconfig: resolve(original.tsconfig)} : {}),
        ...(original.globalSetup ? {globalSetup: hooks(original.globalSetup)} : {}),
        ...(original.globalTeardown ? {globalTeardown: hooks(original.globalTeardown)} : {}),
        ...(original.webServer ? {webServer: (Array.isArray(original.webServer) ? original.webServer : [original.webServer]).map(server => ({...server, cwd: server.cwd ? resolve(server.cwd) : root}))} : {})
      };
      `,);
      repairConfigs.set(item.id, repairConfigPath);
      return repairConfigPath;
    }
    const existing = cases.filter(
      (item) =>
        item.specPath &&
        (item.automatedVersion === undefined ||
          item.automatedVersion === item.version),
    );
    const uncovered = cases.filter((item) => !existing.includes(item));
    // Approval selects a new run's exclusive candidate, never a second binding
    // after executing the original in this assignment.
    for (const item of existing) {
      let result;
      const approved = (job.reviews || []).filter(
        (review) =>
          review.caseId === item.id &&
          review.kind === "repair" &&
          review.status === "approved" &&
          review.proposal,
      );
      try {
        let selection = { specPath: item.specPath, specTag: item.specTag };
        if (approved.length) {
          if (approved.length !== 1)
            throw new Error(
              "Repair selection is ambiguous for this assignment",
            );
          const proposal = validateRepairProposal(
            JSON.parse(approved[0].proposal),
            item,
          );
          if (proposal.baseUrl !== baseUrl)
            throw new Error("Repair target differs from the approved target");
          const originalPath = await safePath(project, item.specPath);
          const source = await fs.readFile(originalPath, "utf8");
          const repaired = applyRepairProposal(proposal, source, item, baseUrl);
          signal.throwIfAborted();
          const specPath = proposal.proposedSpecPath;
          try {
            await writeJobFile(project, specPath, repaired);
          } catch (error) {
            if (error.code !== "EEXIST") throw error;
            const candidate = await safePath(project, specPath);
            if (
              createHash("sha256")
                .update(await fs.readFile(candidate))
                .digest("hex") !== proposal.proposedSha256
            )
              throw new Error(
                "Existing repair candidate differs from the exact approved bytes; nothing was overwritten",
              );
          }
          selection = { specPath, specTag: item.specTag, repair: proposal };
          repairs.push({
            caseId: item.id,
            proposal: approved[0].proposal,
            originalFailure: proposal.originalFailure,
            approval: approved[0].approvalDecision || {
              basis: "exact local proposal digest",
            },
            verification: { status: "not_run", testCount: 0 },
          });
        }
        selections.set(item.id, selection);
        result = await runSpec(
          item,
          selection.specPath,
          selection.specTag,
          !selection.repair && item.specPath.startsWith("e2e/aratame/"),
          selection.repair ? "repair-verification" : "existing",
        );
        if (selection.repair) {
          repairs.find((entry) => entry.caseId === item.id).verification =
            result;
          result.detail = `Approved repair verification ${result.status}; original failure retained in repair history. ${result.detail}`;
        }
      } catch (error) {
        result = { status: "blocked", detail: error.message, testCount: 0 };
        const entry = repairs.find((entry) => entry.caseId === item.id);
        if (entry) entry.verification = result;
      }
      results.push({ caseId: item.id, caseVersion: item.version, ...result });
      if (result.status === "failed") {
        const selection = selections.get(item.id);
        const failure = {
          caseId: item.id,
          kind: "failure",
          title: `Review existing test: ${item.title}`,
          detail: `${result.detail}\nBaseline and required behavior were not changed.`,
        };
        reviews.push(failure);
        if (repairEnabled && !signal.aborted) {
          try {
            const originalSha =
              selection?.repair?.original.sha256 ||
              scriptRevisions.get(item.id)?.sha256;
            const history = repairHistory.filter(
              (review) => review.caseId === item.id,
            );
            const previousProposals = history
              .flatMap((review) => {
                try {
                  return [
                    validateRepairProposal(JSON.parse(review.proposal), item),
                  ];
                } catch {
                  return [];
                }
              })
              .filter((proposal) => proposal.original.sha256 === originalSha);
            if (previousProposals.length >= 3)
              throw new Error(
                "Repair attempt budget exhausted (3); revise the plan or resolve the failure manually",
              );
            const source = await fs.readFile(
              await safePath(project, item.specPath),
              "utf8",
            );
            if (
              createHash("sha256").update(source).digest("hex") !== originalSha
            )
              throw new Error(
                "Original script changed after the failed execution",
              );
            await verifyInputs();
            const { proposal, evidence } = await exploreRepairCase({
              config,
              job,
              item,
              baseUrl,
              project,
              artifactRoot,
              api,
              signal,
              source,
              originalFailure: selection?.repair?.originalFailure || result,
              attempt: previousProposals.length + 1,
              previousProposals,
            });
            if (
              previousProposals.some(
                (previous) =>
                  previous.proposedSha256 === proposal.proposedSha256,
              )
            )
              throw new Error(
                "Repair stopped: repeated proposal made no progress",
              );
            reviews.push({
              caseId: item.id,
              kind: "repair",
              title: `Review linked repair: ${item.title}`,
              detail: `Original Playwright failure retained locally. ${proposal.classification.category}: ${proposal.classification.rationale}. ${proposal.classification.applicable ? "Exact proposal approval and a new run are required; not yet verified." : "Not applicable; revise the plan instead."} Local evidence: ${evidence}`,
              proposal: JSON.stringify(proposal),
            });
          } catch (error) {
            failure.detail += `\nRepair stopped without applying changes: ${error.message}`;
          }
        }
      }
    }
    signal.throwIfAborted();
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
        const approved = (job.reviews || []).find(
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
        await verifyInputs();
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
        await writeJobFile(project,
        specPath,
        compileScenario(artifact, item, baseUrl),);
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
    if (generated.length || repairs.length)
      for (const item of existing) {
        if (!selections.has(item.id)) continue;
        let result;
        try {
          result = await runSpec(
            item,
            selections.get(item.id)?.specPath || item.specPath,
            selections.get(item.id)?.specTag || item.specTag,
            !selections.get(item.id)?.repair &&
              item.specPath.startsWith("e2e/aratame/"),
            "combined",
          );
        } catch (error) {
          signal.throwIfAborted();
          result = { status: "blocked", detail: error.message, testCount: 0 };
        }
        const repair = repairs.find((entry) => entry.caseId === item.id);
        if (repair) repair.regression = result;
        // A later pass never erases an earlier verification failure.
        const prior = results.find((entry) => entry.caseId === item.id);
        if (prior && prior.status !== "passed" && result.status === "passed")
          continue;
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
    await verifyInputs();
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
      repairs,
      status,
      ...(publishedRevision ? { publishedRevision } : {}),
      ...(candidateRevision ? { candidateRevision } : {}),
      ...(job.supportingFiles ? { supportingFileRevisions } : {}),
      logs: logs.join("\n").slice(-90_000),
    };
    await writeJobFile(project,
    `${artifactRoot}/result.json`,
    JSON.stringify(report, null, 2),);
    return { ...report, localReceipt };
  } catch (error) {
    if (supportingFileRevisions !== undefined) {
      try {
        await verifyInputs();
      } catch (verificationError) {
        supportingFileRevisions = undefined;
        for (const result of results) {
          result.status = "blocked";
          result.detail = `Published/supporting inputs changed; execution cannot be certified: ${verificationError.message}`;
        }
      }
    }
    error.partialReport = {
      results,
      reviews,
      repairs,
      status: "blocked",
      ...(publishedRevision ? { publishedRevision } : {}),
      ...(candidateRevision ? { candidateRevision } : {}),
      ...(job.supportingFiles && supportingFileRevisions !== undefined ? { supportingFileRevisions } : {}),
      logs: logs.join("\n").slice(-90_000),
    };
    try {
      if (!inputsVerified) throw error;
      await writeJobFile(project,
      `${artifactRoot}/interrupted-result.json`,
      JSON.stringify(
        { ...error.partialReport, error: error.message },
        null,
        2,
      ),);
    } catch {
      // Preserve the execution error even if the filesystem is no longer writable.
    }
    error.localReceipt = localReceipt;
    throw error;
  }
}
