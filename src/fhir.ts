export type Json = null | boolean | number | string | Json[] | { [key: string]: Json | undefined };
export interface FhirObject {
  [key: string]: Json | undefined;
}
export interface Artifact extends FhirObject {
  resourceType: string;
  id: string;
  url?: string;
  version?: string;
}

export class OperationError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    readonly issues?: FhirObject[],
  ) {
    super(message);
  }

  outcome(): FhirObject {
    return {
      resourceType: "OperationOutcome",
      issue: this.issues ?? [{ severity: "error", code: this.code, diagnostics: this.message }],
    };
  }
}

export function fail(status: number, code: string, message: string): never {
  throw new OperationError(status, code, message);
}

export function object(value: unknown, label = "value"): FhirObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(400, "invalid", `${label} must be an object`);
  }
  return value as FhirObject;
}

export function array(value: unknown, label: string): Json[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(400, "invalid", `${label} must be an array`);
  return value as Json[];
}

export function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) fail(400, "invalid", `${label} must be a non-empty string`);
  return value;
}

export function extension(value: FhirObject, url: string): FhirObject | undefined {
  return array(value.extension, "extension").map((e) => object(e, "extension")).find((e) => e.url === url);
}

export const SOF = "http://hl7.org/fhir/uv/sql-on-fhir";
export const EXP = "https://example.org/sql-table-logical-models";
export const EXT = `${EXP}/StructureDefinition`;
export const RELATION = `${EXT}/Relation`;
export const SOF_RELATION = `${SOF}/StructureDefinition/Relation`;
export const BINARY_CONTENT_MODEL = "http://hl7.org/fhir/StructureDefinition/binary-content-model";
export const SQL_TEXT = `${SOF}/StructureDefinition/sql-text`;
export const SQL_CONTENT_TYPE_SYSTEM = "https://sql-on-fhir.org/ig/CodeSystem/SQLContentTypeCodes";
export const SQLITE_CONTENT_TYPE = "application/sql;dialect=sqlite";
export const SQL_CONTENT_TYPE_EXTENSION = `${EXT}/sql-content-type`;

export function isSqlContentType(value: Json | undefined): boolean {
  return typeof value === "string" && /^application\/sql(?:;|$)/.test(value);
}

export function sqliteContentTypeExtension(): FhirObject {
  return {
    url: SQL_CONTENT_TYPE_EXTENSION,
    valueCoding: { system: SQL_CONTENT_TYPE_SYSTEM, code: SQLITE_CONTENT_TYPE },
  };
}

export function sqlLibrary(
  id: string,
  sql: string,
  dependencies: { label: string; resource: string }[],
  kind: "sql-query" | "sql-view" = "sql-query",
  base = "https://example.org/sql",
): Artifact {
  return {
    resourceType: "Library",
    id,
    url: `${base}/Library/${id}`,
    name: id.replace(/[^A-Za-z0-9_]/g, "_"),
    status: "draft",
    experimental: true,
    meta: { profile: [`${SOF}/StructureDefinition/${kind === "sql-query" ? "SQLQuery" : "SQLView"}`] },
    type: { coding: [{ system: `${SOF}/CodeSystem/LibraryTypesCodes`, code: kind }] },
    extension: [sqliteContentTypeExtension()],
    relatedArtifact: dependencies.map((d) => ({ type: "depends-on", ...d })),
    content: [{
      contentType: SQLITE_CONTENT_TYPE,
      data: Buffer.from(sql).toString("base64"),
      extension: [{ url: SQL_TEXT, valueString: sql }],
    }],
  };
}
