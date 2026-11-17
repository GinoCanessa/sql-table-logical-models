import { SOF, array, fail, object, sqlLibrary, text } from "./fhir.js";
import type { Artifact, FhirObject } from "./fhir.js";
import { extractSqlText, libraryKind, singleStatement } from "./engine.js";
import type { QueryEngine, QueryResult } from "./engine.js";
import { artifact } from "./store.js";
import { quoteIdentifier } from "./schema.js";
import type { SqlRelation, SqlSchema } from "./schema.js";

export interface PlaygroundArtifact {
  reference: string;
  resourceType: string;
  id: string;
  title: string;
  url?: string;
  version?: string;
  generated: boolean;
  dependency: boolean;
}

export interface PlaygroundRelation extends SqlRelation {
  modelReference: string;
  canonical: string;
}

export interface PlaygroundCatalog {
  baseUrl: string;
  maxRows: number;
  pageSize: number;
  relations: PlaygroundRelation[];
  artifacts: PlaygroundArtifact[];
}

export interface TablePreview extends QueryResult {
  offset: number;
  limit: number;
  mayHaveMore: boolean;
}

function isDependency(resource: Artifact, engine: QueryEngine): boolean {
  if (resource.resourceType === "ViewDefinition") return true;
  if (resource.resourceType === "StructureDefinition") return engine.bindings.some((b) => b.model === resource);
  if (resource.resourceType !== "Library") return false;
  // Invalid stored artifacts remain inspectable, but are not offered as dependency candidates.
  const type = resource.type;
  if (!type || typeof type !== "object" || Array.isArray(type)) return false;
  return Array.isArray(type.coding) && type.coding.some((c) =>
    c && typeof c === "object" && !Array.isArray(c) &&
    c.system === `${SOF}/CodeSystem/LibraryTypesCodes` && c.code === "sql-view");
}

export function playgroundCatalog(schema: SqlSchema, engine: QueryEngine, baseUrl: string): PlaygroundCatalog {
  return {
    baseUrl, maxRows: engine.maxRows, pageSize: Math.min(25, engine.maxRows),
    relations: schema.relations.map((relation) => {
      const binding = engine.bindings.find((b) => b.table === relation.name)!;
      return {
        ...relation,
        modelReference: `StructureDefinition/${binding.model.id}`,
        canonical: `${binding.model.url}${binding.model.version ? `|${binding.model.version}` : ""}`,
      };
    }),
    artifacts: engine.catalog.list().map((resource) => ({
      reference: `${resource.resourceType}/${resource.id}`, resourceType: resource.resourceType,
      id: resource.id, title: typeof resource.title === "string" ? resource.title :
        typeof resource.name === "string" ? resource.name : resource.id,
      ...(resource.url ? { url: resource.url } : {}),
      ...(resource.version ? { version: resource.version } : {}),
      generated: engine.catalog.generated.includes(resource),
      dependency: isDependency(resource, engine),
    })),
  };
}

export function previewTable(schema: SqlSchema, engine: QueryEngine, query: URLSearchParams): TablePreview {
  for (const key of query.keys()) {
    if (!["name", "offset", "limit"].includes(key) || query.getAll(key).length !== 1) fail(400, "invalid", `Invalid table preview parameter: ${key}`);
  }
  const relation = schema.relations.find((r) => r.name === query.get("name")) ??
    fail(404, "not-found", "Unknown table or view");
  const integer = (name: string, fallback: number, min: number, max: number) => {
    const raw = query.get(name);
    if (raw !== null && !/^(0|[1-9]\d*)$/.test(raw)) fail(400, "invalid", `${name} must be a non-negative integer`);
    const value = raw === null ? fallback : Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max) fail(400, "invalid", `${name} must be between ${min} and ${max}`);
    return value;
  };
  const limit = integer("limit", Math.min(25, engine.maxRows), 1, Math.min(100, engine.maxRows));
  const offset = integer("offset", 0, 0, Number.MAX_SAFE_INTEGER);
  const keys = relation.columns.filter((c) => c.primaryKeyPosition > 0).sort((a, b) => a.primaryKeyPosition - b.primaryKeyPosition);
  const order = keys.length ? ` ORDER BY ${keys.map((c) => quoteIdentifier(c.name)).join(", ")}` : "";
  const result = engine.run(sqlLibrary("table-preview",
    `SELECT * FROM main.${quoteIdentifier(relation.name)}${order} LIMIT ${limit} OFFSET ${offset}`, []), { limit });
  return { ...result, offset, limit, mayHaveMore: result.rows.length === limit };
}

export function generateLibrary(value: unknown, baseUrl: string): Artifact {
  const input = object(value, "Library generation input");
  for (const key of Object.keys(input)) {
    if (!["id", "kind", "sql", "dependencies", "parameters", "title", "url", "version", "source"].includes(key)) fail(400, "invalid", `Unknown generation property: ${key}`);
  }
  const kind = input.kind;
  if (kind !== "sql-query" && kind !== "sql-view") fail(400, "invalid", "kind must be sql-query or sql-view");
  const labels = new Set<string>();
  const dependencies = array(input.dependencies, "dependencies").map((value) => {
    const dependency = object(value, "dependency");
    const label = text(dependency.label, "dependency.label");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(label) || labels.has(label.toLowerCase())) fail(400, "invalid", `Invalid or duplicate dependency label: ${label}`);
    labels.add(label.toLowerCase());
    const canonical = text(dependency.resource, "dependency.resource");
    if (!/^https?:\/\/\S+$/.test(canonical)) fail(400, "invalid", "Dependency resource must be an absolute HTTP(S) canonical");
    return { label, resource: canonical };
  });
  const sql = text(input.sql, "sql");
  singleStatement(sql);
  const generated = sqlLibrary(text(input.id, "id"), sql, dependencies, kind, baseUrl);
  const source = input.source === undefined ? undefined : artifact(input.source);
  if (source && source.resourceType !== "Library") fail(400, "invalid", "source must be a Library");
  const resource: Artifact = { ...source, ...generated };
  if (source) {
    for (const key of ["name", "status", "experimental"]) {
      if (source[key] !== undefined) resource[key] = source[key];
    }
    const meta = source.meta === undefined ? {} : object(source.meta, "source.meta");
    const profiles = array(meta.profile, "source.meta.profile").filter((p) => typeof p !== "string" ||
      ![`${SOF}/StructureDefinition/SQLQuery`, `${SOF}/StructureDefinition/SQLView`].includes(p.split("|")[0]!));
    resource.meta = { ...meta, profile: [...profiles, ...array(object(generated.meta).profile, "generated.meta.profile")] };
    const sourceType = object(source.type, "source.type");
    const coding = array(sourceType.coding, "source.type.coding").filter((c) => object(c).system !== `${SOF}/CodeSystem/LibraryTypesCodes`);
    resource.type = { ...sourceType, coding: [...coding, ...array(object(generated.type).coding, "generated.type.coding")] };
    resource.content = [...array(generated.content, "generated.content"), ...array(source.content, "source.content").filter((c) => object(c).contentType !== "application/sql")];
    resource.relatedArtifact = [
      ...array(source.relatedArtifact, "source.relatedArtifact").filter((a) => object(a).type !== "depends-on"),
      ...array(generated.relatedArtifact, "generated.relatedArtifact"),
    ];
  }
  if (input.title === "") delete resource.title;
  else if (input.title !== undefined) resource.title = text(input.title, "title");
  if (input.url !== undefined) resource.url = text(input.url, "url");
  if (input.version === "") delete resource.version;
  else if (input.version !== undefined) resource.version = text(input.version, "version");
  const names = new Set<string>();
  const types = ["string", "integer", "integer64", "decimal", "boolean", "date", "dateTime"];
  resource.parameter = array(input.parameters, "parameters").map((value) => {
    const parameter = object(value, "parameter");
    const name = text(parameter.name, "parameter.name");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || names.has(name)) fail(400, "invalid", `Invalid or duplicate query parameter: ${name}`);
    names.add(name);
    if (!types.includes(String(parameter.type)) || parameter.use !== "in" ||
      (parameter.min !== undefined && parameter.min !== 0 && parameter.min !== 1) ||
      (parameter.max !== undefined && parameter.max !== "1")) fail(400, "not-supported", "Parameters must declare supported scalar input types (min 0/1, max 1)");
    return parameter;
  });
  return artifact(resource);
}

export function libraryWorkspace(resource: Artifact): FhirObject {
  if (resource.resourceType !== "Library") fail(400, "invalid", "Only SQL Libraries can be loaded into the SQL workspace");
  return { resource, sql: extractSqlText(resource), kind: libraryKind(resource) };
}
