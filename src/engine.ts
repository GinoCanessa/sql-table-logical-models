import { constants, DatabaseSync } from "node:sqlite";
import type { SQLInputValue, SQLOutputValue, StatementColumnMetadata } from "node:sqlite";
import { EXT, SOF, SQLITE_CONTENT_TYPE, SQL_TEXT, OperationError, array, extension, fail, isSqlContentType, object, text } from "./fhir.js";
import type { Artifact, FhirObject, Json } from "./fhir.js";
import type { RelationBinding } from "./models.js";
import { sqliteType } from "./models.js";
import { readRelation } from "./relation.js";
import { quoteIdentifier as q, sqliteNameKey } from "./schema.js";
import { Catalog, parameters } from "./store.js";

export interface QueryResult {
  columns: string[];
  rows: Record<string, Json>[];
}

export interface PreparedResult {
  descriptors: (StatementColumnMetadata & { primitive?: string })[];
  rows: Record<string, SQLOutputValue>[];
}

interface BatchSubject { subject: Artifact; parameters?: FhirObject }
interface BatchOptions { context?: Artifact[]; limit?: number }

export interface ExecutionOptions {
  context?: Artifact[];
  parameters?: FhirObject;
  limit?: number;
}

export function libraryKind(resource: Artifact): "sql-query" | "sql-view" {
  const coding = array(object(resource.type, "Library.type").coding, "Library.type.coding").map((c) => object(c));
  const code = coding.find((c) => c.system === `${SOF}/CodeSystem/LibraryTypesCodes`)?.code;
  if (code !== "sql-query" && code !== "sql-view") fail(422, "not-supported", "Library.type must declare sql-query or sql-view using the SQL-on-FHIR code system");
  return code;
}

// Remove comments and a final delimiter without silently accepting a second statement.
export function singleStatement(sql: string): string {
  let output = "";
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]!;
    if (c === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      output += "\n";
    } else if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end < 0) fail(422, "invalid", "Unterminated SQL comment");
      i = end + 1;
      output += " ";
    } else if ("'\"`[".includes(c)) {
      const endQuote = c === "[" ? "]" : c;
      output += c;
      let closed = false;
      while (++i < sql.length) {
        output += sql[i];
        if (sql[i] === endQuote) {
          if (c !== "[" && sql[i + 1] === endQuote) output += sql[++i];
          else { closed = true; break; }
        }
      }
      if (!closed) fail(422, "invalid", "Unterminated SQL quoted value");
    } else {
      output += c;
    }
  }
  output = output.trim();
  if (output.endsWith(";")) output = output.slice(0, -1).trimEnd();
  // Delimiters inside quoted values were preserved; scan them separately.
  let quote = "";
  for (let i = 0; i < output.length; i++) {
    const c = output[i]!;
    if (quote) {
      if (c === quote) {
        if (quote !== "]" && output[i + 1] === quote) i++;
        else quote = "";
      }
    } else if ("'\"`[".includes(c)) quote = c === "[" ? "]" : c;
    else if (c === ";") fail(422, "invalid", "Exactly one SQL statement is allowed");
  }
  return output || fail(422, "invalid", "SQL text is empty");
}

export function extractSqlText(resource: Artifact): string {
  const contents = array(resource.content, "Library.content").map((c) => object(c));
  const content = contents.find((c) => c.contentType === SQLITE_CONTENT_TYPE) ??
    contents.find((c) => c.contentType === "application/sql");
  if (!content) {
    if (contents.some((c) => isSqlContentType(c.contentType))) fail(422, "not-supported", "Library has no SQLite or default SQL content attachment");
    fail(422, "invalid", `Library requires ${SQLITE_CONTENT_TYPE} or application/sql content`);
  }
  if (content.url !== undefined) fail(422, "not-supported", "Remote SQL attachments are not fetched");
  const readable = extension(content, SQL_TEXT)?.valueString;
  let decoded: string | undefined;
  if (content.data !== undefined) {
    const data = text(content.data, "content.data");
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) fail(422, "invalid", "content.data is not base64");
    decoded = Buffer.from(data, "base64").toString("utf8");
  }
  if (readable !== undefined && decoded !== undefined && readable !== decoded) {
    fail(422, "invalid", "sql-text and content.data disagree");
  }
  return text(readable ?? decoded, "SQL content");
}

export function extractSql(resource: Artifact): string {
  return singleStatement(extractSqlText(resource));
}

function declarations(resource: Artifact) {
  const inputs: FhirObject[] = [];
  const outputs = new Map<string, string>();
  for (const entry of array(resource.parameter, "Library.parameter")) {
    const p = object(entry);
    if (p.use === "out") {
      const name = text(p.name, "Library.parameter.name");
      if (outputs.has(name)) fail(422, "invalid", `Duplicate output parameter: ${name}`);
      outputs.set(name, text(p.type, "Library.parameter.type"));
    } else if (p.use === "in") inputs.push(p);
    else fail(422, "invalid", "Library.parameter.use must be in or out");
  }
  return { inputs, outputs };
}

function bind(declared: FhirObject[], supplied: FhirObject | undefined): Record<string, SQLInputValue> {
  const values = supplied ? parameters(supplied) : [];
  const result: Record<string, SQLInputValue> = Object.create(null);
  const fields: Record<string, string> = {
    string: "valueString", integer: "valueInteger", integer64: "valueInteger64",
    decimal: "valueDecimal", boolean: "valueBoolean", date: "valueDate", dateTime: "valueDateTime",
  };
  const names = new Set<string>();
  for (const decl of declared) {
    const name = text(decl.name, "Library.parameter.name");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || names.has(name)) fail(422, "invalid", `Invalid or duplicate parameter declaration: ${name}`);
    names.add(name);
    if (decl.use !== "in" || decl.max === "*" || (decl.max !== undefined && decl.max !== "1") ||
      (decl.min !== undefined && decl.min !== 0 && decl.min !== 1)) fail(422, "not-supported", "Only scalar input parameters with min 0/1 and max 1 are supported");
    const type = text(decl.type, "Library.parameter.type");
    const field = Object.hasOwn(fields, type) ? fields[type]! : fail(422, "not-supported", `Unsupported parameter type: ${type}`);
    const matches = values.filter((p) => p.name === name);
    if (matches.length > 1) fail(400, "invalid", `Duplicate query parameter: ${name}`);
    const entry = matches[0];
    if (!entry) {
      if (decl.min === 1) fail(400, "required", `Missing query parameter: ${name}`);
      result[`:${name}`] = null;
      continue;
    }
    const keys = Object.keys(entry).filter((k) => k !== "name");
    if (keys.length !== 1 || keys[0] !== field) fail(400, "invalid", `${name} expects ${field}`);
    const value = entry[field];
    if (type === "boolean") {
      if (typeof value !== "boolean") fail(400, "invalid", `${name} must be boolean`);
      result[`:${name}`] = value ? 1 : 0;
    } else if (type === "integer64") {
      if (typeof value !== "string" || !/^-?\d+$/.test(value)) fail(400, "invalid", `${name} expects an integer64 string`);
      const integer = BigInt(value);
      if (integer < -(2n ** 63n) || integer > 2n ** 63n - 1n) fail(400, "invalid", `${name} exceeds SQLite signed 64-bit range`);
      result[`:${name}`] = integer;
    } else if (type === "integer" || type === "decimal") {
      if (typeof value !== "number" || !Number.isFinite(value) ||
        (type === "integer" && (!Number.isInteger(value) || value < -2147483648 || value > 2147483647))) {
        fail(400, "invalid", `${name} has an invalid ${type} value`);
      }
      result[`:${name}`] = value;
    } else {
      result[`:${name}`] = text(value, name);
    }
  }
  for (const value of values) {
    if (!names.has(String(value.name))) fail(400, "invalid", `Undeclared query parameter: ${String(value.name)}`);
  }
  return result;
}

function jsonValue(value: SQLOutputValue, name: string, primitive?: string): Json {
  if (value === null) return null;
  if (primitive === "integer64" || primitive === "integer") {
    if (typeof value !== "bigint" && !(typeof value === "number" && Number.isSafeInteger(value))) {
      fail(422, "invalid", `${name} cannot be represented as ${primitive}`);
    }
    const integer = BigInt(value);
    if (primitive === "integer64") return integer.toString();
    if (integer < -2147483648n || integer > 2147483647n) fail(422, "invalid", `${name} exceeds the integer range`);
    return Number(integer);
  }
  if (primitive === "decimal") {
    if ((typeof value !== "number" && typeof value !== "bigint") || !Number.isFinite(Number(value)) ||
      (typeof value === "bigint" && !Number.isSafeInteger(Number(value)))) fail(422, "invalid", `${name} cannot be represented as a lossless finite JSON number`);
    return Number(value);
  }
  if (typeof value === "bigint") return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(value) : value.toString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  if (typeof value === "number" && !Number.isFinite(value)) fail(422, "invalid", "Non-finite SQL result cannot be represented in JSON");
  return value;
}

export function jsonResult(result: PreparedResult): QueryResult {
  return {
    columns: result.descriptors.map((c) => c.name),
    rows: result.rows.map((row) => Object.fromEntries(result.descriptors.map(({ name, primitive }) =>
      [name, jsonValue(row[name]!, name, primitive)]))),
  };
}

function parameterNames(sql: string): Set<string> {
  const names = new Set<string>();
  let quote = "";
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]!;
    if (quote) {
      if (c === quote) {
        if (quote !== "]" && sql[i + 1] === quote) i++;
        else quote = "";
      }
    } else if ("'\"`[".includes(c)) quote = c === "[" ? "]" : c;
    else if (":@$?".includes(c)) {
      if (c !== ":") fail(422, "not-supported", "Only :name SQL parameter placeholders are supported");
      const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(i + 1))?.[0] ??
        fail(422, "invalid", "Invalid SQL parameter placeholder");
      names.add(`:${name}`);
      i += name.length;
    }
  }
  return names;
}

export class QueryEngine {
  private readonly originTypes = new Map<string, Map<string, string | undefined>>();

  constructor(
    private readonly database: string,
    readonly catalog: Catalog,
    readonly bindings: RelationBinding[],
    readonly maxRows = 1000,
  ) {
    if (!Number.isSafeInteger(maxRows) || maxRows < 1) throw new Error("maxRows must be a positive safe integer");
    for (const binding of bindings) {
      const relation = readRelation(binding.model);
      if (relation) this.originTypes.set(sqliteNameKey(binding.table), new Map(relation.columns.map((c) =>
        [sqliteNameKey(binding.columns.get(c.name) ?? c.physicalName), c.primitive])));
    }
  }

  private compile(resource: Artifact, lookup: (canonical: string) => Artifact, stack: Set<string>, dependency = false): string {
    const key = `${resource.resourceType}/${resource.url ?? resource.id}|${resource.version ?? ""}`;
    if (stack.has(key)) fail(422, "invalid", `Dependency cycle: ${[...stack, key].join(" -> ")}`);
    if (stack.size >= 32) fail(422, "too-costly", "Dependency depth exceeds 32");
    const next = new Set(stack).add(key);
    if (resource.resourceType === "StructureDefinition") {
      const binding = this.bindings.find((b) => b.model.url === resource.url && b.model.version === resource.version) ??
        fail(422, "not-found", `No configured physical relation for ${resource.url ?? resource.id}`);
      return `SELECT * FROM main.${q(binding.table)}`;
    }
    if (resource.resourceType === "ViewDefinition") {
      for (const unsupported of ["where", "constant", "contained"]) {
        if (resource[unsupported] !== undefined) fail(422, "not-supported", `ViewDefinition.${unsupported} is not implemented`);
      }
      const canonical = text(extension(resource, `${EXT}/source`)?.valueCanonical, "ViewDefinition source extension");
      const model = lookup(canonical);
      if (model.resourceType !== "StructureDefinition") fail(422, "invalid", "ViewDefinition source must be a relation logical model");
      if (resource.resource !== model.name) fail(422, "invalid", "ViewDefinition.resource must match the logical model name");
      const binding = this.bindings.find((b) => b.model.url === model.url && b.model.version === model.version) ??
        fail(422, "not-found", "No configured relation for ViewDefinition source");
      const selects = array(resource.select, "ViewDefinition.select");
      if (!selects.length) fail(422, "required", "ViewDefinition.select is required");
      const names = new Set<string>();
      const columns: string[] = [];
      for (const selectValue of selects) {
        const select = object(selectValue);
        if (Object.keys(select).some((k) => k !== "column")) fail(422, "not-supported", "Only flat select.column projections are implemented");
        for (const colValue of array(select.column, "select.column")) {
          const col = object(colValue);
          if (Object.keys(col).some((k) => !["name", "path", "type", "description"].includes(k))) {
            fail(422, "not-supported", "Unsupported ViewDefinition column property");
          }
          const name = text(col.name, "column.name");
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || names.has(name.toLowerCase())) fail(422, "invalid", `Invalid or duplicate column name: ${name}`);
          names.add(name.toLowerCase());
          const path = text(col.path, "column.path");
          const physical = binding.columns.get(path) ?? fail(422, "not-supported", `Only direct logical column paths are implemented: ${path}`);
          columns.push(`source.${q(physical)} AS ${q(name)}`);
        }
      }
      if (!columns.length) fail(422, "required", "At least one projection column is required");
      return `SELECT ${columns.join(", ")} FROM (${this.compile(model, lookup, next)}) AS source`;
    }
    if (resource.resourceType !== "Library") fail(422, "not-supported", "Unsupported execution subject");
    const kind = libraryKind(resource);
    if (dependency && kind !== "sql-view") fail(422, "invalid", "Only SQLView Libraries may be used as dependencies");
    if (dependency && declarations(resource).inputs.length) fail(422, "not-supported", "Parameterized SQLView dependencies are not implemented");
    const labels = new Set<string>();
    const ctes: string[] = [];
    for (const value of array(resource.relatedArtifact, "Library.relatedArtifact")) {
      const dep = object(value);
      if (dep.type !== "depends-on") continue;
      const label = text(dep.label, "dependency label");
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(label) || labels.has(label.toLowerCase())) fail(422, "invalid", `Invalid or duplicate dependency label: ${label}`);
      labels.add(label.toLowerCase());
      const target = lookup(text(dep.resource, "dependency canonical"));
      ctes.push(`${q(label)} AS (${this.compile(target, lookup, next, true)})`);
    }
    const sql = extractSql(resource);
    return ctes.length ? `WITH ${ctes.join(", ")} SELECT * FROM (${sql})` : sql;
  }

  run(subject: Artifact, options: ExecutionOptions = {}): QueryResult {
    return this.runBatch([{ subject, ...(options.parameters ? { parameters: options.parameters } : {}) }], options)[0]!;
  }

  runBatch(subjects: BatchSubject[], options: BatchOptions = {}): QueryResult[] {
    return this.runPreparedBatch(subjects, options).map(jsonResult);
  }

  runPreparedBatch(subjects: BatchSubject[], options: BatchOptions = {}): PreparedResult[] {
    const context = options.context ?? [];
    const contextUrls = new Set<string>();
    for (const resource of context) {
      const url = text(resource.url, "context.url");
      if (contextUrls.has(url)) fail(400, "invalid", `Duplicate context URL: ${url}`);
      contextUrls.add(url);
    }
    const resolved = new Map<string, Artifact>();
    const used = new Set<Artifact>();
    const lookup = (canonical: string) => {
      let resource = resolved.get(canonical);
      if (!resource) {
        resource = this.catalog.resolve(canonical, context);
        resolved.set(canonical, resource);
        if (context.includes(resource)) used.add(resource);
      }
      return resource;
    };
    const compiled = subjects.map(({ subject, parameters: supplied }) => {
      if (subject.resourceType !== "Library" && subject.resourceType !== "ViewDefinition") fail(422, "not-supported", "Execution subjects must be Library or ViewDefinition");
      const sql = this.compile(subject, lookup, new Set());
      if (supplied && subject.resourceType !== "Library") fail(400, "invalid", "Query parameters apply only to Library subjects");
      const { inputs, outputs } = declarations(subject);
      const bindings = bind(inputs, supplied);
      for (const name of parameterNames(sql)) {
        if (!Object.hasOwn(bindings, name)) fail(422, "invalid", `SQL parameter is not declared: ${name}`);
      }
      return { sql, bindings, outputs };
    });
    for (const resource of context) {
      if (!used.has(resource)) fail(400, "invalid", `Context artifact did not match a dependency: ${resource.url}`);
    }
    if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 0 || options.limit > this.maxRows)) {
      fail(400, "invalid", `_limit must be an integer from 0 to ${this.maxRows}`);
    }
    const db = new DatabaseSync(this.database, { readOnly: true, allowExtension: false });
    try {
      db.exec("BEGIN");
      db.setAuthorizer((action, _arg1, arg2) => {
        if (action === constants.SQLITE_FUNCTION && ["load_extension", "readfile", "writefile"].includes((arg2 ?? "").toLowerCase())) return constants.SQLITE_DENY;
        return [constants.SQLITE_SELECT, constants.SQLITE_READ, constants.SQLITE_FUNCTION, constants.SQLITE_RECURSIVE].includes(action) ?
          constants.SQLITE_OK : constants.SQLITE_DENY;
      });
      return compiled.map(({ sql, bindings, outputs }) => {
        const statement = db.prepare(sql);
        const descriptors = statement.columns().map((c) => {
          const physical = c.table !== null && c.column !== null ?
            this.originTypes.get(sqliteNameKey(c.table))?.get(sqliteNameKey(c.column)) : undefined;
          const primitive = physical ?? (c.type ? sqliteType(c.type).fhir : outputs.get(c.name));
          return { ...c, ...(primitive ? { primitive } : {}) };
        });
        const columns = descriptors.map((c) => c.name);
        if (!columns.length) fail(422, "invalid", "Subject must be a row-producing read-only query");
        if (new Set(columns).size !== columns.length) fail(422, "invalid", "Duplicate output column names; use explicit SQL aliases");
        statement.setReadBigInts(true);
        statement.setAllowBareNamedParameters(false);
        // Declared optional parameters may legitimately not appear in the SQL text.
        statement.setAllowUnknownNamedParameters(true);
        const rows: PreparedResult["rows"] = [];
        if (options.limit !== 0) {
          for (const row of statement.iterate(bindings)) {
            if (rows.length >= this.maxRows) fail(422, "too-costly", `Result exceeds ${this.maxRows} rows; supply _limit or narrow the query`);
            rows.push(row);
            if (options.limit !== undefined && rows.length === options.limit) break;
          }
        }
        return { descriptors, rows };
      });
    } catch (error) {
      if (error instanceof OperationError) throw error;
      if (error instanceof Error && "code" in error && error.code === "ERR_SQLITE_ERROR") {
        fail(422, "invalid", `SQL evaluation failed: ${error.message}`);
      }
      throw error;
    } finally {
      db.close();
    }
  }
}
