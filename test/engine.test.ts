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

const errorCode = (status: number) => (error: unknown) => error instanceof OperationError && error.status === status;

test("canonical relations, ViewDefinition and nested SQLViews compose with bound parameters", (t) => {
  const { engine, catalog } = fixture(t);
  const result = engine.run(catalog.get("Library/patient-visits"), {
    parameters: { resourceType: "Parameters", parameter: [{ name: "minimum_cost", valueDecimal: 25 }] },
  });
  assert.deepEqual(result.rows, [{ patient_id: 1, patient_name: "Example One", visit_id: 10, occurred_on: "2026-01-10", cost: 40.5 }]);
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
  assert.deepEqual(engine.run(query, { limit: 1 }).rows, [{ id: 10 }]);
  assert.deepEqual(engine.run(query, { limit: 0 }), { columns: ["id"], rows: [] });
  assert.throws(() => engine.run(query, { limit: 3 }), errorCode(400));
  assert.deepEqual(engine.run(sqlLibrary("empty", "SELECT name FROM patient WHERE 0", [])), { columns: ["name"], rows: [] });
  assert.deepEqual(engine.run(sqlLibrary("values", "SELECT 9223372036854775807 AS big, x'00ff' AS bytes, NULL AS missing", [])).rows,
    [{ big: "9223372036854775807", bytes: "AP8=", missing: null }]);
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
