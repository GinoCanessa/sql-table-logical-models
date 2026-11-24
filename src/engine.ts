import { constants, DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { SQLInputValue, SQLOutputValue } from "node:sqlite";
import { EXT, SOF, SQLITE_CONTENT_TYPE, SQL_TEXT, OperationError, array, extension, fail, isSqlContentType, object, text } from "./fhir.js";
import type { Artifact, FhirObject, Json } from "./fhir.js";
import type { ModelOptions, RelationBinding } from "./models.js";
import { buildContract, descriptor, normalized } from "./describe.js";
import type { Descriptor, Contract, Projection } from "./describe.js";
import { primitives } from "./relation.js";
import { quoteIdentifier as q, sqliteNameKey } from "./schema.js";
import { Catalog, parameters } from "./store.js";

export interface QueryResult {
  columns: string[];
  rows: Record<string, Json>[];
}

export interface PreparedResult {
  descriptors: Descriptor[];
  contract: Contract;
  issues: FhirObject[];
  rows: Record<string, SQLOutputValue>[];
}

interface BatchSubject { subject: Artifact; parameters?: FhirObject }
interface BatchOptions { context?: Artifact[]; limit?: number }

interface BoundSource { binding: RelationBinding; sql: string }
interface OutputStatement { sql: string; outputs: Map<string, FhirObject>; projections?: Map<string, Projection> }
interface CompileContext {
  lookup(canonical: string): Artifact;
  sourceFor(model: Artifact): BoundSource;
  projections: Map<string, Projection>;
  views: Map<string, OutputStatement>;
}

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
  const outputs = new Map<string, FhirObject>();
  for (const entry of array(resource.parameter, "Library.parameter")) {
    const p = object(entry);
    if (p.use === "out") {
      const name = text(p.name, "Library.parameter.name");
      if (outputs.has(name)) fail(422, "invalid", `Duplicate output parameter: ${name}`);
      if (!primitives.has(String(p.type))) fail(422, "invalid", `Invalid output type for ${name}`);
      outputs.set(name, p);
    } else if (p.use === "in") {
      if (typeof p.name !== "string" || !/^[A-Za-z_]\w*$/.test(p.name) || inputs.some((v) => v.name === p.name)) fail(422, "invalid", `Invalid or duplicate parameter declaration: ${p.name}`);
      if ((p.max !== undefined && p.max !== "1") || (p.min !== undefined && p.min !== 0 && p.min !== 1)) fail(422, "not-supported", "Only scalar input parameters with min 0/1 and max 1 are supported");
      if (!Object.hasOwn(inputFields, String(p.type))) fail(422, "not-supported", `Unsupported parameter type: ${p.type}`);
      inputs.push(p);
    } else fail(422, "invalid", "Library.parameter.use must be in or out");
  }
  return { inputs, outputs };
}

const inputFields: Record<string, string> = {
  string: "valueString", integer: "valueInteger", integer64: "valueInteger64",
  decimal: "valueDecimal", boolean: "valueBoolean", date: "valueDate", dateTime: "valueDateTime",
};
function bind(declared: FhirObject[], supplied: FhirObject | undefined): Record<string, SQLInputValue> {
  const values = supplied ? parameters(supplied) : [];
  const result: Record<string, SQLInputValue> = Object.create(null);
  const names = new Set(declared.map((p) => p.name));
  for (const decl of declared) {
    const name = text(decl.name, "Library.parameter.name");
    const type = text(decl.type, "Library.parameter.type");
    const field = inputFields[type]!;
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
  if (primitive === "boolean") {
    if (value === 0n || value === 0) return false;
    if (value === 1n || value === 1) return true;
    fail(422, "invalid", `${name} cannot be represented as boolean`);
  }
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
    rows: result.rows.map((row) => Object.fromEntries(result.descriptors.map(({ name, primitive, facts }) => {
      const value = jsonValue(row[name]!, name, primitive);
      return [name, facts.max === "*" && value !== null ? [value] : value];
    }))),
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
  snapshots: () => Artifact[] = () => [];

  constructor(
    private readonly database: string,
    readonly catalog: Catalog,
    readonly bindings: RelationBinding[],
    readonly maxRows = 1000,
    readonly settings: ModelOptions & { verifyOutput?: boolean } = {},
  ) {
    if (!Number.isSafeInteger(maxRows) || maxRows < 1) throw new Error("maxRows must be a positive safe integer");
  }

  private compile(resource: Artifact, context: CompileContext, stack: Set<string>): string {
    const { lookup, projections, sourceFor, views } = context;
    const dependency = stack.size !== 0;
    const key = `${resource.resourceType}/${resource.url ?? resource.id}|${resource.version ?? ""}`;
    if (stack.has(key)) fail(422, "invalid", `Dependency cycle: ${[...stack, key].join(" -> ")}`);
    if (stack.size >= 32) fail(422, "too-costly", "Dependency depth exceeds 32");
    const next = new Set(stack).add(key);
    if (resource.resourceType === "StructureDefinition") {
      return sourceFor(resource).sql;
    }
    if (resource.resourceType === "ViewDefinition") {
      for (const unsupported of ["where", "constant", "contained"]) {
        if (resource[unsupported] !== undefined) fail(422, "not-supported", `ViewDefinition.${unsupported} is not implemented`);
      }
      const canonical = text(extension(resource, `${EXT}/source`)?.valueCanonical, "ViewDefinition source extension");
      const model = lookup(canonical);
      if (model.resourceType !== "StructureDefinition") fail(422, "invalid", "ViewDefinition source must be a relation logical model");
      if (resource.resource !== model.name) fail(422, "invalid", "ViewDefinition.resource must match the logical model name");
      const { binding, sql } = sourceFor(model);
      const selects = array(resource.select, "ViewDefinition.select");
      if (!selects.length) fail(422, "required", "ViewDefinition.select is required");
      const names = new Set<string>();
      const columns: string[] = [];
      for (const selectValue of selects) {
        const select = object(selectValue);
        if (Object.keys(select).some((k) => k !== "column")) fail(422, "not-supported", "Only flat select.column projections are implemented");
        for (const colValue of array(select.column, "select.column")) {
          const col = object(colValue);
          if (Object.keys(col).some((k) => !["name", "path", "type", "description", "tag", "collection"].includes(k)) ||
            (col.collection !== undefined && typeof col.collection !== "boolean")) {
            fail(422, "not-supported", "Unsupported ViewDefinition column property");
          }
          const name = text(col.name, "column.name");
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || names.has(name.toLowerCase())) fail(422, "invalid", `Invalid or duplicate column name: ${name}`);
          names.add(name.toLowerCase());
          const path = text(col.path, "column.path");
          const physical = binding.columns.get(path) ?? fail(422, "not-supported", `Only direct logical column paths are implemented: ${path}`);
          const projection = { declaration: col, binding };
          if (dependency) descriptor({ name, column: physical, table: binding.table, type: null, database: "main" }, this.bindings, undefined, projection);
          else projections.set(name, projection);
          columns.push(`source.${q(binding.curated ? path : physical)} AS ${q(name)}`);
        }
      }
      if (!columns.length) fail(422, "required", "At least one projection column is required");
      return `SELECT ${columns.join(", ")} FROM (${sql}) AS source`;
    }
    if (resource.resourceType !== "Library") fail(422, "not-supported", "Unsupported execution subject");
    const kind = libraryKind(resource);
    if (dependency && kind !== "sql-view") fail(422, "invalid", "Only SQLView Libraries may be used as dependencies");
    const declared = dependency ? declarations(resource) : undefined;
    if (declared?.inputs.length) fail(422, "not-supported", "Parameterized SQLView dependencies are not implemented");
    const labels = new Set<string>();
    const ctes: string[] = [];
    for (const value of array(resource.relatedArtifact, "Library.relatedArtifact")) {
      const dep = object(value);
      if (dep.type !== "depends-on") continue;
      const label = text(dep.label, "dependency label");
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(label) || labels.has(label.toLowerCase())) fail(422, "invalid", `Invalid or duplicate dependency label: ${label}`);
      labels.add(label.toLowerCase());
      const target = lookup(text(dep.resource, "dependency canonical"));
      ctes.push(`${q(label)} AS (${this.compile(target, context, next)})`);
    }
    const sql = extractSql(resource);
    if (dependency && parameterNames(sql).size) fail(422, "not-supported", "SQLView dependency placeholders are not supported");
    const compiled = ctes.length ? `WITH ${ctes.join(", ")} SELECT * FROM (${sql})` : sql;
    if (declared && !views.has(key)) views.set(key, { sql: compiled, outputs: declared.outputs });
    return compiled;
  }

  run(subject: Artifact, options: ExecutionOptions = {}): QueryResult {
    return this.runBatch([{ subject, ...(options.parameters ? { parameters: options.parameters } : {}) }], options)[0]!;
  }

  runBatch(subjects: BatchSubject[], options: BatchOptions = {}): QueryResult[] {
    return this.runPreparedBatch(subjects, options).map(jsonResult);
  }

  runPreparedBatch(subjects: BatchSubject[], options: BatchOptions = {}): PreparedResult[] {
    return this.evaluate(subjects, options, false);
  }

  describe(subject: Artifact, options: Pick<BatchOptions, "context"> = {}, issues?: FhirObject[]): Contract {
    const result = this.evaluate([{ subject }], options, true)[0]!;
    issues?.push(...result.issues);
    return result.contract;
  }

  private evaluate(subjects: BatchSubject[], options: BatchOptions, metadataOnly: boolean): PreparedResult[] {
    const context = options.context ?? [];
    const contextUrls = new Set<string>();
    for (const resource of context) {
      const url = text(resource.url, "context.url");
      if (contextUrls.has(url)) fail(400, "invalid", `Duplicate context URL: ${url}`);
      contextUrls.add(url);
    }
    const used = new Set<Artifact>();
    const compiled = subjects.map(({ subject, parameters: supplied }) => {
      const graph = new Map<string, Artifact>();
      const resolved = new Map<string, Artifact>();
      const issues: FhirObject[] = [];
      const observe = (r: Artifact) => {
        if (context.includes(r)) used.add(r);
        graph.set(`${r.resourceType}/${r.id}|${r.url}|${r.version}`, r);
      };
      const projections = new Map<string, Projection>();
      const effective = new Map<Artifact, RelationBinding>();
      const sourceScopes = new Map<string, RelationBinding>();
      const sourceFor = (model: Artifact): BoundSource => {
        const binding = effective.get(model) ?? this.bindings.find((b) => b.model.url === model.url && b.model.version === model.version) ??
          fail(422, "not-found", `No configured physical relation for ${model.url ?? model.id}`);
        if (model !== binding.model && normalized(model) !== normalized(binding.model)) fail(422, "invalid", "Unconfigured replacement for a bound Relation");
        effective.set(model, binding);
        const table = `main.${q(binding.table)}`;
        if (!binding.curated) return { binding, sql: `SELECT * FROM ${table}` };
        // columns() knows the physical table, not which logical dependency read it. Mark this
        // read scope for the authorizer, distinct even from identically named user-authored CTEs.
        const scope = `relation:${randomUUID()}`;
        sourceScopes.set(scope, binding);
        const columns = [...binding.columns].map(([name, physical]) => `${q(physical)} AS ${q(name)}`).join(", ");
        return { binding, sql: `WITH ${q(scope)} AS (SELECT ${columns} FROM ${table}) SELECT ${[...binding.columns.keys()].map(q).join(", ")} FROM ${q(scope)}` };
      };
      if (subject.resourceType !== "Library" && subject.resourceType !== "ViewDefinition") fail(422, "not-supported", "Execution subjects must be Library or ViewDefinition");
      const views = new Map<string, OutputStatement>();
      const lookup = (c: string) => {
        const prior = resolved.get(c);
        if (prior) return prior;
        const r = this.catalog.resolve(c, context, issues, observe, (b) => effective.set(b.model, b));
        resolved.set(c, r);
        observe(r);
        return r;
      };
      const sql = this.compile(subject, { lookup, projections, sourceFor, views }, new Set());
      if (supplied && subject.resourceType !== "Library") fail(400, "invalid", "Query parameters apply only to Library subjects");
      const { inputs, outputs } = declarations(subject);
      const bindings = metadataOnly ? undefined : bind(inputs, supplied);
      for (const name of parameterNames(sql)) {
        if (!inputs.some((p) => `:${p.name}` === name)) fail(422, "invalid", `SQL parameter is not declared: ${name}`);
      }
      return { subject, sql, bindings, outputs, graph, projections, views, effective: [...effective.values()], sourceScopes, issues };
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
      const reads = new Set<string>();
      const origins = new Map<string, Set<string | null>>();
      const trackScopes = compiled.some(({ sourceScopes }) => sourceScopes.size);
      db.setAuthorizer((action, arg1, arg2, _db, scope) => {
        if (action === constants.SQLITE_READ && arg1) {
          reads.add(sqliteNameKey(arg1));
          if (trackScopes && arg2) {
            const key = sqliteNameKey(`${arg1}\0${arg2}`);
            const scopes = origins.get(key) ?? new Set<string | null>();
            origins.set(key, scopes.add(scope));
          }
        }
        if (action === constants.SQLITE_FUNCTION && ["load_extension", "readfile", "writefile"].includes((arg2 ?? "").toLowerCase())) return constants.SQLITE_DENY;
        return [constants.SQLITE_SELECT, constants.SQLITE_READ, constants.SQLITE_FUNCTION, constants.SQLITE_RECURSIVE].includes(action) ?
          constants.SQLITE_OK : constants.SQLITE_DENY;
      });
      const occupied = this.catalog.list(), snapshots = this.snapshots();
      return compiled.map((root) => {
        const { subject, bindings, graph, effective, sourceScopes, issues } = root;
        const prepare = ({ sql, outputs, projections }: OutputStatement) => {
          reads.clear(); origins.clear();
          const statement = db.prepare(sql);
          const descriptors = statement.columns().map((c) => {
            const scopes = origins.get(sqliteNameKey(`${c.table}\0${c.column}`));
            const sources = new Set([...scopes ?? []].map((s) => s ? sourceScopes.get(s) : undefined));
            const source = sources.size === 1 ? [...sources][0] : undefined;
            return descriptor(c, this.bindings, outputs.get(c.name), projections?.get(c.name), source);
          });
          const columns = descriptors.map((c) => c.name);
          if (!columns.length) fail(422, "invalid", "Subject must be a row-producing read-only query");
          if (new Set(descriptors.map((c) => c.facts.name.toLowerCase())).size !== columns.length) {
            fail(422, "invalid", "Duplicate output column names; use explicit SQL aliases");
          }
          for (const name of outputs.keys()) if (!columns.includes(name)) fail(422, "invalid", `Missing declared output column: ${name}`);
          return { statement, descriptors };
        };
        // Postorder insertion puts each view after its dependencies. Only the root is executed.
        for (const view of root.views.values()) prepare(view);
        const { statement, descriptors } = prepare(root);
        const sources = this.bindings.filter((b) => reads.has(sqliteNameKey(b.table))).map((b) => b.model);
        const contract = buildContract(subject, [...graph.values()], sources, descriptors, this.settings, occupied, snapshots, effective);
        const rows: PreparedResult["rows"] = [];
        if (metadataOnly) return { descriptors, contract, rows, issues };
        statement.setReadBigInts(true);
        statement.setAllowBareNamedParameters(false);
        // Declared optional parameters may legitimately not appear in the SQL text.
        statement.setAllowUnknownNamedParameters(true);
        if (options.limit !== 0) {
          for (const row of statement.iterate(bindings!)) {
            if (rows.length >= this.maxRows) fail(422, "too-costly", `Result exceeds ${this.maxRows} rows; supply _limit or narrow the query`);
            rows.push(row);
            if (options.limit !== undefined && rows.length === options.limit) break;
          }
        }
        return { descriptors, contract, rows, issues };
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
