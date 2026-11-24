import { isDeepStrictEqual } from "node:util";
import { OperationError } from "./fhir.js";
import type { Artifact, FhirObject } from "./fhir.js";
import { jsonResult } from "./engine.js";
import type { PreparedResult } from "./engine.js";
import { primitiveValue, readRelation } from "./relation.js";
import type { Format } from "./operations.js";

function rawPrimitive(type: string, value: unknown): boolean {
  if (type === "decimal") return typeof value === "bigint" || primitiveValue(type, value);
  if (type === "boolean") return value === 0n || value === 1n || value === 0 || value === 1;
  if (["integer", "integer64", "unsignedInt", "positiveInt"].includes(type)) {
    if (typeof value !== "bigint" && !(typeof value === "number" && Number.isSafeInteger(value))) return false;
    return type === "integer64" ? primitiveValue(type, String(value)) : primitiveValue(type, Number(value));
  }
  if (type === "base64Binary" && value instanceof Uint8Array) return true;
  return primitiveValue(type, value);
}

function inspectRows(model: Artifact, rows: readonly unknown[], columns: readonly string[] | undefined, raw: boolean): FhirObject[] {
  const relation = readRelation(model);
  if (!relation) throw new Error("Expected a result Relation");
  const issues: FhirObject[] = [];
  const report = (diagnostics: string, path: string, severity = "error") =>
    issues.push({ severity, code: severity === "information" ? "informational" : "invalid", diagnostics, expression: [path] });
  const names = relation.columns.map((c) => c.physicalName);
  if (columns && !isDeepStrictEqual(columns, names)) report("Missing, extra or reordered descriptor columns", "columns");
  for (const c of relation.columns) if (!c.primitive) report(`Partial typing: ${c.name} is unknown`, c.name, "information");
  rows.forEach((row, index) => {
    const path = `row[${index}]`;
    if (!row || typeof row !== "object" || Array.isArray(row) || !isDeepStrictEqual(Object.keys(row), names)) {
      report("Missing, extra or reordered row columns", path); return;
    }
    for (const c of relation.columns) {
      const cell: unknown = (row as Record<string, unknown>)[c.physicalName], location = `${path}.${c.name}`;
      const required = c.mustHaveValue || c.min === 1;
      if (cell === null) { if (required) report("Required column is NULL", location); continue; }
      // SQLite projections contribute one raw scalar per cell, including singleton collections.
      if ((!raw && Array.isArray(cell) !== (c.max === "*")) || (required && Array.isArray(cell) && !cell.length)) {
        report("Wrong scalar/collection cardinality", location); continue;
      }
      for (const value of Array.isArray(cell) ? cell : [cell]) {
        const scalar = ["string", "boolean", "number"].includes(typeof value) || (raw && (typeof value === "bigint" || value instanceof Uint8Array));
        if (!scalar || (required && (value === "" || (value instanceof Uint8Array && !value.length))) ||
          (c.primitive && !(raw ? rawPrimitive : primitiveValue)(c.primitive, value))) {
          report(`Invalid ${c.primitive ?? "primitive"} representation`, location);
        }
        if (typeof value === "string" && c.maxLength !== undefined && [...value].length > c.maxLength) {
          report(`Value exceeds SQLite declared length ${c.maxLength}`, location, "warning");
        }
      }
    }
  });
  return issues;
}

export function checkRows(model: Artifact, rows: readonly unknown[], columns?: readonly string[]): FhirObject[] {
  return inspectRows(model, rows, columns, false);
}

function csvRecords(body: string): string[][] {
  const records: string[][] = [];
  let i = 0;
  while (i < body.length) {
    const row: string[] = [];
    for (;;) {
      const match = /(?:"((?:[^"]|"")*)"|([^",\r\n]*))(,|\r\n)/y;
      match.lastIndex = i;
      const cell = match.exec(body);
      if (!cell) throw new Error("Malformed CSV record or missing CRLF");
      row.push(cell[1]?.replaceAll('""', '"') ?? cell[2]!);
      i = match.lastIndex;
      if (cell[3] === "\r\n") break;
    }
    records.push(row);
  }
  return records;
}

/** Validate the actual bytes, retaining raw SQLite cells for CSV's lossy NULL convention. */
export function checkWire(model: Artifact, result: PreparedResult, body: string, format: Format, header: boolean): FhirObject[] {
  const columns = result.descriptors.map((c) => c.name);
  const issues: FhirObject[] = [];
  try {
    if (format === "csv") {
      issues.push(...inspectRows(model, result.rows, columns, true));
      const records = result.rows.map((r) => columns.map((n) => {
        const v = r[n];
        return v instanceof Uint8Array ? Buffer.from(v).toString("base64") : v === null ? "" : String(v);
      }));
      if (header) records.unshift(columns);
      if (!isDeepStrictEqual(csvRecords(body), records)) throw new Error("CSV header, cell or record order mismatch");
    } else {
      const expected = jsonResult(result);
      const rows: unknown = format === "json" ? JSON.parse(body) : body === "" ? [] :
        body.replace(/\r?\n$/, "").split(/\r?\n/).map((line) => JSON.parse(line));
      if (!Array.isArray(rows) || !isDeepStrictEqual(rows, expected.rows)) throw new Error("JSON records differ from prepared rows");
      issues.push(...checkRows(model, rows, columns));
    }
  } catch (err) {
    issues.push({ severity: "error", code: "invalid", diagnostics: String(err) });
  }
  return issues;
}

export function verifyWire(result: PreparedResult, body: string, format: Format, header: boolean) {
  const issues = checkWire(result.contract.model, result, body, format, header);
  if (issues.some((i) => i.severity === "error")) throw new OperationError(422, "invalid", "Output verification failed", issues);
  return issues;
}
