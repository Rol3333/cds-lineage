import type { ErrorCode, NodeStatus, SourceKind } from "@cds-visualiser/shared";

export const KIND_LABEL: Record<SourceKind, string> = {
  cds: "CDS entity",
  table: "DB table",
  view: "DDIC view",
  structure: "DDIC structure",
  unknown: "Unknown",
};

export const RELATIONSHIP_KIND_LABEL: Record<string, string> = {
  primary: "Primary source",
  join: "Join",
  association: "Association",
  "set-operation": "Set operation",
};

export const JOIN_TYPE_LABEL: Record<string, string> = {
  inner: "Inner join",
  leftOuter: "Left outer join",
  rightOuter: "Right outer join",
  fullOuter: "Full outer join",
  cross: "Cross join",
};

export const ASSOCIATION_KIND_LABEL: Record<string, string> = {
  association: "Association",
  composition: "Composition",
};

export function joinTypeLabel(joinType: string | undefined): string {
  if (!joinType) return "Join";
  return JOIN_TYPE_LABEL[joinType] ?? joinType;
}

export function relationshipKindLabel(kind: string | undefined): string {
  if (!kind) return "Dependency";
  return RELATIONSHIP_KIND_LABEL[kind] ?? kind;
}

export const STATUS_LABEL: Record<NodeStatus, string> = {
  loaded: "Loaded",
  "not-expanded": "Not expanded",
  "read-error": "Read error",
  "parse-error": "Parse error",
  "empty-source": "Empty source",
  unknown: "Unknown",
};

export const ERROR_CODE_LABEL: Record<ErrorCode, string> = {
  "invalid-name": "Invalid name",
  "adt-connection": "ADT/connection failure",
  "object-not-found": "Object not found",
  "empty-source": "Empty source",
  "parse-failure": "Parse failure",
  "unknown-source": "Unknown source type",
  "max-depth": "Maximum depth reached",
  "max-objects": "Maximum object count reached",
  "cache-miss": "Not in local repository",
  ambiguous: "Ambiguous repository match",
  "unsupported-type": "Unsupported object type",
  "search-failed": "Repository search failed",
  "read-failed": "Typed read failed",
};

/** Whether a status should be styled as an error. */
export function isErrorStatus(status: NodeStatus): boolean {
  return status === "read-error" || status === "parse-error" || status === "empty-source";
}

/** Whether a status should be styled as a warning. */
export function isWarnStatus(status: NodeStatus): boolean {
  return status === "not-expanded";
}
