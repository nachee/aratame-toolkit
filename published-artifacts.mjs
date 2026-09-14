import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { z } from "zod";

const exec = promisify(execFile);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().min(1).max(2000);
const identity = z.string().min(1).max(200);
export const artifactPathSchema = z.string().min(1).max(500).refine(
  (value) => !path.isAbsolute(value) && !value.includes("\\") &&
    !/[\u0000-\u001f\u007f:]/.test(value) &&
    value.split("/").every((part) => part && part !== "." && part !== ".." && part.toLowerCase() !== ".git"),
  "Use an ordinary project-relative path without traversal",
);
const origin = z.enum(["generated", "authored"]);
const fileSchema = z.object({
  path: artifactPathSchema, sha256,
  kind: z.enum(["knowledge", "conventions", "provenance", "script", "fixture", "test-definition"]),
  origin,
}).strict();
const sourceFileSchema = fileSchema.extend({
  kind: z.enum(["knowledge", "conventions", "provenance", "script", "fixture", "test-definition", "source-snapshot"]),
});
const historySchema = z.object({ id: identity, path: artifactPathSchema, updatedAt: text }).strict();
const knowledgeSchema = z.object({
  id: identity, title: z.string().min(1).max(300), surface: z.string().min(1).max(120),
  path: artifactPathSchema, origin,
  citations: z.array(text).max(1000),
  sourceVersions: z.record(identity, text).refine((value) => Object.keys(value).length <= 1000),
  gaps: z.array(text).max(100), history: z.array(historySchema).max(200),
}).strict();
export const wikiPageMetadataSchema = z.object({
  publicationId: identity,
  pageKey: identity.refine((value) => !/[\u0000-\u001f\u007f/\\]/.test(value), "Unsafe wiki page key"),
  role: z.enum(["overview", "capability", "shared"]),
  links: z.array(identity).max(200).refine((links) => new Set(links).size === links.length, "Duplicate wiki dependency"),
  evidenceStatus: z.literal("withdrawn").optional(),
}).strict().refine((wiki) => wiki.evidenceStatus !== "withdrawn" || (wiki.role === "overview" && wiki.links.length === 0), "Withdrawn evidence requires an overview without dependencies");
const wikiKnowledgeSchema = knowledgeSchema.extend({ wiki: wikiPageMetadataSchema.optional() });
const publicationSchema = z.object({
  id: identity, surface: z.string().min(1).max(120), overviewId: identity,
  pageIds: z.array(identity).min(1).max(200),
}).strict();
const sourceSchema = z.object({
  id: identity, title: z.string().min(1).max(500), source: text,
  sourceUrl: z.string().url().max(2000).refine((value) => {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password;
  }).optional(),
  updatedAt: text, sha256, retention: z.literal("cloud"), snapshotId: identity,
}).strict();
const sourceMetadata = sourceSchema.omit({ retention: true, snapshotId: true }).extend({
  sourceIdentity: text.optional(), ingestedAt: text.optional(), upstreamVersion: text.optional(),
});
const portableSourceSchema = z.discriminatedUnion("retention", [
  sourceMetadata.extend({ retention: z.literal("cloud"), snapshotId: identity }).strict(),
  sourceMetadata.extend({ retention: z.literal("repository"), path: artifactPathSchema }).strict(),
  sourceMetadata.extend({
    retention: z.literal("references"), sourceIdentity: text, ingestedAt: text, upstreamVersion: text,
  }).strict(),
]);
const caseSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/),
  version: z.number().int().positive(), title: z.string().min(3).max(300),
  surface: z.string().min(1).max(120), category: z.enum(["smoke", "functional", "edge", "regression"]),
  priority: z.enum(["P0", "P1", "P2"]), preconditions: z.string().min(1).max(4000),
  steps: z.array(z.string().min(1).max(2000)).min(1).max(30), expected: z.string().min(3).max(4000),
  sourceIssues: z.array(text).max(1000), specPath: artifactPathSchema.optional(),
  specTag: z.string().min(1).max(200).refine((value) => !/[\u0000-\u001f\u007f]/.test(value)).optional(),
  sha256: sha256.optional(),
  history: z.array(z.object({ id: identity, version: z.number().int().positive() }).strict()).max(200).optional(),
}).strict();
const manifestShape = {
  kind: z.literal("aratame-artifacts"),
  knowledge: z.array(knowledgeSchema).max(200), cases: z.array(caseSchema).max(200),
};
export const artifactManifestSchema = z.discriminatedUnion("schemaVersion", [
  // Historical versions keep their original validation rules.
  z.object({ ...manifestShape, schemaVersion: z.literal(1), files: z.array(fileSchema).max(500), sources: z.array(sourceSchema).max(1000) }).strict(),
  z.object({ ...manifestShape, schemaVersion: z.literal(2), files: z.array(sourceFileSchema).max(500), sources: z.array(portableSourceSchema).max(1000) }).strict(),
  z.object({
    ...manifestShape, schemaVersion: z.literal(3),
    knowledge: z.array(wikiKnowledgeSchema).max(200),
    files: z.array(sourceFileSchema).max(500), sources: z.array(portableSourceSchema).max(1000),
    publications: z.array(publicationSchema).max(200),
    conventions: z.object({ version: z.literal(1), path: artifactPathSchema }).strict(),
    indexPath: artifactPathSchema,
  }).strict(),
]).superRefine((manifest, ctx) => {
  const issue = (message) => ctx.addIssue({ code: "custom", message });
  for (const [items, key] of [[manifest.files, "path"], [manifest.knowledge, "id"], [manifest.sources, "id"], [manifest.cases, "id"]]) {
    if (new Set(items.map((item) => item[key])).size !== items.length) issue(`Duplicate ${key}`);
  }
  const files = new Map(manifest.files.map((file) => [file.path, file]));
  for (const page of manifest.knowledge) {
    const file = files.get(page.path);
    if (file?.kind !== "knowledge" || file.origin !== page.origin) issue(`Knowledge file missing or ownership differs: ${page.path}`);
    for (const previous of page.history) {
      if (files.get(previous.path)?.kind !== "knowledge") issue(`History file missing: ${previous.path}`);
    }
    if (manifest.schemaVersion >= 2) {
      for (const id of page.citations) if (!Object.hasOwn(page.sourceVersions, id)) issue(`Citation lacks original revision: ${id}`);
      for (const [id, version] of Object.entries(page.sourceVersions)) {
        if (!manifest.sources.some((source) => source.id === id && source.updatedAt === version)) issue(`Original revision missing: ${id}`);
      }
    }
  }
  if (manifest.schemaVersion >= 2) {
    const snapshots = new Set();
    for (const source of manifest.sources) if (source.retention === "repository") {
      const file = files.get(source.path);
      if (file?.kind !== "source-snapshot" || file.sha256 !== source.sha256) issue(`Source snapshot file/hash missing or different: ${source.id}`);
      if (snapshots.has(source.path)) issue(`Source snapshot path is shared by different originals: ${source.path}`);
      snapshots.add(source.path);
    }
    for (const file of manifest.files) if (file.kind === "source-snapshot" && !snapshots.has(file.path)) issue(`Source snapshot lacks provenance: ${file.path}`);
  }
  if (manifest.schemaVersion === 3) {
    const pages = new Map(manifest.knowledge.map((page) => [page.id, page]));
    const keys = new Map();
    const paths = new Set();
    const memberships = new Set();
    const publicationIds = new Set();
    const surfaces = new Set();
    for (const page of manifest.knowledge) {
      if (paths.has(page.path)) issue(`Duplicate knowledge path: ${page.path}`);
      paths.add(page.path);
      if (page.origin === "generated" && !page.wiki) issue(`Generated page lacks wiki metadata: ${page.id}`);
      if (page.wiki) {
        if (keys.has(page.wiki.pageKey)) issue(`Duplicate wiki page key: ${page.wiki.pageKey}`);
        keys.set(page.wiki.pageKey, page);
        if (page.wiki.role === "overview" && page.wiki.pageKey !== `${page.surface}::overview`) issue(`Overview key differs from surface: ${page.id}`);
        if (page.origin === "generated" && (!page.wiki.pageKey.startsWith(`${page.surface}::`) || page.wiki.pageKey.length === page.surface.length + 2)) issue(`Generated page key differs from surface: ${page.id}`);
        if (page.origin === "authored" && page.wiki.role !== "shared") issue(`Authored wiki metadata must use shared role: ${page.id}`);
        if (page.wiki.evidenceStatus === "withdrawn" && (page.citations.length !== 0 || Object.keys(page.sourceVersions).length !== 0)) issue(`Withdrawn overview cannot cite current evidence: ${page.id}`);
      }
    }
    for (const publication of manifest.publications) {
      if (publicationIds.has(publication.id) || surfaces.has(publication.surface)) issue(`Duplicate publication identity or surface: ${publication.id}`);
      publicationIds.add(publication.id);
      surfaces.add(publication.surface);
      const overview = pages.get(publication.overviewId);
      if (!publication.pageIds.includes(publication.overviewId) || overview?.wiki?.role !== "overview") issue(`Publication overview missing: ${publication.id}`);
      if (overview?.wiki?.evidenceStatus === "withdrawn" && publication.pageIds.length !== 1) issue(`Withdrawn overview must be the sole publication member: ${publication.id}`);
      let overviews = 0;
      for (const id of publication.pageIds) {
        const page = pages.get(id);
        if (memberships.has(id)) issue(`Page belongs to multiple publication entries: ${id}`);
        memberships.add(id);
        if (!page || page.origin !== "generated" || page.surface !== publication.surface || page.wiki?.publicationId !== publication.id) {
          issue(`Publication page missing or mismatched: ${id}`);
          continue;
        }
        if (page.wiki.role === "overview") overviews++;
        else if (!overview?.wiki?.links.includes(page.wiki.pageKey)) issue(`Overview omits capability map entry: ${id}`);
        if (page.surface === "general" && page.wiki.role === "capability") issue(`General detail must be shared: ${id}`);
      }
      if (overviews !== 1) issue(`Publication requires exactly one overview: ${publication.id}`);
    }
    for (const page of manifest.knowledge) {
      if (page.origin === "generated" && !memberships.has(page.id)) issue(`Generated page lacks publication membership: ${page.id}`);
      for (const key of page.wiki?.links ?? []) if (!keys.has(key)) issue(`Wiki dependency missing: ${key}`);
    }
    if (files.get(manifest.conventions.path)?.kind !== "conventions") issue("Versioned conventions file missing");
    if (!["conventions", "provenance"].includes(files.get(manifest.indexPath)?.kind)) issue("Wiki index file missing");
    if (manifest.indexPath === manifest.conventions.path) issue("Index and conventions must be separate files");
  }
  for (const item of manifest.cases) {
    if (!item.specPath && (item.specTag || item.sha256)) issue(`Script metadata requires specPath: ${item.id}`);
    if (item.specPath) {
      const file = files.get(item.specPath);
      if (file?.kind !== "script" || !item.sha256 || file.sha256 !== item.sha256) issue(`Script file/hash missing or different: ${item.id}`);
      if (!/\.(spec|test)\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/.test(item.specPath)) issue(`Invalid spec path: ${item.id}`);
    }
  }
});

/** Pure structural selection. Implicit overviews orient a narrow scope without expanding their map. */
export function assembleKnowledgeContext(pages, options = {}) {
  const maxStageBytes = options.maxStageBytes ?? 100_000;
  if (!Number.isSafeInteger(maxStageBytes) || maxStageBytes < 1) throw new Error("maxStageBytes must be a positive safe integer");
  const byId = new Map();
  const byKey = new Map();
  const overviews = new Map();
  for (const page of pages) {
    if (byId.has(page.id)) throw new Error(`Duplicate knowledge ID: ${page.id}`);
    byId.set(page.id, page);
    if (page.wiki) {
      wikiPageMetadataSchema.parse(page.wiki);
      if (byKey.has(page.wiki.pageKey)) throw new Error(`Duplicate wiki page key: ${page.wiki.pageKey}`);
      byKey.set(page.wiki.pageKey, page);
      if (page.wiki.role === "overview") {
        if (overviews.has(page.surface)) throw new Error(`Duplicate surface overview: ${page.surface}`);
        overviews.set(page.surface, page);
      }
    }
  }
  if (options.surface !== undefined && !pages.some((page) => page.surface === options.surface)) throw new Error(`Unknown knowledge surface: ${options.surface}`);
  const ids = options.knowledgeIds;
  if (ids && (new Set(ids).size !== ids.length || ids.some((id) => !byId.has(id)))) throw new Error("Unknown or duplicate published knowledge selection");
  if (ids?.length && options.surface !== undefined && ids.some((id) => byId.get(id).surface !== options.surface)) throw new Error("Knowledge selection differs from requested surface");
  const roots = ids?.length ? ids.map((id) => byId.get(id)) : options.surface !== undefined ? pages.filter((page) => page.surface === options.surface) : pages;
  const selected = new Set();
  const traversed = new Set();
  const oriented = new Set();
  const orient = (page) => {
    if (!page.wiki) return;
    const overview = overviews.get(page.surface);
    if (!overview && page.wiki.role !== "shared") throw new Error(`Surface overview missing: ${page.surface}`);
    if (!overview || oriented.has(overview.id)) return;
    oriented.add(overview.id);
    selected.add(overview.id);
    for (const key of overview.wiki.links) {
      const target = byKey.get(key);
      if (!target) throw new Error(`Required wiki dependency missing: ${key}`);
      if (target.surface !== overview.surface) visit(target);
    }
  };
  const visit = (page) => {
    selected.add(page.id);
    orient(page);
    if (traversed.has(page.id)) return;
    traversed.add(page.id);
    for (const key of page.wiki?.links ?? []) {
      const target = byKey.get(key);
      if (!target) throw new Error(`Required wiki dependency missing: ${key}`);
      // A detail's backlink to its own map is orientation, not a request for every sibling.
      if (target.wiki.role === "overview" && target.surface === page.surface && page.wiki.role !== "overview") {
        selected.add(target.id);
      } else visit(target);
    }
  };
  if (roots.length) {
    const general = overviews.get("general");
    if (general) orient(general);
    for (const page of pages) if (page.surface === "general" && !page.wiki) visit(page);
  }
  for (const page of roots) visit(page);
  const knowledge = [...pages.filter((page) => selected.has(page.id) && page.wiki?.role === "overview"), ...pages.filter((page) => selected.has(page.id) && page.wiki?.role !== "overview")];
  const stages = [];
  for (const page of knowledge) {
    const bytes = Buffer.byteLength(page.content ?? "", "utf8");
    if (bytes > maxStageBytes) throw new Error(`Knowledge page ${page.id} exceeds the ${maxStageBytes} byte whole-page stage budget; reorganize the publication without dropping required constraints`);
    let stage = stages.at(-1);
    if (!stage || stage.bytes + bytes > maxStageBytes) {
      stage = { pageIds: [], bytes: 0 };
      stages.push(stage);
    }
    stage.pageIds.push(page.id);
    stage.bytes += bytes;
  }
  return { knowledge, stages, omitted: pages.filter((page) => !selected.has(page.id)).map((page) => ({ id: page.id, reason: "Outside selected surface and required dependency closure" })) };
}

// The portable wiki contract uses ordinary Markdown links, not HTML/plugin navigation.
function withoutFencedCode(content) {
  let fence;
  return content.split("\n").map((line) => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      return "";
    }
    if (marker) {
      fence = marker[1];
      return "";
    }
    return line;
  }).join("\n");
}
function markdownReferences(content, filename) {
  const prose = withoutFencedCode(content).replace(/(`+)[^\n]*?\1/g, "");
  if (/\[\[|<(?:a|img)\b/i.test(prose)) throw new Error(`Unsupported wiki navigation syntax: ${filename}`);
  const definitions = new Map();
  const normalize = (value) => value.trim().replace(/\s+/g, " ").toLowerCase();
  const destination = "(?:<([^<>\\n]*)>|([^\\s<>]+?))(?:\\s+[\"'][^\\n]*[\"'])?";
  const definition = new RegExp(`^ {0,3}\\[([^\\]\\n]+)\\]:\\s*${destination}\\s*$`, "gm");
  let body = prose.replace(definition, (_, label, angled, plain) => {
    const key = normalize(label);
    if (!definitions.has(key)) definitions.set(key, angled ?? plain);
    return "";
  });
  const links = [];
  body = body.replace(new RegExp(`!?\\[([^\\]\\n]*)\\]\\(\\s*${destination}\\s*\\)`, "g"), (_, label, angled, plain) => {
    links.push(angled ?? plain);
    return "";
  });
  body = body.replace(/!?\[([^\]\n]+)\]\[([^\]\n]*)\]/g, (_, label, reference) => {
    const target = definitions.get(normalize(reference || label));
    if (target === undefined) throw new Error(`Unresolved Markdown reference: ${filename}: ${reference || label}`);
    links.push(target);
    return "";
  });
  if (/\]\(/.test(body)) throw new Error(`Malformed Markdown link: ${filename}`);
  const citations = [];
  for (const match of body.matchAll(/(?<!\\)\[([^\]\n]+)\]/g)) {
    const target = definitions.get(normalize(match[1]));
    if (target !== undefined) links.push(target);
    else if (!/^[ xX]$/.test(match[1])) citations.push(match[1]);
  }
  return { links, citations };
}

function validateWikiContent(manifest, files) {
  if (manifest.schemaVersion !== 3) return;
  const byPath = new Map(files.map((file) => [file.path, file]));
  const declared = new Set(manifest.files.map((file) => file.path));
  if (byPath.size !== files.length) throw new Error("Duplicate supplied wiki content path");
  for (const filename of declared) if (typeof byPath.get(filename)?.content !== "string") throw new Error(`Wiki content file missing: ${filename}`);
  const pagesByPath = new Map(manifest.knowledge.map((page) => [page.path, page]));
  const pagesByKey = new Map(manifest.knowledge.filter((page) => page.wiki).map((page) => [page.wiki.pageKey, page]));
  const resolveLinks = (filename, links) => {
    const targets = new Set();
    for (const link of links) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(link)) {
        let url;
        try { url = new URL(link); } catch { throw new Error(`Malformed wiki URL: ${filename}: ${link}`); }
        if (!["https:", "http:", "mailto:"].includes(url.protocol) || url.username || url.password) throw new Error(`Unsafe wiki URL: ${filename}: ${link}`);
        continue;
      }
      let decoded;
      try { decoded = decodeURIComponent(link); } catch { throw new Error(`Malformed wiki link encoding: ${filename}: ${link}`); }
      if (decoded.startsWith("/") || decoded.includes("\\") || /[\u0000-\u001f\u007f?]/.test(decoded)) throw new Error(`Unsafe wiki link: ${filename}: ${link}`);
      const [relative, fragment, ...extra] = decoded.split("#");
      const target = relative ? path.posix.normalize(path.posix.join(path.posix.dirname(filename), relative)) : filename;
      if (extra.length || !artifactPathSchema.safeParse(target).success || !declared.has(target)) throw new Error(`Broken wiki link: ${filename}: ${link}`);
      if (fragment) {
        const slugs = new Set();
        const counts = new Map();
        for (const heading of withoutFencedCode(byPath.get(target).content).matchAll(/^ {0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm)) {
          const base = heading[1].toLowerCase().replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/<[^>]*>/g, "").replace(/[^\p{L}\p{N}_\-\s]/gu, "").replace(/\s/g, "-");
          const count = counts.get(base) ?? 0;
          counts.set(base, count + 1);
          slugs.add(count ? `${base}-${count}` : base);
        }
        if (!slugs.has(fragment)) throw new Error(`Broken wiki anchor: ${filename}: ${link}`);
      }
      targets.add(target);
    }
    return targets;
  };
  for (const page of manifest.knowledge) {
    const parsed = markdownReferences(byPath.get(page.path).content, page.path);
    const targets = resolveLinks(page.path, parsed.links);
    if (page.wiki) for (const citation of parsed.citations) if (!page.citations.includes(citation) || !Object.hasOwn(page.sourceVersions, citation)) throw new Error(`Unknown original citation: ${page.id}: ${citation}`);
    for (const key of page.wiki?.links ?? []) if (!targets.has(pagesByKey.get(key).path)) throw new Error(`Wiki dependency lacks Markdown navigation: ${page.id}: ${key}`);
    if (page.wiki) for (const target of targets) {
      const linked = pagesByPath.get(target);
      if (linked && !linked.wiki) throw new Error(`Linked knowledge lacks dependency metadata: ${page.id}: ${linked.id}`);
      if (linked?.wiki && linked.id !== page.id && !(linked.surface === page.surface && linked.wiki.role === "overview") && !page.wiki.links.includes(linked.wiki.pageKey)) throw new Error(`Undeclared wiki dependency: ${page.id}: ${linked.wiki.pageKey}`);
    }
  }
  const index = markdownReferences(byPath.get(manifest.indexPath).content, manifest.indexPath);
  const indexed = resolveLinks(manifest.indexPath, index.links);
  for (const page of manifest.knowledge) if (!indexed.has(page.path)) throw new Error(`Wiki index omits page: ${page.id}`);
  resolveLinks(manifest.conventions.path, markdownReferences(byPath.get(manifest.conventions.path).content, manifest.conventions.path).links);
}
/** Structural preview validation only; does not attest Git bytes, semantic support or publication approval. */
export function validateArtifactWikiContent(manifest, files) {
  validateWikiContent(artifactManifestSchema.parse(manifest), files);
}
export const artifactRevisionSchema = z.object({
  repository: z.string().min(3).max(2000).refine((value) => {
    try { repositoryIdentity(value); return true; } catch { return false; }
  }, "Use owner/repository or a credential-free Git remote URL"),
  commitSha: z.string().regex(/^[a-f0-9]{40}$/),
  manifestPath: artifactPathSchema,
  manifestSha256: sha256,
}).strict();

function repositoryIdentity(value) {
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) return `github.com/${value.replace(/\.git$/, "").toLowerCase()}`;
  const scp = /^git@([^/:\s]+):([^\s]+)$/.exec(value);
  const url = new URL(scp ? `ssh://git@${scp[1]}/${scp[2]}` : value.replace(/^git\+/, ""));
  if (!["https:", "ssh:"].includes(url.protocol) || url.password || url.search || url.hash || (url.username && !(url.protocol === "ssh:" && url.username === "git"))) throw new Error("Unsafe repository identity");
  if (!/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(url.pathname)) throw new Error("Repository must identify owner/name");
  const repositoryPath = url.pathname.slice(1).replace(/\.git$/, "");
  return `${url.host.toLowerCase()}/${url.hostname.toLowerCase() === "github.com" ? repositoryPath.toLowerCase() : repositoryPath}`;
}
async function git(project, args, encoding = "utf8") {
  const { stdout } = await exec("git", ["-c", "core.fsmonitor=false", "-C", project, ...args], {
    encoding, maxBuffer: 20_000_000, timeout: 30_000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1" },
  });
  return stdout;
}
async function ordinaryFile(project, relative, maxBytes) {
  let current = project;
  for (const part of artifactPathSchema.parse(relative).split("/")) {
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw new Error(`Symlink input forbidden: ${relative}`);
  }
  const stat = await fs.stat(current);
  if (!stat.isFile() || stat.size > maxBytes) throw new Error(`Input is not a bounded ordinary file: ${relative}`);
  const bytes = await fs.readFile(current);
  if (bytes.length > maxBytes) throw new Error(`Input exceeds file budget: ${relative}`);
  return bytes;
}
async function checkout(projectDir, revision, { localFiles = [], outputDirectories = [] } = {}) {
  const project = path.resolve(projectDir);
  if (await fs.realpath(project) !== project) throw new Error("Published project path must not contain symlinks");
  if (path.resolve((await git(project, ["rev-parse", "--show-toplevel"])).trim()) !== project) throw new Error("Published project must be the repository root");
  const remote = (await git(project, ["remote", "get-url", "origin"])).trim();
  if (repositoryIdentity(remote) !== repositoryIdentity(revision.repository)) throw new Error("Published repository differs from checkout origin");
  if ((await git(project, ["rev-parse", "HEAD"])).trim() !== revision.commitSha) throw new Error("Published commit differs from checkout HEAD; prepare the exact checkout explicitly");
  const flags = (await git(project, ["ls-files", "-v", "-z"])).split("\0");
  if (flags.some((entry) => entry && entry[0] !== "H")) throw new Error("Published checkout cannot use hidden, unmerged, or sparse index entries");
  const dirty = await git(project, ["status", "--porcelain=v1", "--untracked-files=no", "--ignore-submodules=none"]);
  if (dirty.trim()) throw new Error("Published checkout has tracked modifications");
  const allowed = z.array(z.object({ path: artifactPathSchema, sha256 }).strict()).max(1000).parse(localFiles);
  const directories = z.array(artifactPathSchema.refine((value) => /^e2e\/aratame\/\.artifacts\/[A-Za-z0-9_-]+$/.test(value), "Only an explicit per-run Toolkit artifact directory may be allowed")).max(1).parse(outputDirectories);
  const allowedByPath = new Map(allowed.map((file) => [file.path, file.sha256]));
  if (allowedByPath.size !== allowed.length) throw new Error("Duplicate local input allowance");
  for (const file of allowed) {
    let bytes;
    try {
      bytes = await ordinaryFile(project, file.path, 2_000_000);
    } catch (error) {
      throw new Error(`Explicit local input missing or unsafe: ${file.path}`, { cause: error });
    }
    if (hash(bytes) !== file.sha256) throw new Error(`Explicit local input changed: ${file.path}`);
  }
  // Omitting --exclude-standard deliberately includes ignored overlays too.
  const overlays = (await git(project, ["ls-files", "--others", "-z", "--", ".", ":(exclude)node_modules", ":(exclude)**/node_modules"])).split("\0").filter(Boolean);
  for (const relative of overlays) {
    if (directories.some((directory) => relative.startsWith(`${directory}/`))) continue;
    const expected = allowedByPath.get(relative);
    if (!expected) throw new Error(`Untracked or ignored input can shadow the published checkout: ${relative}`);
  }
  return project;
}
async function committedFile(project, revision, relative, maxBytes) {
  const bytes = await ordinaryFile(project, relative, maxBytes);
  const entry = (await git(project, ["ls-tree", "-z", revision.commitSha, "--", relative])).split("\0").filter(Boolean);
  if (entry.length !== 1 || !/^100(644|755) blob [a-f0-9]{40}\t/.test(entry[0]) || entry[0].slice(entry[0].indexOf("\t") + 1) !== relative) throw new Error(`Published input is missing or not a committed ordinary file: ${relative}`);
  const object = entry[0].split(" ")[2].split("\t")[0];
  const committed = await git(project, ["cat-file", "blob", object], "buffer");
  if (!bytes.equals(committed)) throw new Error(`Published file differs from commit: ${relative}`);
  return bytes;
}
const verifiedOriginals = new WeakMap();
export async function readPublishedArtifacts({ projectDir, revision: expected, localFiles = [], outputDirectories = [] }) {
  const revision = artifactRevisionSchema.parse(expected);
  const allowances = { localFiles, outputDirectories };
  const project = await checkout(projectDir, revision, allowances);
  const raw = await committedFile(project, revision, revision.manifestPath, 2_000_000);
  if (hash(raw) !== revision.manifestSha256) throw new Error("Published manifest hash differs from approved revision");
  const manifest = artifactManifestSchema.parse(JSON.parse(raw.toString("utf8")));
  if (manifest.files.some((file) => file.path === revision.manifestPath)) throw new Error("Manifest cannot list itself");
  if (outputDirectories.some((directory) => [revision.manifestPath, ...manifest.files.map((file) => file.path)].some((filename) => filename === directory || filename.startsWith(`${directory}/`))))
    throw new Error("Toolkit output directory overlaps a manifest-pinned path");
  let total = 0;
  const files = [];
  for (const entry of manifest.files) {
    const bytes = await committedFile(project, revision, entry.path, 1_000_000);
    total += bytes.length;
    if (total > 10_000_000) throw new Error("Published files exceed 10 MB budget");
    if (hash(bytes) !== entry.sha256) throw new Error(`Published file hash differs: ${entry.path}`);
    files.push({ ...entry, content: bytes.toString("utf8") });
  }
  validateWikiContent(manifest, files);
  await checkout(projectDir, revision, allowances);
  const byPath = new Map(files.map((entry) => [entry.path, entry.content]));
  const artifacts = { manifest, revision, knowledge: manifest.knowledge.map((entry) => ({ ...entry, content: byPath.get(entry.path) })), cases: manifest.cases, files };
  // Keep the verified authority separate from mutable consumer-facing objects.
  verifiedOriginals.set(artifacts, { sources: structuredClone(manifest.sources), files: new Map(files.filter((entry) => entry.kind === "source-snapshot").map((entry) => [entry.path, entry.content])) });
  return artifacts;
}
export async function verifyPublishedCheckout(options) {
  return await readPublishedArtifacts(options);
}
// Resolves only operator-specified local bytes. No fetch, branch switch, or credentials.
export async function resolvePublishedRevision({ projectDir, repository, commitSha, manifestPath = "aratame/knowledge/manifest.json", localFiles = [], outputDirectories = [] }) {
  const revision = artifactRevisionSchema.parse({ repository, commitSha, manifestPath, manifestSha256: "0".repeat(64) });
  const project = await checkout(projectDir, revision, { localFiles, outputDirectories });
  revision.manifestSha256 = hash(await committedFile(project, revision, manifestPath, 2_000_000));
  await readPublishedArtifacts({ projectDir, revision, localFiles, outputDirectories });
  return revision;
}

/** Resolve only verified repository bytes or an explicitly supplied original; never fetch. */
export function resolvePublishedOriginal(artifacts, sourceId, suppliedOriginal) {
  const verified = verifiedOriginals.get(artifacts);
  if (!verified) throw new Error("Original resolution requires artifacts from readPublishedArtifacts");
  const source = verified.sources.find((entry) => entry.id === sourceId);
  if (!source) throw new Error(`Unknown published original: ${sourceId}`);
  const result = { id: source.id, retention: source.retention, sha256: source.sha256, ...(source.sourceUrl ? { sourceUrl: source.sourceUrl } : {}), ...(source.upstreamVersion ? { upstreamVersion: source.upstreamVersion } : {}) };
  if (source.retention === "repository") {
    const content = verified.files.get(source.path);
    if (content === undefined || hash(content) !== source.sha256) return { ...result, status: "unavailable", detail: "The exact repository snapshot is unavailable." };
    return { ...result, status: "exact", content, detail: "Exact original from the verified pinned repository snapshot." };
  }
  if (suppliedOriginal !== undefined) {
    const supplied = z.object({ content: z.string().refine((value) => Buffer.byteLength(value) <= 1_000_000), upstreamVersion: text.optional() }).strict().parse(suppliedOriginal);
    if (hash(supplied.content) !== source.sha256 || (source.upstreamVersion && supplied.upstreamVersion !== source.upstreamVersion)) return { ...result, status: "changed", detail: "Supplied bytes or upstream version differ from the published original; no historical body is returned." };
    return { ...result, status: "exact", content: supplied.content, detail: "Explicitly supplied original matches the published hash and upstream version." };
  }
  return { ...result, status: "unavailable", detail: source.retention === "cloud" ? "Exact original requires protected Cloud access or an explicitly supplied verified export." : "Original requires continuing upstream access and an explicitly supplied matching version; a reference cannot reconstruct historical text." };
}
