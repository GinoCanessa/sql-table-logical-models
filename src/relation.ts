import { BINARY_CONTENT_MODEL, EXT, OperationError, RELATION, SOF, SOF_RELATION, SQL_CONTENT_TYPE_SYSTEM, array, extension, object, text } from "./fhir.js";
import type { Artifact, FhirObject } from "./fhir.js";

export type TypeEncoding = "mapping" | "extension" | "both";
export const primitives = new Set("base64Binary boolean canonical code date dateTime decimal id instant integer integer64 markdown oid positiveInt string time unsignedInt uri url uuid xhtml".split(" "));
const stringLike = new Set("canonical code id markdown oid string uri url uuid xhtml".split(" "));
export const unknownResult = "Unknown result type: SQLite reports no declared type and the subject declares none.";
export const hasRelationBase = (model: Artifact) => [RELATION, SOF_RELATION].includes(String(model.baseDefinition).split("|")[0]!);
export interface ColumnFacts {
  name: string;
  physicalName: string;
  primitive?: string;
  sqlTypes: { declaredType: string; dialect?: string }[];
  min: number;
  max: string;
  mustHaveValue: boolean;
  warning?: string;
  maxLength?: number;
  primaryKey: boolean;
  primaryKeyPosition?: number;
}

export function columnElement(root: string, column: ColumnFacts, encoding: TypeEncoding, extensions: FhirObject[]): FhirObject {
  const path = `${root}.${column.name}`;
  const type = { code: column.primitive };
  const sqlTypes = column.sqlTypes;
  if (column.physicalName !== column.name) extensions.push({ url: `${EXT}/sql-name`, valueString: column.physicalName });
  if (column.primaryKeyPosition) extensions.push({ url: `${EXT}/primary-key-position`, valueInteger: column.primaryKeyPosition });
  return {
    id: path, path, short: column.physicalName, min: column.min, max: column.max,
    ...(column.mustHaveValue ? { mustHaveValue: true } : {}),
    ...(column.maxLength !== undefined ? { maxLength: column.maxLength } : {}),
    ...(column.warning ? { comment: column.warning } : {}),
    ...(extensions.length ? { extension: extensions } : {}),
    ...(column.primitive ? { type: [{ ...type, ...(encoding !== "mapping" && sqlTypes.length ? {
      extension: sqlTypes.map(({ declaredType, dialect }) => ({
        url: `${EXT}/sql-type`, extension: [
          { url: "dialect", valueCoding: { system: SQL_CONTENT_TYPE_SYSTEM, code: dialect } },
          { url: "type", valueString: declaredType },
        ],
      })),
    } : {}) }] } : {}),
    ...(encoding !== "extension" && sqlTypes.length ? {
      mapping: sqlTypes.map(({ declaredType, dialect }) => ({ identity: "sql", language: dialect, map: declaredType })),
    } : {}),
  };
}

const record = (v: unknown): v is FhirObject => !!v && typeof v === "object" && !Array.isArray(v);
const entries = (v: unknown): FhirObject[] => Array.isArray(v) ? v.filter(record) : [];
const vocabulary = (name: string, url: unknown) => url === `${EXT}/${name}` || url === `${SOF}/StructureDefinition/${name}`;
const canonicalUri = (v: unknown): v is string => typeof v === "string" && /^[a-z][\w+.-]*:[^\s|]+(?:\|[^\s|]+)?$/i.test(v);
export function validBinding(primitive: string, binding: FhirObject): boolean {
  return ["code", "string", "uri"].includes(primitive) && ["required", "extensible", "preferred", "example"].includes(String(binding.strength)) &&
    canonicalUri(binding.valueSet) && URL.canParse(binding.valueSet.split("|")[0]!);
}

/** JSON representation, not terminology membership or arbitrary FHIRPath validation. */
export function primitiveValue(type: string, value: unknown): boolean {
  switch (type) {
    case "boolean": return typeof value === "boolean";
    case "integer": case "unsignedInt": case "positiveInt":
      return typeof value === "number" && Number.isInteger(value) && value <= 2147483647 &&
        value >= (type === "integer" ? -2147483648 : type === "positiveInt" ? 1 : 0);
    case "integer64": return typeof value === "string" && /^-?(0|[1-9]\d{0,18})$/.test(value) &&
      BigInt.asIntN(64, BigInt(value)) === BigInt(value);
    case "decimal": return typeof value === "number" && Number.isFinite(value);
    case "base64Binary": return typeof value === "string" && Buffer.from(value, "base64").toString("base64") === value;
    default: return primitives.has(type) && typeof value === "string";
  }
}

/** Validate a known Relation. Ancestry resolution belongs to the catalog, not the validator. */
export function validateRelation(model: Artifact): FhirObject[] {
  const issues: FhirObject[] = [];
  const report = (path: string, diagnostics: string, severity = "error") => {
    issues.push({ severity, code: severity === "information" ? "informational" : "invalid", diagnostics,
      expression: [`StructureDefinition.${path}`] });
  };
  const base = [RELATION, SOF_RELATION].includes(String(model.url));
  for (const [field, expected] of Object.entries({ kind: "logical", derivation: "specialization", abstract: base, type: model.url })) {
    if (expected === undefined || model[field] !== expected) report(field, `${field} must equal ${String(expected)}`);
  }
  if (!canonicalUri(model.baseDefinition)) report("baseDefinition", "A Relation requires a canonical base definition");
  if (!canonicalUri(model.url)) report("url", "A Relation requires a canonical URL");
  if (model.fhirVersion !== undefined && model.fhirVersion !== "5.0.0") report("fhirVersion", "Relation vocabulary uses FHIR 5.0.0");
  for (const key of ["context", "contextInvariant", "modifierExtension"]) if (key in model) report(key, `${key} is not permitted`);
  if ("snapshot" in model) report("snapshot", "Snapshot ignored; differential is authoritative", "warning");
  const ext = entries(model.extension);
  if (ext.some((e) => vocabulary("relation-source", e.url))) {
    report("extension", "relation-source retained; no data is fetched or bound.", "information");
  }
  const result = ext.some((e) => vocabulary("relation-kind", e.url) && e.valueCode === "result");
  const differential = record(model.differential) ? model.differential : {};
  const elements = Array.isArray(differential.element) ? differential.element : [];
  if (!elements.length || (!base && elements.length === 1)) report("differential.element", "A Relation needs a root and concrete Relations need columns");
  const root = record(elements[0]) ? elements[0].path : undefined;
  const seen = new Set<string>(), keys = new Set<string>();
  const conditions: [string, unknown][] = [];
  const common = "id path min max short definition comment label alias code requirements constraint extension mapping".split(" ");
  elements.forEach((value, i) => {
    const at = `differential.element[${i}]`;
    const error = (field: string, message: string) => report(`${at}.${field}`, message);
    if (!record(value)) { report(at, "Expected an element"); return; }
    const e = value;
    const path = String(e.path ?? "");
    if (i === 0 ? path !== model.name || !/^[A-Za-z_]\w*$/.test(path) :
      !path.startsWith(`${root}.`) || !/^[A-Za-z_]\w*$/.test(path.slice(String(root).length + 1))) error("path", "Expected a flat SQL-safe path under the named root");
    if (seen.has(path.toLowerCase())) error("path", `Duplicate element: ${path}`);
    seen.add(path.toLowerCase());
    if (e.id !== undefined && path !== e.id) error("id", "Element id must equal path");
    const allowed = new Set([...common, ...(i ? "mustHaveValue meaningWhenMissing type example condition orderMeaning binding maxLength base isSummary".split(" ") : [])]);
    for (const k of Object.keys(e)) {
      if (!allowed.has(k) && !(i && /^(?:fixed|minValue|maxValue)[A-Z]/.test(k))) error(k, `${k} is not permitted on a Relation ${i ? "column" : "root"}`);
    }
    for (const k of ["base", "isSummary"]) if (i && k in e) report(`${at}.${k}`, `${k} ignored`, "warning");
    for (const k of ["constraint", "mapping", "extension", "condition", "type"]) {
      if (k in e && (!Array.isArray(e[k]) || (k !== "condition" && !e[k].every(record)))) error(k, `Invalid ${k} list`);
    }
    for (const c of entries(e.constraint)) {
      if (typeof c.key !== "string" || !c.key.trim() || keys.has(c.key)) error("constraint", "Constraint key must be present and locally unique");
      else keys.add(c.key);
    }
    if (Array.isArray(e.condition)) for (const c of e.condition) conditions.push([`${at}.condition`, c]);
    for (const x of entries(e.extension)) {
      if (!(i && ["sql-name", "primary-key", "primary-key-position", "generated", "sql-default", "origin"].some((k) => vocabulary(k, x.url)))) {
        error("extension", `Unsupported element extension: ${String(x.url)}`);
      }
    }
    const physicalNames = entries(e.extension).filter((x) => vocabulary("sql-name", x.url));
    if (physicalNames.length > 1 || physicalNames.some((x) => typeof x.valueString !== "string" || !x.valueString.length)) {
      error("extension", "Expected at most one physical column name, a nonempty string");
    }
    if (!i) {
      if ((e.min !== undefined && e.min !== 0) || (e.max !== undefined && e.max !== "*")) error("min", "Root cardinality must be 0..*");
      if (entries(e.mapping).some((m) => m.identity === "sql")) error("mapping", "No root SQL mapping");
      return;
    }
    const min = e.min === undefined ? 0 : e.min, max = e.max === undefined ? "1" : e.max;
    if (min !== 0 && min !== 1) error("min", "Column min must be 0 or 1");
    if (max !== "1" && max !== "*") error("max", "Column max must be 1 or *");
    if (e.mustHaveValue !== undefined && (typeof e.mustHaveValue !== "boolean" || (e.mustHaveValue && min !== 1))) error("mustHaveValue", "mustHaveValue requires min=1");
    if ("orderMeaning" in e && max !== "*") error("orderMeaning", "Only collections have orderMeaning");
    const types = entries(e.type), primitive = String(types[0]?.code ?? "");
    const sqlTypes = new Map<string, string>();
    const inherited = ext.find((x) => vocabulary("sql-content-type", x.url))?.valueCoding;
    const sqlType = (field: string, type: unknown, dialect: unknown) => {
      if (typeof type !== "string" || !type.trim() || (dialect !== undefined && (typeof dialect !== "string" || !/^application\/sql(?:;dialect=[\w-]+)?$/.test(dialect)))) {
        error(field, "Expected a SQL type and SQL dialect"); return;
      }
      const key = String(dialect ?? "");
      if (sqlTypes.has(key) && sqlTypes.get(key) !== type) error(field, "Contradictory SQL types for one dialect");
      sqlTypes.set(key, type);
    };
    for (const m of entries(e.mapping)) if (m.identity === "sql") sqlType("mapping", m.map, m.language ?? (record(inherited) ? inherited.code : undefined));
    if (!(result && e.type === undefined && typeof e.comment === "string" && /\b(unknown|unresolved|undetermined)\b/i.test(e.comment)) &&
      (types.length !== 1 || !primitives.has(primitive))) error("type", "Expected exactly one known primitive type");
    for (const type of types) {
      for (const k of Object.keys(type)) if (!["code", "extension", "id"].includes(k)) error(`type.${k}`, `Unsupported type.${k}`);
      for (const x of entries(type.extension)) {
        if (!vocabulary("sql-type", x.url)) {
          error("type.extension", x.url === BINARY_CONTENT_MODEL ? "binary-content-model is not a primitive annotation" : "Unsupported primitive annotation");
          continue;
        }
        const parts = entries(x.extension);
        const coding = parts.find((p) => p.url === "dialect")?.valueCoding;
        if (!record(coding) || typeof coding.code !== "string") error("type.extension", "sql-type requires a dialect Coding");
        else sqlType("type.extension", parts.find((p) => p.url === "type")?.valueString, coding.code);
      }
    }
    if (max === "*" && !result && ![...sqlTypes].some(([dialect, sql]) =>
      dialect !== "application/sql;dialect=sqlite" && /\[\]$|\bARRAY\b/i.test(sql))) error("max", "Collection requires a result declaration or SQL array");
    for (const k of Object.keys(e).filter((k) => /^(?:fixed|minValue|maxValue)[A-Z]/.test(k))) {
      const suffix = k.replace(/^(fixed|minValue|maxValue)/, "");
      if (suffix !== primitive[0]?.toUpperCase() + primitive.slice(1) || !primitiveValue(primitive, e[k])) error(k, `${k} must match column type ${primitive}`);
    }
    if ("maxLength" in e && (!stringLike.has(primitive) || typeof e.maxLength !== "number" || !Number.isSafeInteger(e.maxLength) || e.maxLength < 0)) error("maxLength", "Length requires a string-like type and nonnegative integer");
    if (e.binding !== undefined) {
      const b = record(e.binding) ? e.binding : {};
      if (!validBinding(primitive, b)) error("binding", "Binding requires an applicable primitive, strength and ValueSet canonical");
    }
  });
  for (const [path, key] of conditions) if (!keys.has(String(key))) report(path, "condition must reference a local constraint key");
  return issues;
}

export function requireValid(model: Artifact): void {
  const errors = validateRelation(model).filter((i) => i.severity === "error");
  if (errors.length) throw new OperationError(422, "invalid", String(errors[0]!.diagnostics), errors);
}

function draftExtension(value: FhirObject, name: string) {
  return extension(value, `${EXT}/${name}`) ?? extension(value, `${SOF}/StructureDefinition/${name}`);
}

/** Interpret columns after Relation ancestry has been established. */
export function relationColumns(model: Artifact): ColumnFacts[] {
  const dialectCoding = draftExtension(model, "sql-content-type")?.valueCoding;
  const dialect = dialectCoding && object(dialectCoding).code;
  const differential = model.differential === undefined ? {} : object(model.differential);
  const elements = array(differential.element, "differential.element").map((e) => object(e));
  return elements.slice(1).map((element): ColumnFacts => {
    const path = text(element.path, "column.path");
    const name = path.slice(path.lastIndexOf(".") + 1);
    const physical = draftExtension(element, "sql-name")?.valueString;
    const typeEntry = array(element.type, "column.type")[0];
    const type = typeEntry === undefined ? {} : object(typeEntry);
    const sqlTypes: ColumnFacts["sqlTypes"] = [];
    const add = (declared: unknown, language: unknown) => {
      if (typeof declared !== "string" || !declared || sqlTypes.some((s) => s.declaredType === declared && s.dialect === language)) return;
      sqlTypes.push({ declaredType: declared, ...(typeof language === "string" ? { dialect: language } : {}) });
    };
    for (const m of array(element.mapping, "column.mapping").map((v) => object(v))) {
      if (m.identity === "sql") add(m.map, m.language ?? dialect);
    }
    for (const e of array(type.extension, "type.extension").map((v) => object(v))) {
      if (!vocabulary("sql-type", e.url)) continue;
      const coding = extension(e, "dialect")?.valueCoding;
      add(extension(e, "type")?.valueString, coding && object(coding).code);
    }
    const position = extension(element, `${EXT}/primary-key-position`)?.valueInteger;
    return {
      name, physicalName: typeof physical === "string" ? physical : name,
      ...(typeof type.code === "string" ? { primitive: type.code } : {}), sqlTypes,
      min: typeof element.min === "number" ? element.min : 0, max: typeof element.max === "string" ? element.max : "1",
      mustHaveValue: element.mustHaveValue === true,
      ...(typeof element.comment === "string" ? { warning: element.comment } : {}),
      ...(typeof element.maxLength === "number" ? { maxLength: element.maxLength } : {}),
      primaryKey: typeof position === "number" || draftExtension(element, "primary-key")?.valueBoolean === true,
      ...(typeof position === "number" ? { primaryKeyPosition: position } : {}),
    };
  });
}

/** Interpret a direct Relation without normalizing or dereferencing the stored resource. */
export function readRelation(model: Artifact): { columns: ColumnFacts[]; issues: FhirObject[] } | undefined {
  if (model.resourceType !== "StructureDefinition" || !hasRelationBase(model)) return undefined;
  const issues: FhirObject[] = [];
  if (draftExtension(model, "relation-source")) issues.push({
    severity: "information", code: "informational", diagnostics: "relation-source retained; no data is fetched or bound.",
    expression: ["StructureDefinition.extension"],
  });
  return { columns: relationColumns(model), issues };
}
