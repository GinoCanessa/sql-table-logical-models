import { randomUUID } from "node:crypto";
import { SQLITE_CONTENT_TYPE, array, fail, object, text } from "./fhir.js";
import type { Artifact, FhirObject } from "./fhir.js";
import { QueryEngine, jsonResult } from "./engine.js";
import type { PreparedResult, QueryResult } from "./engine.js";
import { artifact, parameters } from "./store.js";
import { verifyWire } from "./conformance.js";

export const MEDIA = { json: "application/json", ndjson: "application/x-ndjson", csv: "text/csv" } as const;
export type Format = keyof typeof MEDIA;
export interface RunRequest {
  subject: Artifact;
  context: Artifact[];
  parameters?: FhirObject;
  limit?: number;
  format: Format;
  header: boolean;
  envelope: boolean;
}

export function valueOf(part: FhirObject, field: string): unknown {
  const keys = Object.keys(part).filter((k) => k !== "name");
  if (keys.length !== 1 || keys[0] !== field) fail(400, "invalid", `${String(part.name)} requires ${field}`);
  return part[field];
}

export function named(parts: FhirObject[], name: string): FhirObject | undefined {
  const matches = parts.filter((p) => p.name === name);
  if (matches.length > 1) fail(400, "invalid", `${name} cannot repeat`);
  return matches[0];
}

export function checkNames(parts: FhirObject[], allowed: string[], repeated: string[] = []): void {
  for (const part of parts) {
    const name = text(part.name, "parameter.name");
    if (!allowed.includes(name)) fail(400, "not-supported", `Unsupported operation parameter: ${name}`);
    if (!repeated.includes(name)) named(parts, name);
  }
}

export function queryParameters(query: URLSearchParams): FhirObject {
  const fields: Record<string, string> = {
    subjectCanonical: "valueCanonical", subjectReference: "valueReference",
    _format: "valueCode", _limit: "valueInteger", header: "valueBoolean", dialect: "valueCode",
  };
  return {
    resourceType: "Parameters",
    parameter: [...query].map(([name, value]) => {
      const field = Object.hasOwn(fields, name) ? fields[name]! : fail(400, "not-supported", `Unsupported GET parameter: ${name}`);
      if (name === "header" && !["true", "false"].includes(value)) fail(400, "invalid", "header must be true or false");
      if (name === "_limit" && !/^(0|[1-9]\d*)$/.test(value)) fail(400, "invalid", "_limit must be a non-negative integer");
      return { name, [field]: name === "subjectReference" ? { reference: value } :
        name === "header" ? value === "true" : name === "_limit" ? Number(value) : value };
    }),
  };
}

function negotiate(parts: FhirObject[], accept?: string): { format: Format; envelope: boolean } {
  const formatPart = named(parts, "_format");
  const explicit = formatPart ? text(valueOf(formatPart, "valueCode"), "_format") : undefined;
  if (explicit && !Object.hasOwn(MEDIA, explicit)) fail(400, "not-supported", `Unsupported format: ${explicit}`);
  const accepted = (accept ?? "*/*").split(",").map((entry) => {
    const [media, ...params] = entry.trim().split(";");
    const quality = params.find((p) => p.trim().startsWith("q="));
    const q = quality ? Number(quality.trim().slice(2)) : 1;
    return { media: media?.toLowerCase(), q };
  }).filter((a) => Number.isFinite(a.q) && a.q > 0 && a.q <= 1).sort((a, b) => b.q - a.q);
  const chosen = accepted.find((a) => ["*/*", "application/*", "application/octet-stream", "application/fhir+json", ...Object.values(MEDIA)].includes(a.media ?? ""));
  if (!chosen) fail(406, "not-supported", "No supported response media type in Accept");
  const inferred = Object.entries(MEDIA).find(([, media]) => chosen.media === media)?.[0] ?? "ndjson";
  return { format: (explicit ?? inferred) as Format, envelope: chosen.media === "application/fhir+json" };
}

function resolveSubject(engine: QueryEngine, parts: FhirObject[]) {
  const subjects = parts.filter((p) => ["subjectCanonical", "subjectReference", "subjectResource"].includes(String(p.name)));
  if (subjects.length !== 1) fail(400, "required", "Supply exactly one subjectCanonical, subjectReference or subjectResource");
  const subjectPart = subjects[0]!;
  const context = parts.filter((p) => p.name === "context").map((p) => artifact(valueOf(p, "resource"), false));
  const subject = subjectPart.name === "subjectResource" ? artifact(valueOf(subjectPart, "resource"), false) :
    subjectPart.name === "subjectReference" ?
      engine.catalog.get(text(object(valueOf(subjectPart, "valueReference")).reference, "subjectReference.reference")) :
      engine.catalog.resolve(text(valueOf(subjectPart, "valueCanonical"), "subjectCanonical"));
  return { subject, context, local: context.length > 0 || subjectPart.name === "subjectResource" };
}

export function parseDescribe(engine: QueryEngine, input: unknown) {
  const parts = parameters(input);
  checkNames(parts, ["subjectCanonical", "subjectReference", "subjectResource", "context", "_format", "dialect"], ["context"]);
  const dialect = named(parts, "dialect");
  if (dialect && valueOf(dialect, "valueCode") !== SQLITE_CONTENT_TYPE) fail(422, "not-supported", "Only SQLite can be described");
  const selection = named(parts, "_format");
  const format = selection ? valueOf(selection, "valueCode") : "json";
  if (format !== "json" && format !== "sql" && format !== "operation") fail(400, "not-supported", "Unsupported describe format");
  return { ...resolveSubject(engine, parts), format };
}

export function parseRun(engine: QueryEngine, input: unknown, accept?: string): RunRequest {
  const parts = parameters(input);
  checkNames(parts, ["subjectCanonical", "subjectReference", "subjectResource", "parameters", "context", "_format", "header", "_limit"], ["context"]);
  const { subject, context } = resolveSubject(engine, parts);
  const bindingPart = named(parts, "parameters");
  const limitPart = named(parts, "_limit");
  const limit = limitPart ? valueOf(limitPart, "valueInteger") : undefined;
  if (limit !== undefined && (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 0 || limit > engine.maxRows)) {
    fail(400, "invalid", `_limit must be an integer from 0 to ${engine.maxRows}`);
  }
  const headerPart = named(parts, "header");
  const header = headerPart ? valueOf(headerPart, "valueBoolean") : true;
  if (typeof header !== "boolean") fail(400, "invalid", "header must be boolean");
  return {
    subject, context, ...negotiate(parts, accept), header,
    ...(bindingPart ? { parameters: object(valueOf(bindingPart, "resource"), "parameters") } : {}),
    ...(limit !== undefined ? { limit: limit as number } : {}),
  };
}

export function formatResult(result: PreparedResult | QueryResult, format: Format, header: boolean): string {
  if (format !== "csv") {
    const { rows } = "descriptors" in result ? jsonResult(result) : result;
    return format === "json" ? JSON.stringify(rows) : rows.map((r) => JSON.stringify(r) + "\n").join("");
  }
  const columns = "descriptors" in result ? result.descriptors.map((c) => c.name) : result.columns;
  const csv = (value: unknown) => {
    const s = value instanceof Uint8Array ? Buffer.from(value).toString("base64") : value == null ? "" : String(value);
    return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  const rows = result.rows.map((r) => columns.map((c) => csv(r[c])).join(","));
  if (header) rows.unshift(columns.map(csv).join(","));
  return rows.length ? rows.join("\r\n") + "\r\n" : "";
}

export function runOperation(engine: QueryEngine, request: RunRequest) {
  const result = engine.runPreparedBatch([request], request)[0]!;
  const body = formatResult(result, request.format, request.header);
  const contentType = MEDIA[request.format];
  const issues = result.issues.concat(engine.settings.verifyOutput ? verifyWire(result, body, request.format, request.header) : []);
  return request.envelope ?
    { issues, contentType: "application/fhir+json", body: JSON.stringify({ resourceType: "Binary", contentType, data: Buffer.from(body).toString("base64") }) } :
    { issues, contentType, body };
}

export interface ExportSubject {
  name: string;
  request: RunRequest;
}

export function parseExport(engine: QueryEngine, input: unknown): { subjects: ExportSubject[]; trackingId?: string } {
  const parts = parameters(input);
  checkNames(parts, ["subject", "context", "_format", "header", "clientTrackingId"], ["subject", "context"]);
  const subjects = parts.filter((p) => p.name === "subject");
  if (!subjects.length || subjects.length > 20) fail(400, "invalid", "Supply between 1 and 20 export subjects");
  const names = new Set<string>();
  const parsed = subjects.map((p) => {
    const entries = array(valueOf(p, "part"), "subject.part").map((entry) => object(entry));
    checkNames(entries, ["name", "subjectCanonical", "subjectReference", "subjectResource", "parameters"]);
    const namePart = named(entries, "name");
    const request = parseRun(engine, {
      resourceType: "Parameters",
      parameter: [...entries.filter((e) => e.name !== "name"), ...parts.filter((e) => !["subject", "clientTrackingId"].includes(String(e.name)))],
    });
    const name = namePart ? text(valueOf(namePart, "valueString"), "subject.name") :
      typeof request.subject.name === "string" ? request.subject.name : assignedId();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name) || names.has(name.toLowerCase())) fail(400, "invalid", "Export names must be unique simple filenames (letters, digits, underscore, hyphen); supply an explicit safe name");
    names.add(name.toLowerCase());
    return { name, request };
  });
  engine.runBatch(parsed.map(({ request }) => ({
    subject: request.subject, ...(request.parameters ? { parameters: request.parameters } : {}),
  })), { context: parsed[0]!.request.context, limit: 0 });
  const tracking = named(parts, "clientTrackingId");
  return { subjects: parsed, ...(tracking ? { trackingId: text(valueOf(tracking, "valueString"), "clientTrackingId") } : {}) };
}

export function assignedId(): string {
  return randomUUID();
}
