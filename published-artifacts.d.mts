import type { z } from "zod";
export interface ArtifactRevision {
  repository: string;
  commitSha: string;
  manifestPath: string;
  manifestSha256: string;
}
export interface ArtifactFile {
  path: string;
  sha256: string;
  kind: "knowledge" | "conventions" | "provenance" | "script" | "fixture" | "test-definition" | "source-snapshot";
  origin: "generated" | "authored";
}
export interface WikiPageMetadata {
  publicationId: string;
  pageKey: string;
  role: "overview" | "capability" | "shared";
  links: string[];
  /** Deterministic empty-evidence notice; only a sole overview without citations or dependencies. */
  evidenceStatus?: "withdrawn";
}
export interface ArtifactKnowledge {
  id: string;
  title: string;
  surface: string;
  path: string;
  origin: "generated" | "authored";
  citations: string[];
  sourceVersions: Record<string, string>;
  gaps: string[];
  history: Array<{ id: string; path: string; updatedAt: string }>;
  wiki?: WikiPageMetadata;
}
export interface ArtifactSourceMetadata {
  id: string;
  title: string;
  source: string;
  sourceUrl?: string;
  updatedAt: string;
  sha256: string;
  sourceIdentity?: string;
  ingestedAt?: string;
  upstreamVersion?: string;
}
export type ArtifactSource = ArtifactSourceMetadata & (
  | { retention: "cloud"; snapshotId: string }
  | { retention: "repository"; path: string }
  | { retention: "references"; sourceIdentity: string; ingestedAt: string; upstreamVersion: string }
);
export type LegacyArtifactSource = Omit<ArtifactSourceMetadata, "sourceIdentity" | "ingestedAt" | "upstreamVersion"> & { retention: "cloud"; snapshotId: string };
export interface ArtifactCase {
  id: string;
  version: number;
  title: string;
  surface: string;
  category: "smoke" | "functional" | "edge" | "regression";
  priority: "P0" | "P1" | "P2";
  preconditions: string;
  steps: string[];
  expected: string;
  sourceIssues: string[];
  specPath?: string;
  specTag?: string;
  sha256?: string;
  history?: Array<{ id: string; version: number }>;
}
export interface ArtifactManifestV2 {
  schemaVersion: 2;
  kind: "aratame-artifacts";
  files: ArtifactFile[];
  knowledge: Array<Omit<ArtifactKnowledge, "wiki">>;
  sources: ArtifactSource[];
  cases: ArtifactCase[];
}
export interface ArtifactManifestV1 extends Omit<ArtifactManifestV2, "schemaVersion" | "sources" | "files"> {
  schemaVersion: 1;
  sources: LegacyArtifactSource[];
  files: Array<Omit<ArtifactFile, "kind"> & { kind: Exclude<ArtifactFile["kind"], "source-snapshot"> }>;
}
export interface ArtifactManifestV3 extends Omit<ArtifactManifestV2, "schemaVersion" | "knowledge"> {
  schemaVersion: 3;
  knowledge: ArtifactKnowledge[];
  publications: Array<{ id: string; surface: string; overviewId: string; pageIds: string[] }>;
  conventions: { version: 1; path: string };
  indexPath: string;
}
export type ArtifactManifest = ArtifactManifestV1 | ArtifactManifestV2 | ArtifactManifestV3;
export interface PublishedArtifacts {
  manifest: ArtifactManifest;
  revision: ArtifactRevision;
  knowledge: Array<ArtifactKnowledge & { content: string }>;
  cases: ArtifactCase[];
  files: Array<ArtifactFile & { content: string }>;
}
export const artifactPathSchema: z.ZodType<string>;
export const artifactManifestSchema: z.ZodType<ArtifactManifest>;
export const artifactRevisionSchema: z.ZodType<ArtifactRevision>;
export const wikiPageMetadataSchema: z.ZodType<WikiPageMetadata>;
export interface KnowledgeContextPage {
  id: string;
  surface: string;
  wiki?: WikiPageMetadata;
  content?: string;
}
export interface KnowledgeContextOptions {
  surface?: string;
  knowledgeIds?: string[];
  maxStageBytes?: number;
}
export interface KnowledgeContextAssembly<T> {
  knowledge: T[];
  stages: Array<{ pageIds: string[]; bytes: number }>;
  omitted: Array<{ id: string; reason: string }>;
}
/** Structural dependency closure; does not prove semantic support or grant original/approval authority. */
export function assembleKnowledgeContext<T extends KnowledgeContextPage>(pages: T[], options?: KnowledgeContextOptions): KnowledgeContextAssembly<T>;
/** Validates manifest and v3 navigation/citations without reading files or granting Git/evidence authority. */
export function validateArtifactWikiContent(manifest: ArtifactManifest, files: Array<{ path: string; content: string }>): void;
export interface CheckoutAllowances {
  /** Exact operator-selected input bytes; never excludes tracked modifications. */
  localFiles?: Array<{ path: string; sha256: string }>;
  /** At most one exclusive current-run e2e/aratame/.artifacts/<run> directory. */
  outputDirectories?: string[];
}
export function readPublishedArtifacts(options: { projectDir: string; revision: ArtifactRevision } & CheckoutAllowances): Promise<PublishedArtifacts>;
export function verifyPublishedCheckout(options: { projectDir: string; revision: ArtifactRevision } & CheckoutAllowances): Promise<PublishedArtifacts>;
export function resolvePublishedRevision(options: { projectDir: string; repository: string; commitSha: string; manifestPath?: string } & CheckoutAllowances): Promise<ArtifactRevision>;
export interface PublishedOriginalResolution {
  id: string;
  status: "exact" | "changed" | "unavailable";
  retention: "cloud" | "repository" | "references";
  sha256: string;
  sourceUrl?: string;
  upstreamVersion?: string;
  content?: string;
  detail: string;
}
/** Requires the un-cloned result of readPublishedArtifacts; never performs network access. */
export function resolvePublishedOriginal(artifacts: PublishedArtifacts, sourceId: string, suppliedOriginal?: { content: string; upstreamVersion?: string }): PublishedOriginalResolution;
