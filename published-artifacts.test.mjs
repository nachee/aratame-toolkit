import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { artifactManifestSchema, assembleKnowledgeContext, readPublishedArtifacts, resolvePublishedOriginal, validateArtifactWikiContent } from "./published-artifacts.mjs";
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

async function wikiFixture(t, { mutate = () => {}, mixed = true } = {}) {
  const f = await fixture(t, { mixed });
  const legacyRevision = f.revision;
  const rows = [
    ["inbox-overview", "inbox", "overview", ["inbox::send", "inbox::read"], "inbox.md"],
    ["inbox-send", "inbox", "capability", ["general::policy", "archive::export"], "send.md"],
    ["inbox-read", "inbox", "capability", [], "read.md"],
    ["general-overview", "general", "overview", ["general::policy"], "general.md"],
    ["general-policy", "general", "shared", ["inbox::send"], "policy.md"],
    ["archive-overview", "archive", "overview", ["archive::export"], "archive.md"],
    ["archive-export", "archive", "capability", [], "export.md"],
  ];
  const knowledge = rows.map(([id, surface, role, links, filename]) => ({
    ...f.manifest.knowledge[0], id, title: id, surface, path: `aratame/knowledge/pages/${filename}`,
    wiki: { publicationId: `publication-${surface}`, pageKey: `${surface}::${role === "overview" ? "overview" : id.slice(surface.length + 1)}`, role, links },
    history: [],
  }));
  const contents = {};
  for (const page of knowledge) {
    contents[page.path] = `# ${page.title}\n${page.id === "general-policy" ? "Exports require an explicit consent decision; missing approval is unknown." : "Documented workflow."} [ISSUE-1]\n` +
      page.wiki.links.map((key) => `[${key}](${path.posix.basename(knowledge.find((entry) => entry.wiki.pageKey === key).path)})`).join("\n") + "\n";
  }
  const historyPath = "aratame/knowledge/history/inbox-v2.md";
  contents[historyPath] = "# Inbox\nEmpty accounts show No messages. [ISSUE-1]\n";
  knowledge[0].history = [{ id: "inbox-guide", path: historyPath, updatedAt: "2026-09-11T00:00:00Z" }];
  const indexPath = "aratame/knowledge/INDEX.md";
  contents[indexPath] = "# Knowledge index\n" + knowledge.map((page) => `[${page.title}](pages/${path.posix.basename(page.path)})`).join("\n") + "\n";
  const manifest = {
    ...f.manifest, schemaVersion: 3, knowledge,
    publications: ["inbox", "general", "archive"].map((surface) => ({ id: `publication-${surface}`, surface, overviewId: `${surface}-overview`, pageIds: knowledge.filter((page) => page.surface === surface).map((page) => page.id) })),
    conventions: { version: 1, path: "aratame/knowledge/CONVENTIONS.md" }, indexPath,
  };
  mutate(manifest, contents);
  manifest.files = [...manifest.files.filter((file) => file.kind !== "knowledge"), ...Object.entries(contents).map(([filename, content]) => ({
    path: filename, sha256: digest(content), origin: "generated", kind: filename === indexPath ? "conventions" : "knowledge",
  }))];
  for (const [filename, content] of Object.entries(contents)) await f.put(filename, content);
  const raw = JSON.stringify(manifest, null, 2) + "\n";
  await f.put(f.revision.manifestPath, raw);
  await f.git("add", "aratame");
  await f.git("-c", "commit.gpgsign=false", "commit", "-qm", "Controlled coherent wiki");
  const revision = { ...f.revision, commitSha: await f.git("rev-parse", "HEAD"), manifestSha256: digest(raw) };
  return { ...f, manifest, revision, legacyRevision };
}

test("v3 narrow context retains overview, shared and cross-surface constraints without unrelated siblings", async (t) => {
  const f = await wikiFixture(t);
  const artifacts = await readPublishedArtifacts({ projectDir: f.project, revision: f.revision });
  const context = assembleKnowledgeContext(artifacts.knowledge, { knowledgeIds: ["inbox-send"], maxStageBytes: 400 });
  assert.deepEqual(context.knowledge.map((page) => page.id), ["inbox-overview", "general-overview", "archive-overview", "inbox-send", "general-policy", "archive-export"]);
  assert.deepEqual(context.omitted.map((page) => page.id), ["inbox-read"]);
  assert.match(context.knowledge.find((page) => page.id === "general-policy").content, /missing approval is unknown/);
  assert.deepEqual(context.stages.flatMap((stage) => stage.pageIds), context.knowledge.map((page) => page.id));
  for (const stage of context.stages) {
    assert.equal(stage.bytes, context.knowledge.filter((page) => stage.pageIds.includes(page.id)).reduce((total, page) => total + Buffer.byteLength(page.content), 0));
    assert.ok(stage.bytes <= 400);
  }
  assert.deepEqual(assembleKnowledgeContext(artifacts.knowledge, { surface: "inbox" }).omitted, []);
  assert.deepEqual(assembleKnowledgeContext(artifacts.knowledge).omitted, []);
  assert.throws(() => assembleKnowledgeContext(artifacts.knowledge, { knowledgeIds: ["missing"] }), /selection/);
  assert.throws(() => assembleKnowledgeContext(artifacts.knowledge, { maxStageBytes: 1 }), /whole-page stage budget/);
  assert.equal(resolvePublishedOriginal(artifacts, "ISSUE-1").status, "unavailable");
});

test("v3 rejects incomplete publications, unbound original revisions and broken navigation", async (t) => {
  const scenarios = [
    ["missing member", (manifest) => { manifest.publications[0].pageIds.pop(); }, /membership/],
    ["missing map entry", (manifest) => { manifest.knowledge[0].wiki.links.pop(); }, /map entry/],
    ["wrong original revision", (manifest) => { manifest.knowledge[1].sourceVersions["ISSUE-1"] = "different"; }, /Original revision/],
    ["broken dependency link", (_, contents) => { contents["aratame/knowledge/pages/send.md"] = "# Send\n[Policy](missing.md) [ISSUE-1]\n"; }, /Broken wiki link/],
    ["missing index entry", (manifest, contents) => { contents[manifest.indexPath] = "# Index\n[Inbox](pages/inbox.md)\n"; }, /index omits/],
    ["undeclared dependency", (_, contents) => { contents["aratame/knowledge/pages/read.md"] += "[Export](export.md)\n"; }, /Undeclared wiki dependency/],
    ["unknown inline original", (_, contents) => { contents["aratame/knowledge/pages/read.md"] += "[NOT-SUPPLIED]\n"; }, /Unknown original citation/],
    ["bad anchor", (_, contents) => { contents["aratame/knowledge/pages/read.md"] += "[Heading](#absent)\n"; }, /Broken wiki anchor/],
    ["unsafe encoded link", (_, contents) => { contents["aratame/knowledge/pages/read.md"] += "[Unsafe](%2Fetc%2Fpasswd)\n"; }, /Unsafe wiki link/],
    ["unresolved reference", (_, contents) => { contents["aratame/knowledge/pages/read.md"] += "[Missing][no-target]\n"; }, /Unresolved Markdown reference/],
    ["malformed link", (_, contents) => { contents["aratame/knowledge/pages/read.md"] += "[Missing](read.md\n"; }, /Malformed Markdown link/],
    ["reference first target stays authoritative", (_, contents) => { contents["aratame/knowledge/pages/send.md"] = "# Send\n[Policy][p] and [Export](export.md). [ISSUE-1]\n\n[p]: missing.md\n[P]: policy.md\n"; }, /Broken wiki link/],
  ];
  for (const [name, mutate, expected] of scenarios) await t.test(name, async (t) => {
    const f = await wikiFixture(t, { mutate });
    await assert.rejects(readPublishedArtifacts({ projectDir: f.project, revision: f.revision }), expected);
  });
});

test("v3 supports portable reference navigation and keeps v2 history readable at its original pin", async (t) => {
  const f = await wikiFixture(t, { mutate: (_, contents) => {
    contents["aratame/knowledge/pages/send.md"] = "# Send\n[Policy][policy] and [Export](export.md#archive-export). [ISSUE-1]\n\n[policy]: policy.md\n[POLICY]: missing.md\n";
  } });
  const current = await readPublishedArtifacts({ projectDir: f.project, revision: f.revision });
  assert.equal(current.knowledge[0].history[0].id, "inbox-guide");
  assert.equal(current.files.find((file) => file.path.endsWith("history/inbox-v2.md")).content, "# Inbox\nEmpty accounts show No messages. [ISSUE-1]\n");
  await f.git("checkout", "--detach", f.legacyRevision.commitSha);
  const previous = await readPublishedArtifacts({ projectDir: f.project, revision: f.legacyRevision });
  assert.equal(previous.manifest.schemaVersion, 2);
  assert.deepEqual(previous.knowledge.map((page) => page.id), ["inbox-guide"]);
  assert.equal(previous.knowledge[0].wiki, undefined);
  assert.deepEqual(previous.knowledge[0].citations, ["ISSUE-1"]);
});

test("v3 CLI imports dependency closure and binds its review receipt without granting execution approval", async (t) => {
  const f = await wikiFixture(t);
  const invoke = (...args) => exec(process.execPath, [cli, ...args], { cwd: f.project, timeout: 60_000 });
  await invoke("plan", "--project", f.project, "--config", "config.json", "--repository", f.revision.repository, "--commit", f.revision.commitSha, "--knowledge", "inbox-send", "--case", "inbox");
  const raw = await fs.readFile(path.join(f.project, "e2e/aratame/plan.json"), "utf8");
  const plan = JSON.parse(raw);
  assert.deepEqual(plan.contextSelection.omitted.map((page) => page.id), ["inbox-read"]);
  assert.ok(plan.sources.some((source) => source.path.endsWith("/policy.md")));
  assert.ok(plan.sources.some((source) => source.path.endsWith("/export.md")));
  assert.deepEqual(plan.cases, f.manifest.cases);
  assert.deepEqual(plan.publishedRevision, f.revision);
  const review = await invoke("review", "--project", f.project, "--plan", "e2e/aratame/plan.json", "--knowledge", "inbox-send", "--surface", "inbox");
  assert.ok(review.stdout.includes(digest(raw)));
  await assert.rejects(invoke("run", "--project", f.project, "--config", "config.json", "--plan", "e2e/aratame/plan.json", "--knowledge", "inbox-send", "--surface", "inbox"), /requires --approve/);
  await assert.rejects(fs.access(f.marker), { code: "ENOENT" });
  const policyId = "general-policy";
  const artifacts = await readPublishedArtifacts({ projectDir: f.project, revision: f.revision, localFiles: [{ path: "e2e/aratame/plan.json", sha256: digest(raw) }] });
  const policy = artifacts.knowledge.find((page) => page.id === policyId);
  const stage = plan.contextSelection.stages.find((stage) => stage.pageIds.includes(policyId));
  stage.pageIds = stage.pageIds.filter((id) => id !== policyId);
  stage.bytes -= Buffer.byteLength(policy.content);
  plan.contextSelection.omitted.push({ id: policyId, reason: "Manually omitted" });
  plan.sources = plan.sources.filter((source) => source.path !== policy.path);
  await f.put("e2e/aratame/plan.json", JSON.stringify(plan));
  await assert.rejects(invoke("review", "--project", f.project, "--plan", "e2e/aratame/plan.json"), /required dependency/);
});

test("staged standalone reading preserves a shared constraint finding even when later model output drops it", async (t) => {
  const f = await wikiFixture(t, { mixed: false, mutate: (_, contents) => {
    for (const filename of Object.keys(contents)) if (filename.includes("/pages/")) contents[filename] += "Documented context. ".repeat(2800);
  } });
  const key = "ARATAME_WIKI_STAGE_TEST_KEY";
  const previous = process.env[key];
  process.env[key] = "controlled-wiki-stage-key";
  t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  await f.put("config.json", JSON.stringify({ baseUrl: "http://127.0.0.1:3000", model: { provider: "openai", model: "controlled", apiKeyEnv: key } }));
  await f.put("requirements.txt", "Plan inbox sending and its consent/export interactions.");
  await f.git("add", "config.json", "requirements.txt");
  await f.git("-c", "commit.gpgsign=false", "commit", "-qm", "Controlled staged planning inputs");
  const finding = "Export consent: missing explicit approval remains unknown.";
  const seen = new Map();
  t.mock.method(globalThis, "fetch", async (_, options) => {
    const request = JSON.parse(options.body);
    const input = JSON.parse(request.messages.find((message) => message.role === "user").content);
    for (const page of input.evidence) if (page.id) seen.set(page.id, page.content);
    const behavior = { title: "Review export consent", surface: "inbox", category: "functional", priority: "P1", preconditions: "An operator-supplied consent decision.", steps: ["Send an export request"], expected: "The documented consent requirement governs export." };
    const response = input.draft && !input.critique
      ? { critique: "Controlled review of this stage.", gaps: [] }
      : { title: "Staged inbox plan", cases: [behavior], gaps: !input.draft && input.evidence.some((page) => page.id === "general-policy") ? [finding] : [], rationale: "Controlled staged coverage." };
    return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(response) } }] }), { headers: { "content-type": "application/json" } });
  });
  t.mock.method(console, "log", () => {});
  await standalone("plan", { project: f.project, config: "config.json", requirements: "requirements.txt", repository: f.revision.repository, commit: await f.git("rev-parse", "HEAD"), knowledge: ["inbox-send"] });
  const plan = JSON.parse(await fs.readFile(path.join(f.project, "e2e/aratame/plan.json"), "utf8"));
  assert.deepEqual(plan.gaps, [finding]);
  assert.deepEqual([...seen.keys()], plan.contextSelection.stages.flatMap((stage) => stage.pageIds));
  assert.deepEqual(plan.contextSelection.omitted.map((page) => page.id), ["inbox-read"]);
  assert.match(seen.get("general-policy"), /missing approval is unknown/);
  for (const [id, content] of seen) assert.equal(content, await fs.readFile(path.join(f.project, f.manifest.knowledge.find((page) => page.id === id).path), "utf8"));
  assert.ok(plan.contextSelection.stages.length > 1);
});

test("pre-review wiki validation rejects unpinned navigation without changing immutable legacy readers", async (t) => {
  const f = await wikiFixture(t);
  const artifacts = await readPublishedArtifacts({ projectDir: f.project, revision: f.revision });
  const files = artifacts.files.map((file) => file.path.endsWith("/read.md") ? { ...file, content: "# Read\n[Unreviewed](unreviewed.md)\n" } : file);
  files.push({ path: "aratame/knowledge/pages/unreviewed.md", content: "# Unreviewed\n" });
  assert.throws(() => validateArtifactWikiContent(artifacts.manifest, files), /Broken wiki link/);
  for (const schemaVersion of [1, 2]) await t.test(`historic v${schemaVersion}`, async (t) => {
    const previous = await fixture(t, { schemaVersion });
    const filename = previous.manifest.knowledge[0].path;
    const content = "# Historical guide\n[Old navigation](no-longer-available.md)\n";
    previous.manifest.files.find((file) => file.path === filename).sha256 = digest(content);
    await previous.put(filename, content);
    const raw = JSON.stringify(previous.manifest);
    await previous.put(previous.revision.manifestPath, raw);
    await previous.git("add", "aratame");
    await previous.git("-c", "commit.gpgsign=false", "commit", "-qm", "Controlled legacy navigation");
    const revision = { ...previous.revision, commitSha: await previous.git("rev-parse", "HEAD"), manifestSha256: digest(raw) };
    const read = await readPublishedArtifacts({ projectDir: previous.project, revision });
    assert.equal(read.knowledge[0].content, content);
    assert.equal(read.manifest.schemaVersion, schemaVersion);
  });
});

test("v3 candidate execution preserves v2 accepted lineage and rejects a different checkout before fixtures", async (t) => {
  const f = await wikiFixture(t);
  const job = { ...f.job, candidateRevision: f.revision, run: { ...f.job.run, id: "wiki-candidate", candidateRevision: f.revision } };
  const config = { project: f.project, fixture: [process.execPath, "fixtures/reset.mjs", f.marker] };
  await f.git("checkout", "--detach", f.legacyRevision.commitSha);
  await assert.rejects(executeJob(config, job, async () => ({}), AbortSignal.timeout(60_000)), /commit differs/);
  await assert.rejects(fs.access(f.marker), { code: "ENOENT" });
  await f.git("checkout", "--detach", f.revision.commitSha);
  const report = await executeJob(config, job, async () => ({}), AbortSignal.timeout(60_000));
  assert.equal(report.status, "passed");
  assert.deepEqual(report.publishedRevision, f.legacyRevision);
  assert.deepEqual(report.candidateRevision, f.revision);
  assert.deepEqual(report.localReceipt.publishedRevision, f.legacyRevision);
  assert.deepEqual(report.localReceipt.candidateRevision, f.revision);
});

test("implicit overviews retain cross-surface dependencies while excluding their unrelated capability map", () => {
  const pages = [
    { id: "overview", surface: "billing", content: "Billing map", wiki: { publicationId: "billing", pageKey: "billing::overview", role: "overview", links: ["billing::pay", "billing::history", "general::consent"] } },
    { id: "pay", surface: "billing", content: "Pay", wiki: { publicationId: "billing", pageKey: "billing::pay", role: "capability", links: [] } },
    { id: "history", surface: "billing", content: "History", wiki: { publicationId: "billing", pageKey: "billing::history", role: "capability", links: [] } },
    { id: "consent", surface: "general", content: "Explicit consent required.", wiki: { publicationId: "authored-consent", pageKey: "general::consent", role: "shared", links: [] } },
  ];
  const context = assembleKnowledgeContext(pages, { knowledgeIds: ["pay"] });
  assert.deepEqual(context.knowledge.map((page) => page.id), ["overview", "pay", "consent"]);
  assert.deepEqual(context.omitted.map((page) => page.id), ["history"]);
  assert.throws(() => assembleKnowledgeContext([{ id: "utf8", surface: "general", content: "é" }], { maxStageBytes: 1 }), /whole-page stage budget/);
});

test("wiki links to authored constraints require representable dependency metadata", async (t) => {
  const f = await wikiFixture(t);
  const artifacts = await readPublishedArtifacts({ projectDir: f.project, revision: f.revision });
  const manifest = structuredClone(artifacts.manifest);
  const authored = { ...manifest.knowledge[2], id: "authored-policy", title: "Authored policy", surface: "billing", path: "aratame/knowledge/pages/authored-policy.md", origin: "authored" };
  delete authored.wiki;
  manifest.knowledge.push(authored);
  const content = "# Authored policy\nConsent remains operator-owned. [ISSUE-1]\n";
  const file = { path: authored.path, kind: "knowledge", origin: "authored", sha256: digest(content) };
  manifest.files.push(file);
  const files = [...artifacts.files.map((file) => {
    if (file.path === manifest.indexPath) return { ...file, content: file.content + "[Authored policy](pages/authored-policy.md)\n" };
    if (file.path.endsWith("/read.md")) return { ...file, content: file.content + "[Authored policy](authored-policy.md)\n" };
    return file;
  }), { ...file, content }];
  assert.throws(() => validateArtifactWikiContent(manifest, files), /lacks dependency metadata/);
  authored.wiki = { publicationId: "authored-policy", pageKey: "authored::policy", role: "shared", links: [] };
  manifest.knowledge.find((page) => page.id === "inbox-read").wiki.links.push(authored.wiki.pageKey);
  validateArtifactWikiContent(manifest, files);
  const context = assembleKnowledgeContext(manifest.knowledge.map((page) => ({ ...page, content: files.find((file) => file.path === page.path).content })), { knowledgeIds: ["inbox-read"] });
  assert.ok(context.knowledge.some((page) => page.id === authored.id && page.content === content));
  assert.ok(!context.omitted.some((page) => page.id === authored.id));
});

test("withdrawn evidence is a sole overview notice, never a citation-bearing current publication", async (t) => {
  const f = await wikiFixture(t, { mixed: false, mutate: (manifest, contents) => {
    const overview = manifest.knowledge[0];
    overview.citations = [];
    overview.sourceVersions = {};
    overview.wiki = { ...overview.wiki, links: [], evidenceStatus: "withdrawn" };
    manifest.knowledge = [overview];
    manifest.publications = [{ ...manifest.publications[0], pageIds: [overview.id] }];
    contents[overview.path] = "# Inbox\nOriginal evidence was withdrawn. Prior publications remain historical; no current facts are asserted.\n";
  } });
  const artifacts = await readPublishedArtifacts({ projectDir: f.project, revision: f.revision });
  const overview = artifacts.knowledge[0];
  assert.equal(overview.wiki.evidenceStatus, "withdrawn");
  assert.deepEqual(overview.sourceVersions, {});
  assert.deepEqual(assembleKnowledgeContext(artifacts.knowledge, { surface: "inbox" }).knowledge.map((page) => page.id), [overview.id]);
  for (const mutate of [
    (manifest) => { manifest.knowledge[0].citations = ["ISSUE-1"]; },
    (manifest) => { manifest.knowledge[0].sourceVersions = { "ISSUE-1": manifest.sources[0].updatedAt }; },
    (manifest) => { manifest.knowledge[0].wiki.links = [manifest.knowledge[0].wiki.pageKey]; },
    (manifest) => { manifest.knowledge[0].wiki.role = "capability"; },
    (manifest) => { manifest.publications[0].pageIds.push(manifest.knowledge[0].id); },
    (manifest) => { manifest.knowledge[0].evidenceStatus = "withdrawn"; },
  ]) {
    const manifest = structuredClone(artifacts.manifest);
    mutate(manifest);
    assert.equal(artifactManifestSchema.safeParse(manifest).success, false);
  }
});

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
  await assert.rejects(standalone("plan", { project: f.project, config: "config.json", requirements: "requirements.txt", repository: f.revision.repository, commit: await f.git("rev-parse", "HEAD") }), /whole-page stage budget/);
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
