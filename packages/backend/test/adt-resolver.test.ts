import { describe, expect, it, vi } from "vitest";
import { AdtObjectProvider, extractJsonArray } from "../src/adt/adt-resolver.js";
import type { ProcessAdapter, ProcessResult } from "../src/adt/types.js";

interface Call {
  command: string;
  args: string[];
}

function ok(stdout: string | Buffer, overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    exitCode: 0,
    stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout, "utf8"),
    stderr: "",
    timedOut: false,
    ...overrides,
  };
}

function fail(stderr: string, exitCode = 1): ProcessResult {
  return { exitCode, stdout: Buffer.alloc(0), stderr, timedOut: false };
}

function adapter(handler: (args: string[]) => ProcessResult | undefined): {
  process: ProcessAdapter;
  calls: Call[];
} {
  const calls: Call[] = [];
  const process: ProcessAdapter = {
    run: vi.fn(async (command, args) => {
      calls.push({ command, args });
      return (
        handler(args) ?? {
          exitCode: 1,
          stdout: Buffer.alloc(0),
          stderr: `unexpected invocation: ${args.join(" ")}`,
          timedOut: false,
        }
      );
    }),
  };
  return { process, calls };
}

function searchOutput(candidates: unknown[]): string {
  // Mirrors the real CLI: human banner + JSON + success footer, all on stdout.
  return `🔍 Searching for: "X" (max: 50 results)...\n\n${JSON.stringify(candidates, null, 2)}\n\n✅ Search complete!\n`;
}

const DDLS_SOURCE =
  "@AbapCatalog.sqlViewName: 'ZTEST'\ndefine view entity ZTEST as select from CDPOS { key mandt }";

const DDLS_CANDIDATES = [
  {
    uri: "/sap/bc/adt/acm/dcl/sources/ztest",
    type: "DCLS/DL",
    name: "ZTEST",
    packageName: "SZD",
    description: "Access control",
  },
  {
    uri: "/sap/bc/adt/ddic/ddl/sources/ztest",
    type: "DDLS/DF",
    name: "ZTEST",
    packageName: "SZD",
    description: "CDS entity",
  },
  {
    uri: "/sap/bc/adt/vit/wb/object_type/stobd/object_name/ZTEST",
    type: "STOB/DO",
    name: "ZTEST",
    packageName: "SZD",
    description: "Structure object",
  },
];

function provider(handler: (args: string[]) => ProcessResult | undefined) {
  const { process, calls } = adapter(handler);
  return { provider: new AdtObjectProvider(process), calls };
}

describe("AdtObjectProvider", () => {
  it("resolves a CDS entity via search and `ddl read` (never `get`)", async () => {
    const { provider: p, calls } = provider((args) => {
      const key = args.join(" ");
      if (key === "search --json ZTEST") return ok(searchOutput(DDLS_CANDIDATES));
      if (key === "ddl read ZTEST") return ok(DDLS_SOURCE);
      return undefined;
    });

    const result = await p.resolve("ZTEST");
    expect(result.resolution).toBe("resolved");
    expect(result.objectType).toBe("DDLS");
    expect(result.objectSubtype).toBe("DF");
    expect(result.packageName).toBe("SZD");
    expect(result.source).toContain("define view entity ZTEST");
    expect(result.sourceFormat).toBe("asddls");
    expect(calls.map((c) => c.args.join(" "))).toEqual([
      "search --json ZTEST",
      "ddl read ZTEST",
    ]);
    expect(calls.some((c) => c.args[0] === "get")).toBe(false);
  });

  it("preserves the repository spelling and uses canonical names for readers", async () => {
    const { provider: p, calls } = provider((args) => {
      const key = args.join(" ");
      if (key === "search --json ztest") return ok(searchOutput(DDLS_CANDIDATES));
      if (key === "ddl read ZTEST") return ok(DDLS_SOURCE);
      return undefined;
    });

    const result = await p.resolve("ztest");
    expect(result.resolution).toBe("resolved");
    expect(result.name).toBe("ZTEST");
    expect(result.canonicalName).toBe("ZTEST");
    expect(calls.map((c) => c.args.join(" "))).toEqual([
      "search --json ztest",
      "ddl read ZTEST",
    ]);
  });

  it("dispatches TABL/DT to `table read`", async () => {
    const { provider: p, calls } = provider((args) => {
      const key = args.join(" ");
      if (key === "search --json CDPOS") {
        return ok(
          searchOutput([
            {
              uri: "/sap/bc/adt/ddic/tables/cdpos",
              type: "TABL/DT",
              name: "CDPOS",
              packageName: "SZD",
              description: "Change document items",
            },
          ]),
        );
      }
      if (key === "table read CDPOS") return ok("define table cdpos { mandt : mandt; }");
      return undefined;
    });

    const result = await p.resolve("CDPOS");
    expect(result.resolution).toBe("resolved");
    expect(result.objectType).toBe("TABL");
    expect(result.objectSubtype).toBe("DT");
    expect(result.sourceFormat).toBe("table");
    expect(calls.map((c) => c.args.join(" "))).toEqual([
      "search --json CDPOS",
      "table read CDPOS",
    ]);
  });

  it("dispatches TABL/DS to `structure read` (not `table read`)", async () => {
    const { provider: p, calls } = provider((args) => {
      const key = args.join(" ");
      if (key === "search --json BAPIRET2") {
        return ok(
          searchOutput([
            {
              uri: "/sap/bc/adt/ddic/structures/bapiret2",
              type: "TABL/DS",
              name: "BAPIRET2",
              packageName: "SBF_BAPI",
              description: "Return Parameter",
            },
          ]),
        );
      }
      if (key === "structure read BAPIRET2") return ok("define structure bapiret2 { type : bapi_mtype; }");
      return undefined;
    });

    const result = await p.resolve("BAPIRET2");
    expect(result.resolution).toBe("resolved");
    expect(result.objectType).toBe("TABL");
    expect(result.objectSubtype).toBe("DS");
    expect(result.sourceFormat).toBe("structure");
    expect(calls.map((c) => c.args.join(" "))).toEqual([
      "search --json BAPIRET2",
      "structure read BAPIRET2",
    ]);
    expect(calls.some((c) => c.args.join(" ") === "table read BAPIRET2")).toBe(false);
  });

  it("captures VIEW/DV as metadata only via the VIT fetch URI", async () => {
    const candidate = {
      uri: "/sap/bc/adt/vit/wb/object_type/viewdv/object_name/V_T001",
      type: "VIEW/DV",
      name: "V_T001",
      packageName: "FBZ",
      description: "Company Code",
    };
    const { provider: p, calls } = provider((args) => {
      const key = args.join(" ");
      if (key === "search --json V_T001") {
        return ok(
          searchOutput([
            {
              uri: "/sap/bc/adt/vit/wb/object_type/trant/object_name/V_T001",
              type: "TRAN/T",
              name: "V_T001",
              packageName: "BCUC",
              description: "Company Code",
            },
            candidate,
          ]),
        );
      }
      if (key === `fetch ${candidate.uri}`) {
        return ok(
          `🔄 GET ${candidate.uri}...\n\n` +
            '<?xml version="1.0" encoding="utf-8"?><adtcore:mainObject adtcore:name="V_T001" adtcore:type="VIEW/DV" />\n\n' +
            "✅ Done!",
        );
      }
      return undefined;
    });

    const result = await p.resolve("V_T001");
    expect(result.resolution).toBe("resolved");
    expect(result.objectType).toBe("VIEW");
    expect(result.objectSubtype).toBe("DV");
    expect(result.sourceFormat).toBe("view-metadata");
    expect(result.metadataOnly).toBe(true);
    expect(result.source).toContain("VIEW/DV");
    expect(result.source?.startsWith("<?xml")).toBe(true);
    expect(result.source).not.toContain("Done!");
    expect(result.source).not.toContain("GET ");
    expect(calls.map((c) => c.args.join(" "))).toContain(`fetch ${candidate.uri}`);
    expect(calls.some((c) => c.args[0] === "view")).toBe(false);
  });

  it("treats a prefix-only search match as not found (exact names only)", async () => {
    const { provider: p, calls } = provider((args) => {
      if (args.join(" ") === "search --json I_CHANGEDOCUMENT") {
        return ok(
          searchOutput([
            {
              uri: "/sap/bc/adt/ddic/ddl/sources/i_changedocumentitem",
              type: "DDLS/DF",
              name: "I_CHANGEDOCUMENTITEM",
              packageName: "SZD",
            },
          ]),
        );
      }
      return undefined;
    });

    const result = await p.resolve("I_CHANGEDOCUMENT");
    expect(result.resolution).toBe("not-found");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args.join(" ")).toBe("search --json I_CHANGEDOCUMENT");
  });

  it("reports no search match without invoking a reader", async () => {
    const { provider: p, calls } = provider((args) => {
      if (args.join(" ") === "search --json MISSING") {
        return ok("🔍 Searching...\nNo objects found matching your query.\n");
      }
      return undefined;
    });

    const result = await p.resolve("MISSING");
    expect(result.resolution).toBe("not-found");
    expect(calls).toHaveLength(1);
  });

  it("reports unsupported types distinctly and does not guess a reader", async () => {
    const { provider: p, calls } = provider((args) => {
      if (args.join(" ") === "search --json ZDCL") {
        return ok(
          searchOutput([
            {
              uri: "/sap/bc/adt/acm/dcl/sources/zdcl",
              type: "DCLS/DL",
              name: "ZDCL",
              packageName: "SZD",
            },
          ]),
        );
      }
      return undefined;
    });

    const result = await p.resolve("ZDCL");
    expect(result.resolution).toBe("unsupported-type");
    expect(result.candidates?.[0]?.objectSubtype).toBe("DL");
    expect(calls).toHaveLength(1);
  });

  it("reports ambiguous supported types and refuses to guess", async () => {
    const { provider: p, calls } = provider((args) => {
      if (args.join(" ") === "search --json ZDUP") {
        return ok(
          searchOutput([
            {
              uri: "/sap/bc/adt/ddic/ddl/sources/zdup",
              type: "DDLS/DF",
              name: "ZDUP",
              packageName: "SZD",
            },
            {
              uri: "/sap/bc/adt/ddic/tables/zdup",
              type: "TABL/DT",
              name: "ZDUP",
              packageName: "SZD",
            },
          ]),
        );
      }
      return undefined;
    });

    const result = await p.resolve("ZDUP");
    expect(result.resolution).toBe("ambiguous");
    expect(calls).toHaveLength(1);
  });

  it("classifies search failures separately from read failures", async () => {
    const { provider: p, calls } = provider((args) => {
      if (args.join(" ") === "search --json ZTEST") return fail("Unauthorized (401)");
      return undefined;
    });

    const result = await p.resolve("ZTEST");
    expect(result.resolution).toBe("search-failed");
    expect(result.errorCode).toBe("auth");
    expect(calls).toHaveLength(1);
  });

  it("classifies a typed-read failure as read-failed (no fallback reader)", async () => {
    const { provider: p, calls } = provider((args) => {
      const key = args.join(" ");
      if (key === "search --json ZTEST") return ok(searchOutput(DDLS_CANDIDATES));
      if (key === "ddl read ZTEST") return fail("HTTP 404: Not Found");
      return undefined;
    });

    const result = await p.resolve("ZTEST");
    expect(result.resolution).toBe("read-failed");
    expect(result.errorCode).toBe("not-found");
    expect(calls.map((c) => c.args.join(" "))).toEqual([
      "search --json ZTEST",
      "ddl read ZTEST",
    ]);
    expect(calls.some((c) => c.args[0] === "table")).toBe(false);
    expect(calls.some((c) => c.args[0] === "get")).toBe(false);
  });

  it("reports timeouts as search-failed", async () => {
    const { provider: p } = provider((args) => {
      if (args.join(" ") === "search --json ZTEST") {
        return { exitCode: null, stdout: Buffer.alloc(0), stderr: "", timedOut: true };
      }
      return undefined;
    });

    const result = await p.resolve("ZTEST");
    expect(result.resolution).toBe("search-failed");
    expect(result.errorCode).toBe("timeout");
  });

  it("rejects an invalid name without invoking the process", async () => {
    const { provider: p, calls } = provider(() => undefined);
    const result = await p.resolve("ZTEST; rm -rf /");
    expect(result.resolution).toBe("read-failed");
    expect(result.errorCode).toBe("invalid-name");
    expect(calls).toHaveLength(0);
  });

  it("decodes UTF-16 typed-read payloads", async () => {
    const utf16 = (text: string): Buffer =>
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
    const { provider: p } = provider((args) => {
      const key = args.join(" ");
      if (key === "search --json CDPOS") {
        return ok(
          searchOutput([
            {
              uri: "/sap/bc/adt/ddic/tables/cdpos",
              type: "TABL/DT",
              name: "CDPOS",
              packageName: "SZD",
            },
          ]),
        );
      }
      if (key === "table read CDPOS") return ok(utf16("define table cdpos { mandt : mandt; }"));
      return undefined;
    });

    const result = await p.resolve("CDPOS");
    expect(result.resolution).toBe("resolved");
    expect(result.source).toContain("define table cdpos");
  });

  it("extracts JSON arrays from banner/footer output, string-aware", () => {
    const text = 'banner\n[{"name":"A","description":"contains ] and \\"quote\\""}]\nfooter';
    const json = extractJsonArray(text);
    expect(json).toBeDefined();
    expect(JSON.parse(json!)).toEqual([{ name: "A", description: 'contains ] and "quote"' }]);
  });
});
