import type { ErrorCode } from "@cds-visualiser/shared";

/**
 * ABAP repository object names are case-insensitive identifiers that may carry
 * a namespace prefix (`/NAMESPACE/NAME`). This validator is deliberately
 * strict: it rejects every shell metacharacter so the name is always safe to
 * pass as a process argument, and rejects empty input.
 *
 * It intentionally applies to CDS entities *and* DDIC tables/views/structures:
 * the resolver passes every requested dependency name through it before
 * invoking the CLI.
 */
const ABAP_OBJECT_NAME = /^[A-Za-z/][A-Za-z0-9_/]{0,39}$/;

export interface NameValidationResult {
  ok: boolean;
  error?: { errorCode: ErrorCode; message: string };
}

export function validateObjectName(raw: unknown): NameValidationResult {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (name.length === 0) {
    return { ok: false, error: { errorCode: "invalid-name", message: "Object name is empty." } };
  }
  if (!ABAP_OBJECT_NAME.test(name)) {
    return {
      ok: false,
      error: {
        errorCode: "invalid-name",
        message: `"${raw}" is not a valid SAP object name (letters, digits, "_", "/", up to 40 chars).`,
      },
    };
  }
  return { ok: true };
}

/** Backwards-compatible alias used by the original collector/tests. */
export const validateCdsName = validateObjectName;
