import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { artifactManifestSchema, readPublishedArtifacts, resolvePublishedOriginal } from "./published-artifacts.mjs";
import { executeJob } from "./execution.mjs";
import { standalone } from "./standalone.mjs";

const exec = promisify(execFile);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const cli = fileURLToPath(new URL("./cli.mjs", import.meta.url));
async function fixture(t, { mixed = false, mutate = false, retention = "cloud", schemaVersion = 2, gaps = ["Authentication setup remains operator-owned"] } = {}) {
  const project = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "aratame-published-")));
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  const marker = `${project}-fixture-ran`;
  t.after(() => fs.rm(marker, { force: true }));
  const git = async (...args) => (await exec("git", ["-C", project, ...args])).stdout.trim();
  const put = async (filename, content) => {
    await fs.mkdir(path.dirname(path.join(project, filename)), { recursive: true });
    await fs.writeFile(path.join(project, filename), content);
  };
  await put("package.json", '{"type":"module"}\n');
  await put(".gitignore", "node_modules/\ne2e/aratame/.artifacts/\n");
  await put("config.json", JSON.stringify({ baseUrl: "http://127.0.0.1:3000", fixture: [process.execPath, "fixtures/reset.mjs", marker] }));
  const contents = {
    "aratame/knowledge/pages/inbox.md": "# Inbox\nEmpty accounts show No messages. [ISSUE-1]\n",
    "aratame/knowledge/CONVENTIONS.md": "# Conventions\nPages are synthesis, not original evidence.\n",
    "aratame/knowledge/provenance.json": '{"retention":"cloud","originals":"not exported"}\n',
  };
  const kinds = ["knowledge", "conventions", "provenance"];
  const originalContent = "original retained separately";
  const source = { id: "ISSUE-1", title: "Empty inbox contract", source: "linear", updatedAt: "2026-09-11T00:00:00Z", sha256: digest(originalContent), retention };
  if (retention === "cloud") source.snapshotId = "snapshot-1";
  else {
    Object.assign(source, { sourceIdentity: "linear-issue-1", ingestedAt: source.updatedAt, upstreamVersion: "2026-09-10T12:00:00Z" });
    if (retention === "repository") {
      source.path = "aratame/sources/linear-issue-1.txt";
      contents[source.path] = originalContent;
      kinds.push("source-snapshot");
    }
  }
  let cases = [];
  if (mixed) {
    contents["fixtures/baseline.json"] = '{"message":"No messages"}\n';
    contents["fixtures/reset.mjs"] = "import fs from 'node:fs/promises'; await fs.writeFile(process.argv[2], 'yes');\n";
    contents["tests/inbox.spec.mjs"] = `import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
test('empty inbox', async () => {
  expect(JSON.parse(await fs.readFile('fixtures/baseline.json', 'utf8')).message).toBe('No messages');
  ${mutate ? "await fs.writeFile('fixtures/baseline.json', '{}');" : ""}
});\n`;
    kinds.push("fixture", "fixture", "script");
    cases = [{ id: "inbox", version: 3, title: "Empty inbox", surface: "inbox", category: "functional", priority: "P1", preconditions: "An empty account", steps: ["Open the inbox"], expected: "No messages is visible", sourceIssues: ["ISSUE-1"], specPath: "tests/inbox.spec.mjs", sha256: digest(contents["tests/inbox.spec.mjs"]), history: [{ id: "inbox", version: 2 }] }];
  }
  const manifest = {
    schemaVersion, kind: "aratame-artifacts",
    files: Object.entries(contents).map(([name, content], index) => ({ path: name, sha256: digest(content), kind: kinds[index], origin: kinds[index] === "fixture" ? "authored" : "generated" })),
    knowledge: [{ id: "inbox-guide", title: "Inbox", surface: "inbox", path: "aratame/knowledge/pages/inbox.md", origin: "generated", citations: ["ISSUE-1"], sourceVersions: { "ISSUE-1": "2026-09-11T00:00:00Z" }, gaps, history: [] }],
    sources: [source], cases,
  };
  for (const [name, content] of Object.entries(contents)) await put(name, content);
  const manifestPath = "aratame/knowledge/manifest.json";
  const raw = JSON.stringify(manifest, null, 2) + "\n";
  await put(manifestPath, raw);
  await git("init", "-q");
  await git("config", "user.name", "Controlled fixture");
  await git("config", "user.email", "fixture@example.invalid");
  await git("remote", "add", "origin", "https://github.com/controlled/customer.git");
  await git("add", ".");
  await git("-c", "commit.gpgsign=false", "commit", "-qm", "Controlled published fixture");
  const revision = { repository: "controlled/customer", commitSha: await git("rev-parse", "HEAD"), manifestPath, manifestSha256: digest(raw) };
  await fs.symlink(fileURLToPath(new URL("./node_modules", import.meta.url)), path.join(project, "node_modules"), "dir");
  const supportingFiles = manifest.files.filter((file) => file.kind === "fixture").map(({ path, sha256 }) => ({ path, sha256 }));
  const job = { run: { id: "published-run", publishedRevision: revision }, publishedRevision: revision, supportingFiles, cases, reviews: [], plan: { publishedRevision: revision, requirements: "Empty inbox" } };
  return { project, marker, revision, manifest, job, git, put };
}

test("KB-only published files retain source references and remain credential-free readable", async (t) => {
  const f = await fixture(t);
  const read = await readPublishedArtifacts({ projectDir: f.project, revision: f.revision });
  assert.equal(read.knowledge[0].content, "# Inbox\nEmpty accounts show No messages. [ISSUE-1]\n");
  assert.deepEqual(read.knowledge[0].citations, ["ISSUE-1"]);
  assert.deepEqual(read.cases, []);
  assert.equal(read.manifest.sources[0].snapshotId, "snapshot-1");
  assert.equal(artifactManifestSchema.safeParse({ ...f.manifest, sources: [{ ...f.manifest.sources[0], content: "raw source" }] }).success, false);
  await assert.rejects(readPublishedArtifacts({ projectDir: f.project, revision: { ...f.revision, repository: "other/customer" } }), /repository differs/);
  await assert.rejects(readPublishedArtifacts({ projectDir: f.project, revision: { ...f.revision, manifestSha256: "0".repeat(64) } }), /manifest hash differs/);
});

test("immutable v1 remains readable but cannot describe repository or references-only originals", async (t) => {
  const f = await fixture(t, { schemaVersion: 1 });
  const artifacts = await readPublishedArtifacts({ projectDir: f.project, revision: f.revision });
  assert.equal(artifacts.manifest.schemaVersion, 1);
  assert.equal(resolvePublishedOriginal(artifacts, "ISSUE-1").status, "unavailable");
  assert.equal(artifactManifestSchema.safeParse({ ...f.manifest, sources: [{ ...f.manifest.sources[0], retention: "references", sourceIdentity: "issue", ingestedAt: "now", upstreamVersion: "v1" }] }).success, false);
});

test("repository originals resolve exact verified bytes independently of mutable consumer objects", async (t) => {
  const f = await fixture(t, { retention: "repository" });
  const artifacts = await readPublishedArtifacts({ projectDir: f.project, revision: f.revision });
  const original = resolvePublishedOriginal(artifacts, "ISSUE-1");
  assert.equal(original.status, "exact");
  assert.equal(original.content, "original retained separately");
  artifacts.files.find((file) => file.kind === "source-snapshot").content = "tampered consumer copy";
  artifacts.manifest.sources[0].sha256 = digest("tampered consumer copy");
  assert.deepEqual(resolvePublishedOriginal(artifacts, "ISSUE-1"), original);
  assert.throws(() => resolvePublishedOriginal(structuredClone(artifacts), "ISSUE-1"), /requires artifacts/);
  await f.put(f.manifest.sources[0].path, "changed file");
  await assert.rejects(readPublishedArtifacts({ projectDir: f.project, revision: f.revision }), /tracked modifications/);
});

test("v2 source locators are exclusive and repository hashes and citation versions must agree", async (t) => {
  const f = await fixture(t, { retention: "repository" });
  const source = f.manifest.sources[0];
  for (const invalid of [
    { ...f.manifest, sources: [{ ...source, snapshotId: "hidden-cloud-copy" }] },
    { ...f.manifest, sources: [{ ...source, sha256: "0".repeat(64) }] },
    { ...f.manifest, files: f.manifest.files.filter((file) => file.kind !== "source-snapshot") },
    { ...f.manifest, sources: [] },
    { ...f.manifest, knowledge: [{ ...f.manifest.knowledge[0], sourceVersions: { "ISSUE-1": "different-revision" } }] },
  ]) assert.equal(artifactManifestSchema.safeParse(invalid).success, false);
});

test("references resolve only explicit matching bytes and version, without network or historical substitution", async (t) => {
  const f = await fixture(t, { retention: "references" });
  const artifacts = await readPublishedArtifacts({ projectDir: f.project, revision: f.revision });
  t.mock.method(globalThis, "fetch", () => { throw new Error("Original helper must remain offline"); });
  assert.equal(resolvePublishedOriginal(artifacts, "ISSUE-1").status, "unavailable");
  const version = f.manifest.sources[0].upstreamVersion;
  for (const supplied of [{ content: "changed", upstreamVersion: version }, { content: "original retained separately", upstreamVersion: "changed-version" }, { content: "original retained separately" }]) {
    const result = resolvePublishedOriginal(artifacts, "ISSUE-1", supplied);
    assert.equal(result.status, "changed");
    assert.equal(result.content, undefined);
  }
  assert.equal(resolvePublishedOriginal(artifacts, "ISSUE-1", { content: "original retained separately", upstreamVersion: version }).content, "original retained separately");
  assert.equal(artifactManifestSchema.safeParse({ ...f.manifest, sources: [{ ...f.manifest.sources[0], path: "hidden.txt" }] }).success, false);
});

test("wrong commit and changed declared fixture stop before the operator fixture runs", async (t) => {
  const f = await fixture(t, { mixed: true });
  const config = { project: f.project, fixture: [process.execPath, "fixtures/reset.mjs", f.marker] };
  const wrong = { ...f.revision, commitSha: "1".repeat(40) };
  const job = { ...f.job, run: { id: "wrong", publishedRevision: wrong }, plan: { publishedRevision: wrong }, publishedRevision: wrong };
  await assert.rejects(executeJob(config, job, async () => { throw new Error("No API before preflight"); }, AbortSignal.timeout(60_000)), /commit differs/);
  await assert.rejects(fs.access(f.marker), { code: "ENOENT" });
  await f.put("fixtures/baseline.json", "{}\n");
  await assert.rejects(executeJob(config, f.job, async () => ({}), AbortSignal.timeout(60_000)), /tracked modifications/);
  await assert.rejects(fs.access(f.marker), { code: "ENOENT" });
  const legacy = { ...f.job, run: { id: "legacy" }, plan: {}, publishedRevision: undefined };
  await assert.rejects(executeJob(config, legacy, async () => ({}), AbortSignal.timeout(60_000)), /Supporting file differs/);
  await assert.rejects(fs.access(f.marker), { code: "ENOENT" });
});

test("missing, symlink and hidden-index inputs cannot attest a published checkout", async (t) => {
  const f = await fixture(t, { mixed: true });
  await fs.rm(path.join(f.project, "fixtures/baseline.json"));
  await assert.rejects(readPublishedArtifacts({ projectDir: f.project, revision: f.revision }), /tracked modifications/);
  await fs.symlink("reset.mjs", path.join(f.project, "fixtures/baseline.json"));
  await assert.rejects(readPublishedArtifacts({ projectDir: f.project, revision: f.revision }), /tracked modifications|Symlink/);
  await f.git("update-index", "--assume-unchanged", "fixtures/baseline.json");
  await assert.rejects(readPublishedArtifacts({ projectDir: f.project, revision: f.revision }), /hidden.*index/);
});

test("offline originals do not consume the full published gap allowance during standalone import", async (t) => {
  const gaps = Array.from({ length: 100 }, (_, index) => `Case ${index + 1} requires an operator-defined baseline.`);
  for (const schemaVersion of [1, 2]) await t.test(`immutable schema ${schemaVersion}`, async (t) => {
    const f = await fixture(t, { mixed: true, schemaVersion, gaps });
    const artifacts = await readPublishedArtifacts({ projectDir: f.project, revision: f.revision });
    assert.equal(resolvePublishedOriginal(artifacts, "ISSUE-1").status, "unavailable");
    await exec(process.execPath, [cli, "plan", "--project", f.project, "--config", "config.json", "--repository", f.revision.repository, "--commit", f.revision.commitSha], { cwd: f.project, timeout: 60_000 });
    const plan = JSON.parse(await fs.readFile(path.join(f.project, "e2e/aratame/plan.json"), "utf8"));
    assert.deepEqual(plan.gaps, gaps);
    assert.deepEqual(plan.cases, f.manifest.cases);
    assert.deepEqual(plan.publishedRevision, f.revision);
    await assert.rejects(fs.access(f.marker), { code: "ENOENT" });
  });
});

test("mixed customer checkout imports exact cases through CLI, requires approval and runs portable fixtures without Cloud or models", async (t) => {
  const f = await fixture(t, { mixed: true });
  const invoke = (...args) => exec(process.execPath, [cli, ...args], { cwd: f.project, timeout: 60_000 });
  await invoke("plan", "--project", f.project, "--config", "config.json", "--repository", f.revision.repository, "--commit", f.revision.commitSha, "--knowledge", "inbox-guide", "--case", "inbox");
  const raw = await fs.readFile(path.join(f.project, "e2e/aratame/plan.json"), "utf8");
  const plan = JSON.parse(raw);
  assert.deepEqual(plan.publishedRevision, f.revision);
  assert.deepEqual(plan.cases, f.manifest.cases);
  const review = await invoke("review", "--project", f.project, "--plan", "e2e/aratame/plan.json");
  assert.ok(review.stdout.includes(digest(raw)));
  await assert.rejects(invoke("run", "--project", f.project, "--config", "config.json", "--plan", "e2e/aratame/plan.json"), /requires --approve/);
  await assert.rejects(fs.access(f.marker), { code: "ENOENT" });
  const run = await invoke("run", "--project", f.project, "--config", "config.json", "--plan", "e2e/aratame/plan.json", "--approve", digest(raw));
  const reportPath = /Local report: ([^\n]+)/.exec(run.stdout)[1];
  const report = JSON.parse(await fs.readFile(path.join(f.project, reportPath), "utf8"));
  assert.equal(report.status, "passed");
  assert.equal(report.results[0].testCount, 1);
  assert.deepEqual(report.publishedRevision, f.revision);
  assert.deepEqual(report.supportingFileRevisions, f.job.supportingFiles);
  assert.equal(report.localReceipt.cloudDeploymentIdentity, null);
  assert.equal(report.localReceipt.deploymentLabel, null);
});

test("fixture mutation during Playwright execution blocks certification of the original pin", async (t) => {
  const f = await fixture(t, { mixed: true, mutate: true });
  await assert.rejects(executeJob({ project: f.project, fixture: [process.execPath, "fixtures/reset.mjs", f.marker] }, f.job, async () => ({}), AbortSignal.timeout(60_000)), (error) => {
    assert.match(error.message, /tracked modifications/);
    assert.equal(error.partialReport.status, "blocked");
    assert.equal(error.partialReport.results[0].status, "blocked");
    assert.equal(error.partialReport.supportingFileRevisions, undefined);
    assert.deepEqual(error.partialReport.publishedRevision, f.revision);
    return true;
  });
});

test("reviewed supporting additions supplement a pin but cannot omit its fixtures", async (t) => {
  const f = await fixture(t, { mixed: true });
  const config = { project: f.project, fixture: [process.execPath, "fixtures/reset.mjs", f.marker] };
  await assert.rejects(executeJob(config, { ...f.job, supportingFiles: [] }, async () => ({}), AbortSignal.timeout(60_000)), /omit or replace/);
  await assert.rejects(fs.access(f.marker), { code: "ENOENT" });
  const content = '{"newReviewedBaseline":true}\n';
  await f.put("fixtures/proposed.json", content);
  const supportingFiles = [...f.job.supportingFiles, { path: "fixtures/proposed.json", sha256: digest(content) }];
  const report = await executeJob(config, { ...f.job, run: { ...f.job.run, id: "supplemented" }, supportingFiles }, async () => ({}), AbortSignal.timeout(60_000));
  assert.equal(report.status, "passed");
  assert.deepEqual(report.supportingFileRevisions, supportingFiles);
});

test("an assigned candidate executes only its exact checkout while preserving accepted planning lineage", async (t) => {
  const f = await fixture(t, { mixed: true });
  const candidateContent = "# Inbox\nProposed clarification, not accepted publication. [ISSUE-1]\n";
  const candidateManifest = {
    ...f.manifest,
    files: f.manifest.files.map((file) => file.kind === "knowledge" ? { ...file, sha256: digest(candidateContent) } : file),
  };
  await f.put("aratame/knowledge/pages/inbox.md", candidateContent);
  const raw = JSON.stringify(candidateManifest, null, 2) + "\n";
  await f.put(f.revision.manifestPath, raw);
  await f.git("add", "aratame/knowledge");
  await f.git("-c", "commit.gpgsign=false", "commit", "-qm", "Controlled unaccepted candidate");
  const candidateRevision = { ...f.revision, commitSha: await f.git("rev-parse", "HEAD"), manifestSha256: digest(raw) };
  const job = { ...f.job, run: { ...f.job.run, candidateRevision, id: "candidate" }, candidateRevision };
  const config = { project: f.project, fixture: [process.execPath, "fixtures/reset.mjs", f.marker] };
  await f.git("checkout", "--detach", f.revision.commitSha);
  await assert.rejects(executeJob(config, job, async () => ({}), AbortSignal.timeout(60_000)), (error) => {
    assert.match(error.message, /commit differs/);
    assert.deepEqual(error.partialReport.publishedRevision, f.revision);
    assert.deepEqual(error.partialReport.candidateRevision, candidateRevision);
    return true;
  });
  await assert.rejects(fs.access(f.marker), { code: "ENOENT" });
  await f.git("checkout", "--detach", candidateRevision.commitSha);
  const report = await executeJob(config, { ...job, run: { ...job.run, id: "candidate-verified" } }, async () => ({}), AbortSignal.timeout(60_000));
  assert.equal(report.status, "passed");
  assert.deepEqual(report.publishedRevision, f.revision);
  assert.deepEqual(report.candidateRevision, candidateRevision);
  assert.deepEqual(report.localReceipt.publishedRevision, f.revision);
  assert.deepEqual(report.localReceipt.candidateRevision, candidateRevision);
});

test("untracked and ignored module/config overlays fail before fixtures and cannot certify results", async (t) => {
  for (const [filename, ignored] of [["tests/support.js", false], ["playwright.config.ts", true]]) {
    const f = await fixture(t, { mixed: true });
    await f.put(filename, "throw new Error('unreviewed overlay executed');\n");
    if (ignored) await fs.appendFile(path.join(f.project, ".git/info/exclude"), `\n${filename}\n`);
    const config = { project: f.project, fixture: [process.execPath, "fixtures/reset.mjs", f.marker] };
    await assert.rejects(executeJob(config, f.job, async () => ({}), AbortSignal.timeout(60_000)), /Untracked or ignored input/);
    await assert.rejects(fs.access(f.marker), { code: "ENOENT" });
    await fs.rm(path.join(f.project, filename));
    let injected = false;
    await assert.rejects(executeJob(config, { ...f.job, run: { ...f.job.run, id: "late-overlay" } }, async () => {
      if (!injected) {
        injected = true;
        await f.put(filename, "// Late unreviewed module overlay\n");
      }
      return {};
    }, AbortSignal.timeout(60_000)), (error) => {
      assert.match(error.message, /Untracked or ignored input/);
      assert.equal(error.partialReport.status, "blocked");
      assert.ok(error.partialReport.results.every((result) => result.status === "blocked"));
      return true;
    });
  }
});

test("non-GitHub repository paths remain case-sensitive while GitHub names normalize", async (t) => {
  const f = await fixture(t);
  await f.git("remote", "set-url", "origin", "ssh://git@git.example.test/Team/QA.git");
  const revision = { ...f.revision, repository: "https://git.example.test/Team/QA.git" };
  assert.deepEqual((await readPublishedArtifacts({ projectDir: f.project, revision })).revision, revision);
  await assert.rejects(readPublishedArtifacts({ projectDir: f.project, revision: { ...revision, repository: "https://git.example.test/team/qa.git" } }), /repository differs/);
  await f.git("remote", "set-url", "origin", "https://github.com/CONTROLLED/CUSTOMER.git");
  assert.deepEqual((await readPublishedArtifacts({ projectDir: f.project, revision: f.revision })).revision, f.revision);
});

test("oversized published planning page is rejected before any model request", async (t) => {
  const f = await fixture(t);
  const content = "# Inbox\n" + "bounded planning evidence ".repeat(5000);
  const manifest = { ...f.manifest, files: f.manifest.files.map((file) => file.kind === "knowledge" ? { ...file, sha256: digest(content) } : file) };
  await f.put("aratame/knowledge/pages/inbox.md", content);
  const raw = JSON.stringify(manifest);
  await f.put(f.revision.manifestPath, raw);
  await f.put("requirements.txt", "Review the empty inbox requirement.");
  await f.put("config.json", JSON.stringify({ baseUrl: "http://127.0.0.1:3000", model: { provider: "openai", model: "controlled", apiKeyEnv: "ARATAME_PAGE_BUDGET_TEST_KEY" } }));
  await f.git("add", ".");
  await f.git("-c", "commit.gpgsign=false", "commit", "-qm", "Controlled oversized planning page");
  const previous = process.env.ARATAME_PAGE_BUDGET_TEST_KEY;
  process.env.ARATAME_PAGE_BUDGET_TEST_KEY = "controlled-not-a-secret";
  t.after(() => {
    if (previous === undefined) delete process.env.ARATAME_PAGE_BUDGET_TEST_KEY;
    else process.env.ARATAME_PAGE_BUDGET_TEST_KEY = previous;
  });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; throw new Error("A model must not be called"); });
  await assert.rejects(standalone("plan", { project: f.project, config: "config.json", requirements: "requirements.txt", repository: f.revision.repository, commit: await f.git("rev-parse", "HEAD") }), /100 KB per-page/);
  assert.equal(calls, 0);
  await assert.rejects(fs.access(path.join(f.project, "e2e/aratame/plan.json")), { code: "ENOENT" });
});

test("a selected untracked script deleting itself cannot certify its captured local revision", async (t) => {
  const f = await fixture(t);
  const specPath = "tests/ephemeral.spec.mjs";
  await f.put(specPath, `import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
test('ephemeral', async () => {
  await fs.unlink(new URL(import.meta.url));
  expect(1).toBe(1);
});\n`);
  const item = { id: "ephemeral", version: 1, title: "Captured local test", surface: "inbox", category: "functional", priority: "P1", preconditions: "An explicitly selected local script", steps: ["Check one"], expected: "One equals one", specPath };
  const job = { ...f.job, run: { ...f.job.run, id: "disappearing-input" }, cases: [item] };
  await assert.rejects(executeJob({ project: f.project }, job, async () => ({}), AbortSignal.timeout(60_000)), (error) => {
    assert.match(error.message, /Explicit local input missing or unsafe/);
    assert.equal(error.partialReport.status, "blocked");
    assert.equal(error.partialReport.results[0].status, "blocked");
    return true;
  });
  await assert.rejects(fs.access(path.join(f.project, specPath)), { code: "ENOENT" });
});
