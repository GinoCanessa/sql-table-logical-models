import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { array, object } from "../src/fhir.js";
import { readSqliteSchema } from "../src/schema.js";
import { previewTable } from "../src/playground.js";
import type { PlaygroundCatalog, TablePreview } from "../src/playground.js";
import { fixture, serverFixture } from "./helpers.js";

const post = (value: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });

test("playground serves its browser assets and discovers model bindings without exposing database paths", async (t) => {
  const { base, database } = await serverFixture(t, { baseUrl: "https://ginoc.io/comparison", version: "2" });
  const redirect = await fetch(`${base}/playground`, { redirect: "manual" });
  assert.equal(redirect.status, 303);
  assert.equal(redirect.headers.get("Location"), "/playground/");
  for (const [path, media] of [
    ["/playground/", "text/html"], ["/playground/playground.css", "text/css"],
    ["/playground/app.js", "text/javascript"], ["/playground/workspace.js", "text/javascript"],
  ]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200);
    assert.ok(response.headers.get("Content-Type")?.startsWith(media!));
    assert.ok((await response.text()).length > 100);
  }
  const response = await fetch(`${base}/playground/api/catalog`);
  const catalog = await response.json() as PlaygroundCatalog;
  assert.equal(catalog.relations.length, 3);
  assert.equal(catalog.relations.find((r) => r.name === "visit_totals")!.kind, "view");
  const patient = catalog.relations.find((r) => r.name === "patient")!;
  assert.equal(patient.canonical, "https://ginoc.io/comparison/StructureDefinition/patient|2");
  assert.equal(patient.columns[0]!.primaryKeyPosition, 1);
  assert.equal(catalog.artifacts.find((a) => a.reference === patient.modelReference)!.generated, true);
  assert.equal(catalog.artifacts.find((a) => a.id === "active-patients")!.dependency, true);
  assert.equal(catalog.artifacts.find((a) => a.id === "patient-visits")!.dependency, false);
  assert.equal(catalog.artifacts.find((a) => a.id === "experimental-relation-base")!.dependency, false);
  assert.ok(!JSON.stringify(catalog).includes(database));
  const generated = object(await (await fetch(`${base}/playground/api/library`, post({ id: "custom-base", kind: "sql-query", sql: "SELECT 1" }))).json());
  assert.equal(generated.url, "https://ginoc.io/comparison/Library/custom-base");
});

test("table previews page bounded rows and reject unknown relations and invalid limits", async (t) => {
  const { base } = await serverFixture(t, { maxRows: 2 });
  const get = (query: string) => fetch(`${base}/playground/api/rows?${query}`);
  const response = await get("name=visit&limit=1&offset=1");
  assert.equal(response.status, 200);
  const preview = await response.json() as TablePreview;
  assert.equal(preview.rows[0]!.id, 11);
  assert.equal(preview.offset, 1);
  assert.equal(preview.limit, 1);
  assert.equal(preview.mayHaveMore, true);
  const empty = await (await get("name=visit&limit=1&offset=3")).json() as TablePreview;
  assert.deepEqual(empty.rows, []);
  assert.ok(empty.columns.includes("id"));
  assert.equal(empty.mayHaveMore, false);
  for (const query of ["name=patient&limit=3", "name=patient&offset=-1", "name=patient&limit=1bad", "name=patient&limit=1&limit=2", "name=patient&sql=DELETE"]) {
    assert.equal((await get(query)).status, 400, query);
  }
  assert.equal((await get("name=missing")).status, 404);
  const catalog = await (await fetch(`${base}/playground/api/catalog`)).json() as PlaygroundCatalog;
  assert.equal(catalog.pageSize, 2);
});

test("table previews quote actual identifiers instead of treating table names as SQL", (t) => {
  const { database, engine } = fixture(t);
  const db = new DatabaseSync(database);
  db.exec(`CREATE TABLE "odd"";name" (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO "odd"";name" VALUES (1, 'kept');`);
  db.close();
  const result = previewTable(readSqliteSchema(database), engine, new URLSearchParams({ name: 'odd";name', limit: "1" }));
  assert.deepEqual(result.rows, [{ id: 1, value: "kept" }]);
});

test("SQL generates a portable Library which can be saved, reloaded and invoked through FHIR operations", async (t) => {
  const { base } = await serverFixture(t);
  const response = await fetch(`${base}/playground/api/library`, post({
    id: "generated-query", kind: "sql-query", title: "Names by key",
    sql: "SELECT name FROM people WHERE id >= :minimum; -- final",
    dependencies: [{ label: "people", resource: "https://example.org/sql/StructureDefinition/patient" }],
    parameters: [{ name: "minimum", use: "in", type: "integer", min: 1, max: "1" }],
  }));
  assert.equal(response.status, 200);
  const library = object(await response.json());
  const content = object(array(library.content, "content")[0]);
  assert.equal(Buffer.from(String(content.data), "base64").toString("utf8"), "SELECT name FROM people WHERE id >= :minimum; -- final");
  assert.equal(library.url, "https://example.org/sql/Library/generated-query");
  assert.equal((await fetch(`${base}/Library/generated-query`)).status, 404);
  assert.equal((await fetch(`${base}/Library/generated-query`, { ...post(library), method: "PUT" })).status, 201);
  const workspace = object(await (await fetch(`${base}/playground/api/workspace?reference=Library/generated-query`)).json());
  assert.equal(workspace.sql, "SELECT name FROM people WHERE id >= :minimum; -- final");
  assert.equal(workspace.kind, "sql-query");
  const result = await fetch(`${base}/$sql-run`, post({
    resourceType: "Parameters", parameter: [
      { name: "subjectReference", valueReference: { reference: "Library/generated-query" } },
      { name: "parameters", resource: { resourceType: "Parameters", parameter: [{ name: "minimum", valueInteger: 2 }] } },
      { name: "_format", valueCode: "json" },
    ],
  }));
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), [{ name: "Example Two" }]);
});

test("generation rejects malformed metadata and previewed SQL remains read-only", async (t) => {
  const { base } = await serverFixture(t);
  const initial = { id: "test-query", kind: "sql-view", sql: "SELECT 1", dependencies: [], parameters: [] };
  for (const [patch, expected] of [
    [{ id: "invalid_id" }, 400], [{ kind: "query" }, 400], [{ sql: "SELECT 1; SELECT 2" }, 422],
    [{ dependencies: [{ label: "a", resource: "https://example.org/a" }, { label: "A", resource: "https://example.org/b" }] }, 400],
    [{ parameters: [{ name: "x", type: "unsupported", use: "in" }] }, 400],
  ] as const) {
    const response = await fetch(`${base}/playground/api/library`, post({ ...initial, ...patch }));
    assert.equal(response.status, expected);
    assert.equal(object(await response.json()).resourceType, "OperationOutcome");
  }
  const draft = object(await (await fetch(`${base}/playground/api/library`, post({ ...initial, sql: "DELETE FROM patient RETURNING id" }))).json());
  const run = await fetch(`${base}/$sql-run`, post({ resourceType: "Parameters", parameter: [{ name: "subjectResource", resource: draft }] }));
  assert.equal(run.status, 422);
  const unchanged = await (await fetch(`${base}/playground/api/rows?name=patient`)).json() as TablePreview;
  assert.equal(unchanged.rows.length, 2);
});
