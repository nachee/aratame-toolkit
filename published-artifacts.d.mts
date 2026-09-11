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
  knowledge: ArtifactKnowledge[];
  sources: ArtifactSource[];
  cases: ArtifactCase[];
}
export interface ArtifactManifestV1 extends Omit<ArtifactManifestV2, "schemaVersion" | "sources" | "files"> {
  schemaVersion: 1;
  sources: LegacyArtifactSource[];
  files: Array<Omit<ArtifactFile, "kind"> & { kind: Exclude<ArtifactFile["kind"], "source-snapshot"> }>;
}
export type ArtifactManifest = ArtifactManifestV1 | ArtifactManifestV2;
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
