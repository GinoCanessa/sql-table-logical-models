import { createHash } from "node:crypto";
import { EXT, RELATION, SOF_RELATION, SQLITE_CONTENT_TYPE, fail, sqliteContentTypeExtension } from "./fhir.js";
import type { Artifact, FhirObject, Json } from "./fhir.js";
import type { SqlColumn, SqlRelation, SqlSchema } from "./schema.js";
import { sqliteNameKey } from "./schema.js";
import { columnElement, primitives, requireValid } from "./relation.js";
import type { ColumnFacts, TypeEncoding } from "./relation.js";

export interface ModelOptions {
  baseUrl?: string;
  version?: string;
  typeEncoding?: TypeEncoding;
  relationBase?: "local" | "sof";
  integerType?: "integer64" | "integer" | "auto";
}

export function modelSettings(input: { typeEncoding?: string; relationBase?: string; integerType?: string }) {
  function choice<const T extends string>(flag: string, value: string | undefined, choices: readonly [T, ...T[]]): T {
    return value === undefined ? choices[0] : choices.find((v) => v === value) ??
      fail(400, "invalid", `--${flag} must be one of ${choices.join(", ")}`);
  }
  return {
    typeEncoding: choice("type-encoding", input.typeEncoding, ["mapping", "extension", "both"]),
    relationBase: choice("relation-base", input.relationBase, ["local", "sof"]),
    integerType: choice("integer-type", input.integerType, ["integer64", "integer", "auto"]),
  };
}

export interface RelationBinding {
  model: Artifact;
  table: string;
  columns: Map<string, string>;
}

export function stableName(name: string, prefix: string): string {
  const clean = name.replace(/[^A-Za-z0-9_]/g, "_");
  if (/^[A-Za-z][A-Za-z0-9_]{0,48}$/.test(name)) return name;
  return `${prefix}${clean.slice(0, 38)}_${createHash("sha256").update(name).digest("hex").slice(0, 16)}`;
}

function modelId(name: string): string {
  if (/^[A-Za-z0-9.-]{1,64}$/.test(name) && name !== "experimental-relation-base") return name;
  return `table-${name.replace(/[^A-Za-z0-9.-]/g, "-").slice(0, 35)}-${createHash("sha256").update(name).digest("hex").slice(0, 16)}`;
}

export function sqliteType(declared: string): { affinity: string; fhir: string; warning?: string } {
  const type = declared.trim().toUpperCase();
  const affinity = type.includes("INT") ? "INTEGER" : /CHAR|CLOB|TEXT/.test(type) ? "TEXT" :
    type === "" || type.includes("BLOB") ? "BLOB" : /REAL|FLOA|DOUB/.test(type) ? "REAL" : "NUMERIC";
  let fhir = affinity === "INTEGER" ? "integer64" : affinity === "TEXT" ? "string" :
    affinity === "BLOB" ? (type === "" ? "string" : "base64Binary") : "decimal";
  if (/^BOOL(EAN)?$/.test(type)) fhir = "boolean";
  else if (/^(DATETIME|TIMESTAMP)(\(\d+\))?$/.test(type)) fhir = "dateTime";
  else if (type === "DATE") fhir = "date";
  else if (type === "TIME") fhir = "time";
  const result = { affinity, fhir };
  return type === "" ? { ...result, warning: "No declared type; string is an authoring hint, not an observed storage class." } : result;
}

function tableColumn(table: SqlRelation, column: SqlColumn, integerType: ModelOptions["integerType"]): ColumnFacts {
  const mapped = sqliteType(column.declaredType);
  // Widths in type names are never bounds. Recognize only a complete, literal
  // BETWEEN predicate, not a subexpression (which could be negated or optional).
  const bounded = integerType === "auto" && table.checks?.some((sql) => {
    const range = /^([A-Za-z_]\w*)\s+BETWEEN\s+(-?\d+)\s+AND\s+(-?\d+)$/i.exec(sql);
    if (!range || sqliteNameKey(range[1]!) !== sqliteNameKey(column.name)) return false;
    const low = BigInt(range[2]!), high = BigInt(range[3]!);
    return low >= -2147483648n && high <= 2147483647n && low <= high;
  });
  const length = mapped.fhir === "string" && /^(?:N?CHAR|N?VARCHAR|CHARACTER(?:\s+VARYING)?|VARYING\s+CHARACTER)\s*\(\s*(\d+)\s*\)$/i.exec(column.declaredType.trim());
  const maxLength = length ? Number(length[1]) : undefined;
  return {
    name: stableName(column.name, "c_"), physicalName: column.name,
    primitive: mapped.fhir === "integer64" && (integerType === "integer" || bounded) ? "integer" : mapped.fhir,
    sqlTypes: column.declaredType ? [{ declaredType: column.declaredType, dialect: SQLITE_CONTENT_TYPE }] : [],
    min: column.nullable ? 0 : 1, max: "1", mustHaveValue: !column.nullable,
    ...(maxLength !== undefined && maxLength <= 2147483647 ? { maxLength } : {}),
    ...(mapped.warning ? { warning: mapped.warning } : {}),
    primaryKey: column.primaryKeyPosition > 0,
    ...(column.primaryKeyPosition > 0 ? { primaryKeyPosition: column.primaryKeyPosition } : {}),
  };
}

function checkConstraint(sql: string, index: number, table: SqlRelation): FhirObject {
  const match = /^([A-Za-z_]\w*)\s+IS\s+(NOT\s+)?NULL$/i.exec(sql);
  const column = match && table.columns.find((c) => sqliteNameKey(c.name) === sqliteNameKey(match[1]!));
  return {
    key: `check-${index + 1}`, severity: "error", human: sql,
    extension: [{ url: `${EXT}/sql-expression`, valueString: sql }],
    ...(column ? { expression: `\`${stableName(column.name, "c_")}\`.${match[2] ? "exists" : "empty"}()` } : {}),
  };
}

export function relationBase(): Artifact {
  return {
    resourceType: "StructureDefinition", id: "experimental-relation-base", url: RELATION,
    name: "Relation", title: "Experimental SQL relation", status: "draft", experimental: true,
    fhirVersion: "5.0.0", kind: "logical", abstract: true, type: RELATION,
    baseDefinition: "http://hl7.org/fhir/StructureDefinition/Base", derivation: "specialization",
    description: "Local experimental base for flat SQL relations; not an adopted SQL-on-FHIR artifact.",
    extension: [{ url: "http://hl7.org/fhir/StructureDefinition/structuredefinition-type-characteristics", valueCode: "can-be-target" }],
    differential: { element: [{ id: "Relation", path: "Relation", min: 0, max: "*", constraint: [
      { key: "rel-1", severity: "error", human: "Columns are direct children of the root.",
        expression: "%resource.differential.element.tail().all(path.split('.').count() = 2)" },
      { key: "rel-2", severity: "error", human: "Column names are SQL-safe identifiers.",
        expression: "%resource.differential.element.tail().all(path.split('.').last().matches('^[A-Za-z_][A-Za-z0-9_]*$'))" },
      { key: "rel-3", severity: "error", human: "Known columns have one FHIR primitive; only documented unknown result columns may omit type.",
        expression: `%resource.differential.element.tail().all((type.count() = 1 and type.code in (${[...primitives].map((p) => `'${p}'`).join(" | ")})) or (type.empty() and comment.exists() and %resource.extension('${EXT}/relation-kind').value = 'result'))` },
    ] }] },
  };
}

export function createLogicalModels(schema: SqlSchema, options: ModelOptions = {}): {
  bundle: FhirObject; bindings: RelationBinding[]; resources: Artifact[];
} {
  const settings = modelSettings(options);
  const base = (options.baseUrl ?? "https://example.org/sql").replace(/\/+$/, "");
  if (!/^https?:\/\/[^?#|\s]+$/.test(base)) fail(400, "invalid", "baseUrl must be an absolute HTTP(S) canonical base without query, fragment or version");
  if (options.version !== undefined && (!options.version.trim() || options.version.includes("|"))) fail(400, "invalid", "version must be non-empty and cannot contain '|'");
  const names = new Map(schema.relations.map((r) => [r.name, stableName(r.name, "T_")]));
  const urls = new Map(schema.relations.map((r) => [r.name, `${base}/StructureDefinition/${modelId(r.name)}`]));
  const bindings: RelationBinding[] = schema.relations.map((table) => {
    const name = names.get(table.name)!;
    const url = urls.get(table.name)!;
    const facts = table.columns.map((c) => tableColumn(table, c, settings.integerType));
    const columns = new Map(facts.map((c) => [c.name, c.physicalName]));
    const elements: Json[] = [{
      id: name, path: name, min: 0, max: "*", short: `${table.kind} ${table.name}`,
      ...(table.checks?.length ? { constraint: table.checks.map((sql, i) => checkConstraint(sql, i, table)) } : {}),
    }];
    for (const [i, column] of table.columns.entries()) {
      const extensions: FhirObject[] = [];
      if (column.defaultSql !== null) extensions.push({ url: `${EXT}/sql-default`, valueString: column.defaultSql });
      if (column.generated) extensions.push({ url: `${EXT}/generated`, valueCode: column.generated });
      elements.push(columnElement(name, facts[i]!, settings.typeEncoding, extensions));
    }
    const foreignKeys: Json[] = table.foreignKeys.map((fk) => {
      const targetUrl = [...urls.entries()].find(([n]) => sqliteNameKey(n) === sqliteNameKey(fk.targetTable))?.[1];
      return {
        url: `${EXT}/foreign-key`,
        extension: [
          { url: "id", valueInteger: fk.id },
          { url: "target-table", valueString: fk.targetTable },
          ...(targetUrl ? [{ url: "target", valueCanonical: targetUrl }] : []),
          ...fk.columns.map((c, i) => ({
            url: "column", extension: [
              { url: "source", valueString: c },
              ...(fk.targetColumns[i] !== null && fk.targetColumns[i] !== undefined ?
                [{ url: "target", valueString: fk.targetColumns[i]! }] : []),
            ],
          })),
          { url: "on-update", valueCode: fk.onUpdate },
          { url: "on-delete", valueCode: fk.onDelete },
          { url: "match", valueString: fk.match },
        ],
      };
    });
    const model: Artifact = {
      resourceType: "StructureDefinition", id: modelId(table.name), url, name, title: table.name,
      ...(options.version ? { version: options.version } : {}),
      status: "draft", experimental: true, fhirVersion: "5.0.0",
      kind: "logical", abstract: false, type: url,
      baseDefinition: settings.relationBase === "local" ? RELATION : SOF_RELATION, derivation: "specialization",
      description: `Schema-derived ${schema.dialect} ${table.kind}. FHIR types are schema-derived hints. SQLite type names do not enforce declared lengths or numeric bounds. Physical binding is local configuration, not a portable data URL.`,
      ...(settings.typeEncoding !== "extension" ? { mapping: [{ identity: "sql", name: "SQLite declared storage type" }] } : {}),
      extension: [
        sqliteContentTypeExtension(),
        ...(name !== table.name ? [{ url: `${EXT}/sql-name`, valueString: table.name }] : []),
        { url: `${EXT}/relation-kind`, valueCode: table.kind },
        { url: `${EXT}/sql-ddl`, valueString: table.ddl },
        ...(table.strict ? [{ url: `${EXT}/sqlite-strict`, valueBoolean: true }] : []),
        ...(table.withoutRowid ? [{ url: `${EXT}/sqlite-without-rowid`, valueBoolean: true }] : []),
        ...foreignKeys,
        ...table.indexes.filter((i) => i.unique && i.origin !== "pk" && !i.partial && i.columns.every((c) => c.name !== null)).map((i) => ({
          url: `${EXT}/unique-key`, extension: i.columns.map((c) => ({ url: "column", valueString: stableName(c.name!, "c_") })),
        })),
        ...table.indexes.map((index) => ({
          url: `${EXT}/sql-index`, valueString: JSON.stringify(index),
        })),
      ],
      differential: { element: elements },
    };
    requireValid(model);
    return { model, table: table.name, columns };
  });
  const resources = [relationBase(), ...bindings.map((b) => b.model)];
  return { bundle: { resourceType: "Bundle", type: "collection", entry: resources.map((resource) => ({ fullUrl: resource.url!, resource })) }, bindings, resources };
}
