import type {
  CacheMode,
  EdgeRelationship,
  ObjectAssociation,
  ObjectColumn,
  RepositoryCandidate,
  ResolutionStatus,
  SourceFormat,
} from "@cds-visualiser/shared";

/** Stable, non-secret identity of the SAP system being cached. */
export interface SystemIdentity {
  /** Safe directory key, e.g. `DS4-100`. */
  key: string;
  /** SAP system ID, when known. */
  sid?: string;
  /** SAP client, when known. */
  client?: string;
}

/** One object in the JSON lookup index. The index is only an optimisation. */
export interface RepositoryIndexEntry {
  canonicalName: string;
  name: string;
  objectType: string;
  objectSubtype?: string;
  packageName?: string;
  /** Paths are relative to the system directory and use `/` separators. */
  metadataPath: string;
  objectDir: string;
  sourceArtifact: string;
  sourceFormat: SourceFormat;
  sourceHash: string;
  /** Last successful retrieval from SAP (ISO timestamp). */
  updatedAt: string;
  /** Last time derived artifacts were regenerated (ISO timestamp). */
  derivedAt?: string;
  metadataOnly: boolean;
}

export interface RepositoryIndex {
  schemaVersion: 1;
  system: SystemIdentity;
  generatedAt: string;
  objects: RepositoryIndexEntry[];
}

/** Durable per-object metadata. This is the source of truth, not the index. */
export interface CachedObjectMetadata {
  schemaVersion: 1;
  system: SystemIdentity;
  object: {
    name: string;
    canonicalName: string;
    type: string;
    subtype?: string;
    packageName?: string;
    description?: string;
    uri?: string;
    metadataOnly: boolean;
  };
  source: {
    artifact: string;
    format: SourceFormat;
    encoding: "utf-8";
    sha256: string;
    bytes: number;
  };
  retrieval: {
    retrievedAt: string;
    source: string;
    cacheMode: CacheMode;
  };
  parser: {
    name: string;
    version: string;
    extractorVersion: string;
  };
  classification: {
    confidence: "confirmed" | "unknown";
    candidates: RepositoryCandidate[];
  };
  derived: {
    parsed: string;
    dependencies: string;
    generatedAt: string;
  };
}

/** Serializable, application-owned parser output (not a parser AST dump). */
export interface ParsedArtifact {
  schemaVersion: 1;
  object: { name: string; type: string };
  sourceHash: string;
  parser: { name: string; version: string; extractorVersion: string };
  definitionKinds: string[];
  sources: Array<{
    name: string;
    role: string;
    joinType?: string;
    alias?: string;
    relationship?: EdgeRelationship;
  }>;
  columns: ObjectColumn[];
  associations: ObjectAssociation[];
  parseErrors: Array<{ message: string; line: number; column: number }>;
  note?: string;
}

/** Direct structural dependencies with an explicit unknown/resolved marker. */
export interface DependenciesArtifact {
  schemaVersion: 1;
  sourceHash: string;
  extractorVersion: string;
  dependencies: Array<{
    name: string;
    canonicalName: string;
    role: string;
    joinType?: string;
    alias?: string;
    usedInProjection?: boolean;
    objectType?: string | null;
    resolution: ResolutionStatus | "unknown";
  }>;
}

export interface CachedObject {
  metadata: CachedObjectMetadata;
  source?: string;
  parsed?: ParsedArtifact;
  dependencies?: DependenciesArtifact;
  cacheHit: boolean;
  stale: boolean;
}

export interface SaveObjectInput {
  name: string;
  canonicalName: string;
  objectType: string;
  objectSubtype?: string;
  packageName?: string;
  description?: string;
  uri?: string;
  metadataOnly: boolean;
  source: string;
  /** Simple filename, e.g. `source.asddls` / `source.table`. */
  sourceArtifact: string;
  sourceFormat: SourceFormat;
  /** e.g. `adt-ddl-read`, `adt-table-read`, `adt-structure-read`, `adt-fetch-view-metadata`. */
  retrievalSource: string;
  cacheMode: CacheMode;
  candidates: RepositoryCandidate[];
  parsed?: ParsedArtifact;
  dependencies?: DependenciesArtifact;
}

export interface FindObjectsFilter {
  name?: string;
  objectType?: string;
  packageName?: string;
}

export interface PackageSummary {
  name: string;
  objectCount: number;
}
