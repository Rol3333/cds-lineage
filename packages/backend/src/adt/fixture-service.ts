import type { SourceFormat } from "@cds-visualiser/shared";
import { decodeSource, decodeSourceText } from "./decode.js";
import type { ObjectProvider, ObjectReadResult } from "./types.js";

export interface FixtureObject {
  /** Original SAP-style name (preserved for display/metadata). */
  name?: string;
  /** DDL/XML payload. Empty when only the type is known. */
  source: string;
  /** Base ADT type, e.g. `DDLS`, `TABL`, `VIEW`. */
  objectType: string;
  /** ADT subtype, e.g. `DF`, `DT`, `DS`, `DV`. */
  objectSubtype?: string;
  sourceFormat: SourceFormat;
  packageName?: string;
  description?: string;
  metadataOnly?: boolean;
}

type FixtureKind = "cds" | "table" | "structure" | "view" | "unsupported";

function classify(type: string, subtype?: string): FixtureKind {
  const t = type.toUpperCase();
  const s = (subtype ?? "").toUpperCase();
  if (t === "DDLS") return "cds";
  if (t === "TABL") return s === "DS" ? "structure" : "table";
  if (t === "VIEW") return "view";
  return "unsupported";
}

/**
 * In-memory provider used by tests and by the optional, clearly-labelled
 * fixture/demo mode. Never talks to SAP or the filesystem repository.
 */
export class FixtureObjectProvider implements ObjectProvider {
  constructor(private readonly fixtures: Record<string, FixtureObject>) {}

  async resolve(name: string): Promise<ObjectReadResult> {
    const requested = name.trim();
    const canonical = requested.toUpperCase();
    const fixture = this.fixtures[canonical];

    if (!fixture) {
      return {
        resolution: "not-found",
        name: requested,
        canonicalName: canonical,
        message: `No fixture is available for ${requested}.`,
      };
    }

    const kind = classify(fixture.objectType, fixture.objectSubtype);
    if (kind === "unsupported") {
      return {
        resolution: "unsupported-type",
        name: requested,
        canonicalName: canonical,
        objectType: fixture.objectType,
        objectSubtype: fixture.objectSubtype,
        message: `Fixture ${requested} has unsupported type ${fixture.objectType}.`,
      };
    }

    const metadataOnly = fixture.metadataOnly ?? fixture.source.trim().length === 0;
    if (!metadataOnly && fixture.source.trim().length === 0) {
      return {
        resolution: "read-failed",
        name: requested,
        canonicalName: canonical,
        objectType: fixture.objectType,
        objectSubtype: fixture.objectSubtype,
        errorCode: "empty-source",
        message: `Fixture ${requested} has an empty source.`,
      };
    }

    return {
      resolution: "resolved",
      name: fixture.name ?? requested,
      canonicalName: canonical,
      objectType: fixture.objectType,
      objectSubtype: fixture.objectSubtype,
      source: fixture.source,
      sourceFormat: fixture.sourceFormat,
      metadataOnly,
      packageName: fixture.packageName,
      description: fixture.description,
      cacheHit: false,
    };
  }
}

function splitType(type: string): [string, string?] {
  const idx = type.indexOf("/");
  const base = (idx < 0 ? type : type.slice(0, idx)).trim().toUpperCase();
  const subtype = idx < 0 ? undefined : type.slice(idx + 1).trim().toUpperCase() || undefined;

  // Fixtures may specify only the base type (e.g. `TABL`). Use the same
  // canonical subtypes as the live resolver so the graph looks consistent.
  const defaultSubtype =
    base === "DDLS" ? "DF" : base === "TABL" ? "DT" : base === "VIEW" ? "DV" : undefined;
  return [base, subtype ?? defaultSubtype];
}

function inferFormat(type: string, subtype?: string): SourceFormat {
  const kind = classify(type, subtype);
  switch (kind) {
    case "cds":
      return "asddls";
    case "structure":
      return "structure";
    case "view":
      return "view-metadata";
    case "table":
    default:
      return "table";
  }
}

/**
 * Build a fixture provider from a name→source map plus an optional
 * name→ADT-type map (values may be `TABL`, `TABL/DT`, `TABL/DS`, `DDLS/DF`,
 * `VIEW/DV`, …). Type-only entries become metadata-only leaf objects.
 */
export function createFixtureProvider(
  sources: Record<string, string>,
  objectTypes: Record<string, string> = {},
  formats: Record<string, SourceFormat> = {},
): ObjectProvider {
  const fixtures: Record<string, FixtureObject> = {};

  for (const [rawName, rawSource] of Object.entries(sources)) {
    const name = rawName.trim();
    const key = name.toUpperCase();
    const [objectType, objectSubtype] = splitType(objectTypes[key] ?? "DDLS/DF");
    const sourceFormat = formats[key] ?? inferFormat(objectType, objectSubtype);
    fixtures[key] = {
      name,
      source: decodeSourceText(rawSource),
      objectType,
      objectSubtype,
      sourceFormat,
      metadataOnly: sourceFormat === "view-metadata",
    };
  }

  for (const [rawName, rawType] of Object.entries(objectTypes)) {
    const key = rawName.trim().toUpperCase();
    if (fixtures[key]) continue;
    const [objectType, objectSubtype] = splitType(rawType);
    const sourceFormat = formats[key] ?? inferFormat(objectType, objectSubtype);
    fixtures[key] = {
      name: rawName.trim(),
      source: "",
      objectType,
      objectSubtype,
      sourceFormat,
      metadataOnly: true,
    };
  }

  return new FixtureObjectProvider(fixtures);
}

/** Decode a raw byte buffer fixture into text (re-exported for tests). */
export function decodeFixture(buffer: Buffer): string {
  return decodeSource(buffer);
}
