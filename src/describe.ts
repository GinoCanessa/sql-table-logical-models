import { createHash } from "node:crypto";
import type { StatementColumnMetadata } from "node:sqlite";
import { BINARY_CONTENT_MODEL, EXT, RELATION, SOF_RELATION, SQLITE_CONTENT_TYPE, array, fail, object, sqliteContentTypeExtension } from "./fhir.js";
import type { Artifact, FhirObject } from "./fhir.js";
import { modelSettings, sqliteType, stableName } from "./models.js";
import type { ModelOptions, RelationBinding } from "./models.js";
import { columnElement, primitives, readRelation, relationColumns, requireValid, unknownResult } from "./relation.js";
import type { ColumnFacts } from "./relation.js";
import { quoteIdentifier as q, sqliteNameKey } from "./schema.js";

export function normalized(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => v && typeof v === "object" && !Array.isArray(v) ?
    Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : v);
}
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
export const canonical = (r: Artifact) => r.url && `${r.url}${r.version ? `|${r.version}` : ""}`;
export interface Descriptor extends StatementColumnMetadata {
  primitive?: string;
  facts: ColumnFacts;
  annotations: FhirObject;
  origin?: string;
}
export interface Projection { declaration: FhirObject; binding: RelationBinding }
export function descriptor(c: StatementColumnMetadata, bindings: RelationBinding[], output?: FhirObject, view?: Projection, curated?: RelationBinding): Descriptor {
  const sameTable = (b: RelationBinding) => c.table && sqliteNameKey(c.table) === sqliteNameKey(b.table);
  const binding = view?.binding ?? curated ?? bindings.find(sameTable);
  const source = binding && relationColumns(binding.model).find((col) => view ? col.name === view.declaration.path :
    c.column && sqliteNameKey(col.physicalName) === sqliteNameKey(c.column));
  const physical = source?.primitive ?? (c.type ? sqliteType(c.type).fhir : undefined);
  const declared = view ? view.declaration.type : output?.type;
  if (declared !== undefined && !primitives.has(String(declared))) fail(422, "not-supported", `Non-primitive output type for ${c.name}: ${String(declared)}`);
  if (declared !== undefined && (typeof declared !== "string" || (physical && physical !== declared))) {
    fail(422, "invalid", `Conflicting primitive for ${c.name}: ${String(declared)} vs ${physical ?? "unknown"}`);
  }
  const primitive = declared ?? physical;
  const min = view ? source?.min ?? 0 : output?.min === undefined ? 0 : output.min;
  const max = view?.declaration.collection === true ? "*" : output?.max === undefined ? "1" : output.max;
  if ((min !== 0 && min !== 1) || (max !== "*" && max !== "1")) fail(422, "invalid", `Unsupported output cardinality: ${c.name}`);
  const definition = view?.declaration.description ?? output?.documentation;
  if (definition !== undefined && typeof definition !== "string") fail(422, "invalid", `Invalid documentation: ${c.name}`);
  const annotations: FhirObject = definition ? { definition } : {};
  if (view && source) {
    const path = `${binding!.model.name}.${source.name}`;
    const element = array(object(binding!.model.differential).element, "element").map((e) => object(e)).find((e) => e.path === path);
    for (const [key, value] of Object.entries(element ?? {})) {
      if (/^(?:minValue|maxValue)/.test(key) || ["label", "code", "alias", "meaningWhenMissing", "example", "binding", "comment", "requirements"].includes(key) ||
        (key === "definition" && definition === undefined) || (key === "short" && value !== source.physicalName)) annotations[key] = value;
    }
  }
  const sqlTypes = (source?.sqlTypes ?? []).filter((s) => !binding?.curated || !c.type ||
    (s.dialect && s.dialect !== SQLITE_CONTENT_TYPE && s.dialect !== "application/sql"));
  if (!sqlTypes.some((s) => s.dialect === SQLITE_CONTENT_TYPE) && c.type) sqlTypes.unshift({ dialect: SQLITE_CONTENT_TYPE, declaredType: c.type });
  for (const entry of array(view?.declaration.tag, "column.tag")) {
    const tag = object(entry), match = /^([a-z][a-z0-9-]*)\/type$/i.exec(String(tag.name));
    if (!match) continue;
    const dialect = `application/sql;dialect=${match[1] === "ansi" ? "ansi-sql" : match[1]}`;
    const prior = sqlTypes.find((s) => s.dialect === dialect);
    if (typeof tag.value !== "string" || !tag.value.trim() || tag.value.includes("\0") || (prior && prior.declaredType !== tag.value)) fail(422, "invalid", `Invalid or conflicting SQL type tag for ${c.name}`);
    if (!prior) sqlTypes.push({ dialect, declaredType: tag.value });
  }
  const facts: ColumnFacts = {
    name: /^[A-Za-z_]\w*$/.test(c.name) ? c.name : stableName(c.name, "c_"), physicalName: c.name,
    ...(primitive ? { primitive } : { warning: unknownResult }), sqlTypes, min, max,
    mustHaveValue: view ? source?.mustHaveValue === true : min === 1, primaryKey: false,
    ...(view && source?.maxLength !== undefined ? { maxLength: source.maxLength } : {}),
  };
  return { ...c, ...(primitive ? { primitive } : {}), facts, annotations,
    ...(source && binding ? { origin: `${binding.model.url}#${binding.model.name}.${source.name}` } : {}) };
}

const storage: Record<string, string> = { integer: "INTEGER", integer64: "INTEGER", positiveInt: "INTEGER", unsignedInt: "INTEGER",
  boolean: "BOOLEAN", decimal: "NUMERIC", base64Binary: "BLOB", date: "DATE", dateTime: "DATETIME", time: "TIME" };
function ddlType(facts: ColumnFacts): string {
  const declared = facts.sqlTypes.find((s) => s.dialect === SQLITE_CONTENT_TYPE)?.declaredType;
  if (!declared) return facts.primitive ? storage[facts.primitive] ?? "TEXT" : "";
  // Only render familiar type grammar as SQL. SQLite accepts a quoted identifier for any other type name.
  return /^(?:INTEGER|INT|SMALLINT|BIGINT|TEXT|VARCHAR|CHAR|BLOB|BOOLEAN|DATE|DATETIME|TIME|DECIMAL|NUMERIC|REAL|DOUBLE PRECISION)(?:\(\s*\d+\s*(?:,\s*\d+\s*)?\))?$/i.test(declared) ?
    declared : q(declared);
}
export interface Contract { model: Artifact; profileId: string; profileUrl: string; ddl: string }
export function buildContract(subject: Artifact, dependencies: Artifact[], sources: Artifact[], descriptors: Descriptor[],
  options: ModelOptions, occupied: Artifact[], snapshots: Artifact[], effective: RelationBinding[] = []): Contract {
  const settings = modelSettings(options);
  const base = (options.baseUrl ?? "https://example.org/sql").replace(/\/+$/, "");
  const curated = effective.filter((b) => b.curated).map((b) => [canonical(b.model), b.table, [...b.columns]]);
  const key = digest(normalized({ subject, dependencies, sources, descriptors, settings, base, ...(curated.length ? { curated } : {}) }));
  const name = stableName(`${subject.name ?? subject.id}Result`, "Result_");
  for (let n = 0; ; n++) {
    const suffix = (n ? digest(`${key}:${n}`) : key).slice(0, 48);
    const id = `result-${suffix}`, profileId = `run-${suffix}`;
    const url = `${base}/StructureDefinition/${id}`, profileUrl = `${base}/OperationDefinition/${profileId}`;
    if (occupied.some((r) => (r.resourceType === "StructureDefinition" && r.id === id) ||
      (r.resourceType === "OperationDefinition" && r.id === profileId) || r.url === url || r.url === profileUrl)) continue;
    const model: Artifact = {
      resourceType: "StructureDefinition", id, url, name, type: url, status: "draft", experimental: true,
      kind: "logical", abstract: false, derivation: "specialization", fhirVersion: "5.0.0",
      baseDefinition: settings.relationBase === "sof" ? SOF_RELATION : RELATION,
      description: "Prepared SQLite result. Unknown expression types are omitted. SQLite does not enforce declared string lengths.",
      extension: [sqliteContentTypeExtension(), { url: `${EXT}/relation-kind`, valueCode: "result" },
        ...(subject.url ? [{ url: `${EXT}/describes`, valueCanonical: canonical(subject) }] : [])],
      ...(settings.typeEncoding === "extension" ? {} : { mapping: [{ identity: "sql", name: "SQL storage type" }] }),
      differential: { element: [{ id: name, path: name, min: 0, max: "*" }, ...descriptors.map((c) => ({
        ...columnElement(name, c.facts, settings.typeEncoding, c.origin ? [{ url: `${EXT}/origin`, valueUri: c.origin }] : []), ...c.annotations,
      }))] },
    };
    requireValid(model);
    const columns = readRelation(model)!.columns.map((facts) =>
      [q(facts.physicalName), ddlType(facts), facts.min === 1 ? "NOT NULL" : ""].filter(Boolean).join(" "));
    const ddl = `CREATE TABLE ${q(name)} (\n  ${columns.join(",\n  ")}\n)`;
    model.extension = [...array(model.extension, "extension"), { url: `${EXT}/sql-ddl`, valueString: ddl }];
    if (snapshots.some((r) => (r.id === id || r.url === url) && normalized(r) !== normalized(model))) continue;
    return { model, profileId, profileUrl, ddl };
  }
}

export function runProfile(contract: Contract, run: FhirObject, local: boolean): Artifact {
  return { ...run, resourceType: "OperationDefinition", id: contract.profileId, url: contract.profileUrl, name: `${contract.model.name}Run`,
    base: run.url, ...(local ? { contained: [contract.model] } : {}),
    parameter: array(run.parameter, "parameter").map((v) => {
      const p = object(v);
      return p.name !== "return" ? p : { ...p, extension: [{ url: BINARY_CONTENT_MODEL,
        valueCanonical: local ? `#${contract.model.id}` : contract.model.url }] };
    }) };
}
