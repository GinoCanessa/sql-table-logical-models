import { createHash } from "node:crypto";
import { EXT, RELATION, fail, sqliteContentTypeExtension } from "./fhir.js";
import type { Artifact, FhirObject, Json } from "./fhir.js";
import type { SqlSchema } from "./schema.js";
import { sqliteNameKey } from "./schema.js";

export interface ModelOptions {
  baseUrl?: string;
  version?: string;
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

export function relationBase(): Artifact {
  return {
    resourceType: "StructureDefinition", id: "experimental-relation-base", url: RELATION,
    name: "Relation", title: "Experimental SQL relation", status: "draft", experimental: true,
    fhirVersion: "5.0.0", kind: "logical", abstract: true, type: RELATION,
    baseDefinition: "http://hl7.org/fhir/StructureDefinition/Base", derivation: "specialization",
    description: "Local experimental base for flat SQL relations; not an adopted SQL-on-FHIR artifact.",
    differential: { element: [{ id: "Relation", path: "Relation", min: 0, max: "*" }] },
  };
}

export function createLogicalModels(schema: SqlSchema, options: ModelOptions = {}): {
  bundle: FhirObject; bindings: RelationBinding[]; resources: Artifact[];
} {
  const base = (options.baseUrl ?? "https://example.org/sql").replace(/\/+$/, "");
  if (!/^https?:\/\/[^?#|\s]+$/.test(base)) fail(400, "invalid", "baseUrl must be an absolute HTTP(S) canonical base without query, fragment or version");
  if (options.version !== undefined && (!options.version.trim() || options.version.includes("|"))) fail(400, "invalid", "version must be non-empty and cannot contain '|'");
  const names = new Map(schema.relations.map((r) => [r.name, stableName(r.name, "T_")]));
  const urls = new Map(schema.relations.map((r) => [r.name, `${base}/StructureDefinition/${modelId(r.name)}`]));
  const bindings: RelationBinding[] = schema.relations.map((table) => {
    const name = names.get(table.name)!;
    const url = urls.get(table.name)!;
    const columns = new Map(table.columns.map((c) => [stableName(c.name, "c_"), c.name]));
    const elements: Json[] = [{
      id: name, path: name, min: 0, max: "*", short: `${table.kind} ${table.name}`,
      mapping: [{ identity: "sql", map: table.name }],
    }];
    for (const column of table.columns) {
      const columnName = stableName(column.name, "c_");
      const mapped = sqliteType(column.declaredType);
      const extensions: Json[] = [
        { url: `${EXT}/sql-name`, valueString: column.name },
        { url: `${EXT}/sql-type`, valueString: column.declaredType },
        { url: `${EXT}/sqlite-affinity`, valueCode: mapped.affinity },
      ];
      if (column.primaryKeyPosition) extensions.push({ url: `${EXT}/primary-key-position`, valueInteger: column.primaryKeyPosition });
      if (column.defaultSql !== null) extensions.push({ url: `${EXT}/sql-default`, valueString: column.defaultSql });
      if (column.generated) extensions.push({ url: `${EXT}/generated`, valueCode: column.generated });
      elements.push({
        id: `${name}.${columnName}`, path: `${name}.${columnName}`,
        min: column.nullable ? 0 : 1, max: "1",
        type: [{ code: mapped.fhir }],
        short: column.name,
        comment: [mapped.warning, "FHIR type is a schema-derived hint; SQLite values are not validated or coerced."].filter(Boolean).join(" "),
        extension: extensions,
        mapping: [{ identity: "sql", map: column.declaredType || "(undeclared)" }],
      });
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
      baseDefinition: RELATION, derivation: "specialization",
      description: `Schema-derived ${schema.dialect} ${table.kind}. Physical binding is local configuration, not a portable data URL.`,
      mapping: [{ identity: "sql", name: "SQLite declared storage type" }],
      extension: [
        sqliteContentTypeExtension(),
        { url: `${EXT}/sql-name`, valueString: table.name },
        { url: `${EXT}/relation-kind`, valueCode: table.kind },
        { url: `${EXT}/sql-ddl`, valueString: table.ddl },
        { url: `${EXT}/sqlite-strict`, valueBoolean: table.strict },
        { url: `${EXT}/sqlite-without-rowid`, valueBoolean: table.withoutRowid },
        ...foreignKeys,
        ...table.indexes.map((index) => ({
          url: `${EXT}/sql-index`, valueString: JSON.stringify(index),
        })),
      ],
      differential: { element: elements },
    };
    return { model, table: table.name, columns };
  });
  const resources = [relationBase(), ...bindings.map((b) => b.model)];
  return { bundle: { resourceType: "Bundle", type: "collection", entry: resources.map((resource) => ({ fullUrl: resource.url!, resource })) }, bindings, resources };
}
