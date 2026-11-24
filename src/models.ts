import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { EXT, RELATION, SOF, SOF_RELATION, SQLITE_CONTENT_TYPE, array, extension, fail, object, sqliteContentTypeExtension, text } from "./fhir.js";
import type { Artifact, FhirObject, Json } from "./fhir.js";
import type { SqlColumn, SqlRelation, SqlSchema } from "./schema.js";
import { sqliteNameKey } from "./schema.js";
import { columnElement, primitiveValue, primitives, relationColumns, requireValid, validBinding } from "./relation.js";
import type { ColumnFacts, TypeEncoding } from "./relation.js";

export interface ModelOptions {
  baseUrl?: string;
  version?: string;
  typeEncoding?: TypeEncoding;
  relationBase?: "local" | "sof";
  integerType?: "integer64" | "integer" | "auto";
  annotations?: FhirObject[];
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
  curated?: boolean;
}

function storageType(sql: string): string {
  // Only known synonyms are interchangeable; retain type parameters (including precision/scale).
  return sql.trim().toUpperCase().replace(/\s+/g, " ").replace(/\s*([(),])\s*/g, "$1")
    .replace(/^(?:INT|TINYINT|SMALLINT|BIGINT|INT2|INT8)\b/, "INTEGER")
    .replace(/^BOOL\b/, "BOOLEAN").replace(/^NUMERIC\b/, "DECIMAL")
    .replace(/^(?:CHARACTER VARYING|VARYING CHARACTER|NVARCHAR)\b/, "VARCHAR").replace(/^(?:NCHAR|CHARACTER)\b/, "CHAR")
    .replace(/^CLOB\b/, "TEXT").replace(/^(?:DOUBLE(?: PRECISION)?|FLOAT)\b/, "REAL").replace(/^TIMESTAMP\b/, "DATETIME");
}

/** Only operator configuration supplies the target. A model contributes a checked projection, never SQL. */
export class ConfiguredRelations {
  private readonly targets = new Map<string, SqlRelation>();

  constructor(config: Record<string, string>, schema: SqlSchema, generated: Artifact[], private readonly integerType: ModelOptions["integerType"]) {
    for (const [key, value] of Object.entries(object(config, "relations"))) {
      if (!/^https?:\/\/[^|?#\s]+\|[^|\s]+$/.test(key) || !URL.canParse(key.split("|")[0]!)) fail(422, "invalid", `Expected an exact canonical|version in relations: ${key}`);
      if (generated.some((r) => `${r.url}|${r.version ?? ""}` === key)) fail(422, "invalid", `Cannot reconfigure generated Relation: ${key}`);
      const name = text(value, `table for ${key}`);
      const matches = schema.relations.filter((r) => r.kind === "table" && sqliteNameKey(r.name) === sqliteNameKey(name));
      if (matches.length !== 1) fail(422, "invalid", `Expected one existing main table for ${key}: ${name}`);
      this.targets.set(key, matches[0]!);
    }
  }

  has(model: Artifact): boolean { return this.targets.has(`${model.url}|${model.version ?? ""}`); }

  bind(model: Artifact): RelationBinding {
    const table = this.targets.get(`${model.url}|${model.version ?? ""}`) ?? fail(422, "not-found", "No configured physical relation");
    const columns = new Map<string, string>(), used = new Set<string>();
    for (const c of relationColumns(model)) {
      const key = sqliteNameKey(c.physicalName);
      const physical = table.columns.find((col) => sqliteNameKey(col.name) === key);
      const at = `${model.name}.${c.name} → ${table.name}.${c.physicalName}`;
      if (!physical || used.has(key)) fail(422, "invalid", `Missing or duplicate physical column: ${at}`);
      const facts = tableColumn(table, physical, this.integerType);
      if (!physical.declaredType.trim() || c.max !== "1" || !c.primitive || c.primitive !== facts.primitive) {
        fail(422, "invalid", `Incompatible or unknown column type/cardinality: ${at} (${physical.declaredType || "untyped"})`);
      }
      if ((c.min && !facts.min) || (c.primaryKey && !facts.primaryKey) || (c.maxLength !== undefined && c.maxLength !== facts.maxLength) ||
        (c.primaryKeyPosition !== undefined && c.primaryKeyPosition !== facts.primaryKeyPosition)) fail(422, "invalid", `Incompatible nullability, length or key: ${at}`);
      for (const m of c.sqlTypes) {
        if ((!m.dialect || m.dialect.toLowerCase() === SQLITE_CONTENT_TYPE || m.dialect === "application/sql") &&
          storageType(m.declaredType) !== storageType(physical.declaredType)) fail(422, "invalid", `Incompatible SQLite mapping: ${at} (${m.declaredType} vs ${physical.declaredType})`);
      }
      columns.set(c.name, physical.name);
      used.add(key);
    }
    return { model, table: table.name, columns, curated: true };
  }
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

function mergeAnnotations(bindings: RelationBinding[], overlays: FhirObject[]) {
  const written = new Map<FhirObject, Map<string, Json>>();
  const touched = new Set<Artifact>();
  const strengths = ["example", "preferred", "extensible", "required"];
  for (const entry of array(overlays, "annotations")) {
    const overlay = object(entry, "partial StructureDefinition");
    const extensions = array(overlay.extension, "overlay.extension").map((x) => object(x));
    const sqlName = (x: FhirObject) => x.url === `${EXT}/sql-name` || x.url === `${SOF}/StructureDefinition/sql-name`;
    const names = extensions.filter(sqlName);
    if (names.length > 1 || (overlay.url === undefined && !names.length)) fail(422, "invalid", "Annotation requires a unique URL or sql-name selector");
    const physical = names.length ? text(names[0]!.valueString, "sql-name") : undefined;
    const matches = bindings.filter((b) => (overlay.url === undefined || b.model.url === overlay.url) && (physical === undefined || b.table === physical));
    if (matches.length !== 1) fail(422, "invalid", `Expected exactly one annotation target: ${overlay.url ?? ""} ${physical ?? ""}`);
    const model = matches[0]!.model;
    touched.add(model);
    const elements = array(object(model.differential).element, "elements").map((e) => object(e));
    const facts = new Map(relationColumns(model).map((c) => [`${model.name}.${c.name}`, c]));
    const merge = (target: FhirObject, patch: FhirObject, level: "model" | "root" | "leaf") => {
      const seen = written.get(target) ?? new Map<string, Json>();
      written.set(target, seen);
      const invalid = (key: string): never => fail(422, "invalid", `Invalid or contradictory annotation at ${target.path ?? model.url}.${key}`);
      const author = (key: string, value: Json, append = false) => {
        if (seen.has(key)) {
          if (!isDeepStrictEqual(seen.get(key), value)) invalid(key);
          return;
        }
        seen.set(key, value);
        const prior = target[key];
        target[key] = append && prior && prior !== value ? `${prior}\n${value}` : structuredClone(value);
      };
      const column = facts.get(String(target.path));
      const primitive = column?.primitive ?? "";
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) invalid(key);
        if (level === "model" && key === "differential") continue;
        if (key === "extension") {
          const entries = array(value, key);
          if (!entries.length) invalid(key);
          for (const x of entries.map((e) => object(e))) {
            if (sqlName(x) && (level === "model" || (column && x.valueString === column.physicalName)) &&
              Object.keys(x).every((k) => ["url", "valueString"].includes(k))) continue;
            if (level === "model" && x.valueBoolean === false && [`${EXT}/sqlite-strict`, `${EXT}/sqlite-without-rowid`].includes(String(x.url)) &&
              Object.keys(x).length === 2 && !extension(target, String(x.url))) continue;
            if (!array(target.extension, key).some((e) => isDeepStrictEqual(e, x))) invalid(key);
          }
          continue;
        }
        if (level !== "model" && key === "mapping") {
          const mappings = [...array(target.mapping, key)];
          const entries = array(value, key);
          if (!entries.length) invalid(key);
          for (const m of entries.map((e) => object(e))) {
            text(m.identity, "mapping.identity"); text(m.map, "mapping.map");
            if (m.identity === "sql") {
              if (Object.keys(m).some((k) => !["identity", "language", "map"].includes(k)) ||
                !column?.sqlTypes.some((s) => s.declaredType === m.map && s.dialect === (m.language ?? SQLITE_CONTENT_TYPE))) invalid(key);
            } else if (!mappings.some((e) => isDeepStrictEqual(e, m))) mappings.push(structuredClone(m));
          }
          if (mappings.length) target.mapping = mappings;
          continue;
        }
        if (level === "leaf" && key === "type") {
          const types = array(value, key).map((e) => object(e));
          const derived = object(array(columnElement(String(model.name), column!, "extension", []).type, key)[0]);
          if (types.length !== 1 || types[0]!.code !== primitive ||
            !Object.entries(types[0]!).every(([k, v]) => isDeepStrictEqual(derived[k], v))) invalid(key);
          continue;
        }
        const prose = level === "model" ? ["description", "title", "copyright", "purpose"] :
          ["short", "definition", "comment", "label", "requirements", ...(level === "leaf" ? ["meaningWhenMissing"] : [])];
        if (prose.includes(key)) {
          author(key, text(value, key), key === "description" || key === "comment");
        } else if (level !== "model" && (["alias", "code", "constraint"].includes(key) || (level === "leaf" && ["condition", "example"].includes(key)))) {
          const items = [...array(target[key], key)], additions = array(value, key);
          if (!additions.length) invalid(key);
          for (const item of additions) {
            if (key === "alias" || key === "condition") text(item, key);
            else {
              const o = object(item, key);
              if (key === "code") {
                text(o.code, "code.code");
                if (Object.entries(o).some(([k, v]) => k === "userSelected" ? typeof v !== "boolean" :
                  !["system", "version", "code", "display"].includes(k) || typeof v !== "string")) invalid(key);
              }
              if (key === "example") {
                text(o.label, "example.label");
                const field = `value${primitive[0]!.toUpperCase()}${primitive.slice(1)}`;
                if (!primitiveValue(primitive, o[field]) || Object.keys(o).some((k) => k !== field && k !== "label")) invalid(key);
              }
              if (key === "constraint") {
                text(o.key, "constraint.key"); text(o.human, "constraint.human");
                if (o.severity !== "error" && o.severity !== "warning") invalid(key);
              }
            }
            if (!items.some((i) => isDeepStrictEqual(i, item))) {
              if (key === "example" && items.some((i) => object(i).label === object(item).label)) invalid(key);
              items.push(structuredClone(item));
            }
          }
          target[key] = items;
        } else if (level === "leaf" && key === "binding") {
          const b = object(value, "binding");
          const prior = target.binding === undefined ? undefined : object(target.binding);
          const next = { ...prior, ...b };
          if (!validBinding(primitive, next) || Object.keys(b).length === 0 || Object.keys(b).some((k) => !["strength", "valueSet", "description"].includes(k)) ||
            (b.description !== undefined && typeof b.description !== "string") ||
            (prior?.description !== undefined && b.description !== undefined && b.description !== prior.description) ||
            (prior && (prior.valueSet !== next.valueSet || strengths.indexOf(String(prior.strength)) > strengths.indexOf(String(next.strength)))) ||
            (next.strength === "required" && prior?.strength !== "required")) invalid(key);
          target[key] = next;
        } else if (level === "leaf" && /^(?:fixed|minValue|maxValue)[A-Z]/.test(key) && target[key] === undefined) {
          author(key, value!);
        } else if (level === "model" && ["status", "version", "keyword", "useContext", "jurisdiction"].includes(key)) {
          if (key === "status" && !["draft", "active", "retired", "unknown"].includes(String(value))) invalid(key);
          if (key === "version" && (text(value, key).includes("|") || (target.version !== undefined && target.version !== value))) invalid(key);
          if (["keyword", "useContext", "jurisdiction"].includes(key)) array(value, key).forEach((v) => object(v, key));
          author(key, value!);
        } else if (!(level === "leaf" && key === "mustHaveValue" && !target.mustHaveValue && value === false) &&
          !(Object.hasOwn(target, key) && isDeepStrictEqual(target[key], value))) invalid(key);
      }
    };
    merge(model, overlay, "model");
    if (overlay.differential !== undefined) {
      const diff = object(overlay.differential);
      if (!Array.isArray(diff.element) || !diff.element.length || Object.keys(diff).length !== 1) fail(422, "invalid", "Expected annotation differential.element paths");
      const paths = new Set<string>();
      for (const item of diff.element) {
        const patch = object(item), path = text(patch.path, "annotation path");
        const found = elements.filter((e) => e.path === path);
        if (paths.has(path) || found.length !== 1) fail(422, "invalid", `Unmatched or ambiguous annotation path: ${path}`);
        paths.add(path);
        merge(found[0]!, patch, found[0] === elements[0] ? "root" : "leaf");
      }
    }
  }
  for (const model of touched) {
    requireValid(model);
    for (const item of array(object(model.differential).element, "element").slice(1)) {
      const e = object(item);
      const primitive = String(object(array(e.type, "type")[0]).code);
      const suffix = primitive[0]!.toUpperCase() + primitive.slice(1);
      const comparable = (v: Json | undefined) => v === undefined ? undefined : primitive === "integer64" ? BigInt(String(v)) :
        typeof v === "number" ? v : String(v);
      const min = comparable(e[`minValue${suffix}`]), max = comparable(e[`maxValue${suffix}`]), fixed = comparable(e[`fixed${suffix}`]);
      if ((min !== undefined && max !== undefined && min > max) || (fixed !== undefined &&
        ((min !== undefined && fixed < min) || (max !== undefined && fixed > max) ||
          (typeof e.maxLength === "number" && typeof fixed === "string" && [...fixed].length > e.maxLength)))) {
        fail(422, "invalid", `Contradictory value constraints: ${e.path}`);
      }
    }
  }
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
  if (options.annotations !== undefined) mergeAnnotations(bindings, options.annotations);
  const resources = [relationBase(), ...bindings.map((b) => b.model)];
  return { bundle: { resourceType: "Bundle", type: "collection", entry: resources.map((resource) => ({ fullUrl: resource.url!, resource })) }, bindings, resources };
}
