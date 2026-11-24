import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { setImmediate } from "node:timers/promises";
import { OperationError, SQL_TEXT, array, object, sqlLibrary } from "../src/fhir.js";
import type { Artifact, FhirObject } from "../src/fhir.js";
import { fixture, sample } from "./helpers.js";
import { ArtifactStore } from "../src/store.js";
import { extractSql, singleStatement } from "../src/engine.js";
import { ExportJobs } from "../src/exports.js";
import { join } from "node:path";
import { checkRows, checkWire } from "../src/conformance.js";
import { formatResult } from "../src/operations.js";

const errorCode = (status: number) => (error: unknown) => error instanceof OperationError && error.status === status;

test("canonical relations, ViewDefinition and nested SQLViews compose with bound parameters", (t) => {
  const { engine, catalog } = fixture(t);
  const result = engine.run(catalog.get("Library/patient-visits"), {
    parameters: { resourceType: "Parameters", parameter: [{ name: "minimum_cost", valueDecimal: 25 }] },
  });
  assert.deepEqual(result.rows, [{ patient_id: "1", patient_name: "Example One", visit_id: "10", occurred_on: "2026-01-10", cost: 40.5 }]);
  assert.equal(engine.run(catalog.get("Library/patient-visits")).rows.length, 2);
  const model = engine.bindings.find((b) => b.table === "visit_totals")!.model;
  assert.deepEqual(engine.run(sqlLibrary("totals", "SELECT visit_count FROM totals ORDER BY patient_id", [{ label: "totals", resource: model.url! }])).rows, [
    { visit_count: 2 }, { visit_count: 1 },
  ]);
});

test("missing/ambiguous dependencies, cycles and unsupported ViewDefinition features fail explicitly", (t) => {
  const { engine, catalog, store } = fixture(t);
  assert.throws(() => engine.run(sqlLibrary("missing", "SELECT * FROM t", [{ label: "t", resource: "https://example.org/missing" }])), errorCode(404));
  const view = sqlLibrary("cycle", "SELECT * FROM itself", [{ label: "itself", resource: "https://example.org/sql/Library/cycle" }], "sql-view");
  store.put(view);
  assert.throws(() => engine.run(view), /Dependency cycle/);
  const v1 = sqlLibrary("version-one", "SELECT 1", [], "sql-view");
  v1.url = "https://example.org/shared";
  v1.version = "1";
  store.put(v1);
  store.put({ ...v1, id: "version-two", version: "2" });
  assert.throws(() => catalog.resolve(v1.url!), errorCode(409));
  assert.equal(catalog.resolve(`${v1.url}|2`).version, "2");
  assert.equal(catalog.resolve(`${v1.url}|1`, [{ ...v1, id: "inline-override" }]).id, "inline-override");
  const projection = sample("patient-projection");
  projection.where = [{ path: "active = true" }];
  assert.throws(() => engine.run(projection), /not implemented/);
});

test("read-only enforcement rejects mutations, pragmas, file attachment and multiple statements", (t) => {
  const { engine, database } = fixture(t);
  for (const sql of [
    "DELETE FROM patient RETURNING id", "UPDATE patient SET name = 'changed' RETURNING id",
    "PRAGMA user_version = 3", "ATTACH DATABASE ':memory:' AS other", "SELECT load_extension('anything')",
    "SELECT 1; DELETE FROM patient", "SELECT 1; SELECT 2", "CREATE TEMP TABLE hidden(x)",
  ]) {
    assert.throws(() => engine.run(sqlLibrary("unsafe", sql, [])), errorCode(422), sql);
  }
  const db = new DatabaseSync(database, { readOnly: true });
  try { assert.equal(db.prepare("SELECT COUNT(*) AS n FROM patient").get()!.n, 2); }
  finally { db.close(); }
  assert.equal(singleStatement("SELECT ';--' AS x; -- final comment"), "SELECT ';--' AS x");
  assert.equal(singleStatement('SELECT "a;""b" /* comment */'), 'SELECT "a;""b"');
  assert.throws(() => singleStatement("SELECT 1 /*"), /Unterminated/);
});

test("parameters reject undeclared placeholders and wrong types without interpolating input", (t) => {
  const { engine } = fixture(t);
  const query = sqlLibrary("bound", "SELECT :search AS value", []);
  query.parameter = [{ name: "search", type: "string", use: "in", min: 1, max: "1" }];
  const supplied = (value: FhirObject) => ({ parameters: { resourceType: "Parameters", parameter: [{ name: "search", ...value }] } });
  assert.deepEqual(engine.run(query, supplied({ valueString: "'; DROP TABLE patient; --" })).rows, [{ value: "'; DROP TABLE patient; --" }]);
  assert.throws(() => engine.run(query), errorCode(400));
  assert.throws(() => engine.run(query, supplied({ valueInteger: 2 })), errorCode(400));
  assert.throws(() => engine.run(sqlLibrary("unbound", "SELECT :not_declared", [])), /not declared/);
  assert.throws(() => engine.run(sqlLibrary("positional", "SELECT ?", [])), /Only :name/);
  assert.deepEqual(engine.run(sqlLibrary("literal", "SELECT ':not_a_parameter' AS value", [])).rows, [{ value: ":not_a_parameter" }]);
});

test("row caps, zero limits, empty result columns, BLOBs and large integers retain exact output shapes", (t) => {
  const { engine } = fixture(t, 2);
  const query = sqlLibrary("rows", "SELECT id FROM visit ORDER BY id", []);
  assert.throws(() => engine.run(query), /exceeds 2 rows/);
  assert.deepEqual(engine.run(query, { limit: 1 }).rows, [{ id: "10" }]);
  assert.deepEqual(engine.run(query, { limit: 0 }), { columns: ["id"], rows: [] });
  assert.throws(() => engine.run(query, { limit: 3 }), errorCode(400));
  assert.deepEqual(engine.run(sqlLibrary("empty", "SELECT name FROM patient WHERE 0", [])), { columns: ["name"], rows: [] });
  assert.deepEqual(engine.run(sqlLibrary("values", "SELECT 9223372036854775807 AS big, x'00ff' AS bytes, NULL AS missing", [])).rows,
    [{ big: "9223372036854775807", bytes: "AP8=", missing: null }]);
});

test("prepared origins survive aliases and output declarations are not input placeholders", (t) => {
  const { engine } = fixture(t);
  const view = sqlLibrary("declared", "SELECT id AS original FROM patient", [], "sql-view");
  view.version = "1";
  view.parameter = [{ use: "out", name: "original", type: "integer64" }];
  const subject = sqlLibrary("mixed", "SELECT dep.original AS alias, :n + 1 AS expr, 1 AS unknown FROM dep JOIN again USING (original) ORDER BY alias", [
    { label: "dep", resource: view.url! }, { label: "again", resource: `${view.url}|1` },
  ]);
  subject.parameter = [{ use: "out", name: "expr", type: "integer64" }, { use: "in", name: "n", type: "integer" }];
  const parameters = { resourceType: "Parameters", parameter: [{ name: "n", valueInteger: 4 }] };
  const prepare = t.mock.method(DatabaseSync.prototype, "prepare");
  const result = engine.runPreparedBatch([{ subject, parameters }], { context: [view], limit: 0 })[0]!;
  assert.equal(prepare.mock.calls.filter((call) => call.arguments[0] === extractSql(view)).length, 1);
  assert.deepEqual(result.descriptors.map(({ name, table, column, type, primitive }) => [name, table, column, type, primitive]), [
    ["alias", "patient", "id", "INTEGER", "integer64"], ["expr", null, null, null, "integer64"], ["unknown", null, null, null, undefined],
  ]);
  assert.deepEqual(engine.run(subject, { parameters, context: [view], limit: 1 }).rows, [{ alias: "1", expr: "5", unknown: 1 }]);
  const outputOnly = sqlLibrary("output-only", "SELECT :n AS n", []);
  outputOnly.parameter = [{ use: "out", name: "n", type: "integer" }];
  assert.throws(() => engine.run(outputOnly), /not declared/);
  assert.throws(() => engine.run(outputOnly, { parameters }), /Undeclared query parameter/);
  const implicit = sqlLibrary("declared", "SELECT :n AS original", [], "sql-view");
  implicit.version = "1";
  assert.throws(() => engine.describe(subject, { context: [implicit] }), /dependency placeholders/);
});

test("an outer projection cannot hide duplicate logical names or an unsupported cardinality", (t) => {
  const { engine } = fixture(t);
  const duplicate = sqlLibrary("duplicate", "SELECT id AS key, name AS KEY FROM patient", [], "sql-view");
  const cardinality = sqlLibrary("cardinality", "SELECT id AS key FROM patient", [], "sql-view");
  cardinality.parameter = [{ name: "key", use: "out", type: "integer64", max: "2" }];
  for (const [view, reason] of [[duplicate, /Duplicate output column names/], [cardinality, /Unsupported output cardinality: key/]] as const) {
    const subject = sqlLibrary("consumer", "SELECT key FROM src", [{ label: "src", resource: view.url! }]);
    assert.throws(() => engine.describe(view), reason);
    assert.throws(() => engine.describe(subject, { context: [view] }), reason);
  }
});

test("a batch holds a single SQLite snapshot when another connection changes the source between subjects", (t) => {
  const { engine, database } = fixture(t);
  const writer = new DatabaseSync(database);
  writer.exec("PRAGMA journal_mode = WAL");
  const secondSql = "SELECT COUNT(*) AS n FROM patient WHERE 1";
  const originalPrepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function (sql: string) {
    if (sql === secondSql) writer.exec("INSERT INTO patient VALUES (3, 'Concurrent example', 1)");
    return originalPrepare.call(this, sql);
  };
  try {
    const results = engine.runBatch([
      { subject: sqlLibrary("first", "SELECT COUNT(*) AS n FROM patient", []) },
      { subject: sqlLibrary("second", secondSql, []) },
    ]);
    assert.deepEqual(results.map((r) => r.rows), [[{ n: 2 }], [{ n: 2 }]]);
    assert.equal(writer.prepare("SELECT COUNT(*) AS n FROM patient").get()!.n, 3);
  } finally {
    DatabaseSync.prototype.prepare = originalPrepare;
    writer.close();
  }
});

test("context entries must be unique and used across the complete subject graph", (t) => {
  const { engine } = fixture(t);
  const view = sqlLibrary("provided", "SELECT 1 AS one", [], "sql-view");
  const root = sqlLibrary("root", "SELECT * FROM provided", [{ label: "provided", resource: view.url! }]);
  assert.throws(() => engine.run(sqlLibrary("unused", "SELECT 1", []), { context: [view] }), /did not match/);
  assert.throws(() => engine.run(root, { context: [view, view] }), /Duplicate context/);
  const results = engine.runBatch([{ subject: sqlLibrary("independent", "SELECT 2 AS two", []) }, { subject: root }], { context: [view] });
  assert.deepEqual(results[1]!.rows, [{ one: 1 }]);
});

test("completed exports survive reopen and interrupted exports become explicit failures", async (t) => {
  const { engine, directory } = fixture(t);
  const path = join(directory, "jobs.sqlite");
  const jobs = new ExportJobs(path, engine);
  const subject = sqlLibrary("exported", "SELECT 1 AS one", []);
  const request = { subject, context: [], format: "json" as const, header: true, envelope: false };
  const complete = jobs.start([{ name: "result", request }], "http://localhost");
  await setImmediate();
  assert.equal(jobs.get(complete).state, "complete");
  const interrupted = jobs.start([{ name: "pending", request }], "http://localhost");
  jobs.close();
  const reopened = new ExportJobs(path, engine);
  try {
    assert.equal(reopened.get(complete).files["result.json"]!.body, '[{"one":1}]');
    assert.equal(reopened.get(interrupted).state, "failed");
    assert.equal(reopened.get(interrupted).errorStatus, 500);
    assert.equal(reopened.get(interrupted).result!.resourceType, "OperationOutcome");
  } finally { reopened.close(); }
});

test("reopening a legacy completed job neither rewrites its manifest nor invents a model snapshot", (t) => {
  const { engine, directory } = fixture(t);
  const path = join(directory, "legacy.sqlite");
  const db = new DatabaseSync(path);
  const job = { state: "complete", result: { resourceType: "Parameters", parameter: [{ name: "output", part: [
    { name: "name", valueString: "old" }, { name: "location", valueUri: "urn:example:old" },
  ] }] }, files: { "old.json": { contentType: "application/json", body: '[{"n":7}]' } } };
  try {
    db.exec("CREATE TABLE export_jobs (id TEXT PRIMARY KEY, json TEXT NOT NULL)");
    db.prepare("INSERT INTO export_jobs VALUES (?, ?)").run("old", JSON.stringify(job));
  } finally { db.close(); }
  const jobs = new ExportJobs(path, engine);
  try {
    assert.deepEqual(jobs.get("old"), job);
    assert.deepEqual(jobs.snapshots(), []);
  } finally { jobs.close(); }
});

test("artifact persistence and SQL attachment consistency survive round trips", (t) => {
  const { store, artifacts } = fixture(t);
  const query = sqlLibrary("persisted", "SELECT 1 AS one", []);
  store.put(query);
  const reopened = new ArtifactStore(artifacts);
  try { assert.deepEqual(reopened.get("Library", "persisted"), query); }
  finally { reopened.close(); }
  assert.equal(extractSql(query), "SELECT 1 AS one");
  const content = object(array(query.content, "content")[0]);
  content.extension = [{ url: SQL_TEXT, valueString: "SELECT 2" }];
  (query as Artifact).content = [content];
  assert.throws(() => extractSql(query), /disagree/);
});

test("SQL execution prefers the SQLite attachment over default and other dialect variants regardless of order", (t) => {
  const { engine } = fixture(t);
  const query = sqlLibrary("variants", "SELECT 'sqlite' AS chosen", []);
  const sqlite = object(array(query.content, "content")[0]);
  query.content = [
    { contentType: "application/sql", data: Buffer.from("SELECT 'default' AS chosen").toString("base64") },
    { contentType: "application/sql;dialect=postgresql", data: Buffer.from("SELECT 'postgresql'::text AS chosen").toString("base64") },
    sqlite,
  ];
  assert.equal(extractSql(query), "SELECT 'sqlite' AS chosen");
  assert.deepEqual(engine.run(query).rows, [{ chosen: "sqlite" }]);
  sqlite.extension = [{ url: SQL_TEXT, valueString: "SELECT 'different' AS chosen" }];
  assert.throws(() => engine.run(query), /disagree/);
});

test("SQL execution retains legacy default attachments but rejects libraries containing only nonmatching dialects", (t) => {
  const { engine } = fixture(t);
  const query = sqlLibrary("legacy", "SELECT 0", []);
  const postgresql = { contentType: "application/sql;dialect=postgresql", data: Buffer.from("SELECT 'postgresql'::text AS chosen").toString("base64") };
  query.content = [
    postgresql,
    { contentType: "application/sql", extension: [{ url: SQL_TEXT, valueString: "SELECT 'legacy' AS chosen" }] },
  ];
  assert.deepEqual(engine.run(query).rows, [{ chosen: "legacy" }]);
  query.content = [postgresql];
  assert.throws(() => engine.run(query), {
    status: 422, code: "not-supported", message: /SQLite or default SQL content/,
  });
});

test("conformance checks ordered descriptors, exact primitive cells, collections and CSV record boundaries", (t) => {
  const { engine } = fixture(t);
  const query = sqlLibrary("verified", "SELECT 0 AS i, 0 AS flag, x'00ff' AS bytes, 7 AS wide, NULL AS optional, 'four' AS label, 1 AS unknown", []);
  query.parameter = Object.entries({ i: "integer", flag: "boolean", bytes: "base64Binary", wide: "integer64", optional: "string", label: "string" })
    .reverse().map(([name, type]) => ({ name, type, use: "out", min: name === "optional" ? 0 : 1, max: name === "label" ? "*" : "1" }));
  const result = engine.runPreparedBatch([{ subject: query }])[0]!;
  const model = result.contract.model;
  const { columns, rows } = engine.run(query);
  assert.deepEqual(rows, [{ i: 0, flag: false, bytes: "AP8=", wide: "7", optional: null, label: ["four"], unknown: 1 }]);
  assert.deepEqual(checkRows(model, rows, columns).map((i) => i.severity), ["information"]);
  const row = rows[0]!;
  assert.deepEqual(checkRows(model, [Object.fromEntries(Object.entries(row).reverse())], columns), checkRows(model, rows, columns));
  const missing = Object.fromEntries(Object.entries(row).slice(1));
  for (const bad of [missing, Object.assign(Object.create(row), missing), { ...row, extra: "" },
    { ...row, i: "0" }, { ...row, i: 2147483648 }, { ...row, flag: 0 }, { ...row, bytes: "!" }, { ...row, wide: 7 },
    { ...row, wide: "9223372036854775808" }, { ...row, label: "four" }, { ...row, label: [""] }, { ...row, label: [null] }, { ...row, flag: null }]) {
    assert.ok(checkRows(model, [bad]).some((i) => i.severity === "error"), JSON.stringify(bad));
  }
  assert.ok(checkRows(model, [], columns.slice(1)).some((i) => i.severity === "error"));
  assert.ok(checkRows(model, rows, columns.toReversed()).some((i) => i.severity === "error"));
  const empty = engine.runPreparedBatch([{ subject: query }], { limit: 0 })[0]!;
  for (const format of ["json", "ndjson", "csv"] as const) {
    const wire = formatResult(result, format, true);
    assert.deepEqual(checkWire(model, result, wire, format, true).map((i) => i.severity), ["information"]);
    assert.ok(checkWire(model, result, wire.replace("four", "five"), format, true).some((i) => i.severity === "error"));
    for (const header of [true, false]) {
      const body = format === "json" ? "[]" : format === "csv" && header ? columns.join(",") + "\r\n" : "";
      assert.equal(formatResult(empty, format, header), body);
      assert.deepEqual(checkWire(model, empty, body, format, header).map((i) => i.severity), ["information"]);
    }
    const reversed = { ...empty, descriptors: empty.descriptors.toReversed() };
    assert.ok(checkWire(model, reversed, format === "json" ? "[]" : "", format, false).some((i) => i.severity === "error"));
  }
  const exact = sqlLibrary("exact", "SELECT 9223372036854775807 AS amount", []);
  exact.parameter = [{ name: "amount", use: "out", type: "decimal" }];
  const decimal = engine.runPreparedBatch([{ subject: exact }])[0]!;
  assert.throws(() => formatResult(decimal, "json", false), /lossless finite JSON/);
  assert.deepEqual(checkWire(decimal.contract.model, decimal, "9223372036854775807\r\n", "csv", false), []);
});

test("wire checks distinguish physical member and record order even for escaped and numeric aliases", (t) => {
  const { engine } = fixture(t);
  const query = sqlLibrary("order", `SELECT 'A' AS "la""bel", 'B' AS "2025" UNION ALL SELECT 'C,"D"' || char(10) || 'E', 'F'`, []);
  const result = engine.runPreparedBatch([{ subject: query }])[0]!;
  const publicResult = engine.run(query);
  const first = String.raw`{"la\"bel":"A","2025":"B"}`, second = String.raw`{"la\"bel":"C,\"D\"\nE","2025":"F"}`;
  const reversedFirst = String.raw`{"2025":"B","la\"bel":"A"}`, reversedSecond = String.raw`{"2025":"F","la\"bel":"C,\"D\"\nE"}`;
  const header = '"la""bel",2025\r\n', csv = 'A,B\r\n"C,""D""\nE",F\r\n';
  for (const [format, withHeader, valid, corrupt] of [
    ["json", true, `[${first},${second}]`, [`[${reversedFirst},${second}]`, `[${second},${first}]`, `[${first}]`]],
    ["ndjson", true, `${first}\n${second}\n`, [`${reversedFirst}\n${second}\n`, `${first}\n${reversedSecond}\n`]],
    ["csv", true, header + csv, ['2025,"la""bel"\r\n' + csv]],
    ["csv", false, csv, [csv.replace("A,B", "B,A")]],
  ] as const) {
    for (const input of [result, publicResult]) assert.equal(formatResult(input, format, withHeader), valid);
    const errors = (body: string) => checkWire(result.contract.model, result, body, format, withHeader).filter((i) => i.severity === "error");
    assert.deepEqual(errors(valid), []);
    for (const body of corrupt) assert.ok(errors(body).length, body);
  }
});
