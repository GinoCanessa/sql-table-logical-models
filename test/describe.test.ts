import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { EXT, SQLITE_CONTENT_TYPE, array, extension, object, sqlLibrary } from "../src/fhir.js";
import type { Artifact, FhirObject } from "../src/fhir.js";
import { readRelation, validateRelation } from "../src/relation.js";
import { fixture, postBody, sample, serverFixture } from "./helpers.js";

const parts = (...parameter: FhirObject[]) => ({ resourceType: "Parameters", parameter });
const inline = (resource: Artifact) => ({ name: "subjectResource", resource });
const leaves = (r: Artifact) => array(object(r.differential).element, "elements").slice(1).map((e) => object(e));

test("describe prepares but never steps or binds; pinned subject and inline context use ordinary resolution", async (t) => {
  const { base, store, database } = await serverFixture(t);
  const path = base + "/$sql-describe";
  const view = sqlLibrary("calculation", "SELECT abs(-9223372036854775808) AS n", [], "sql-view");
  const query = sqlLibrary("needs-input", "SELECT n, :input AS declared FROM calcs", [{ label: "calcs", resource: view.url! }]);
  query.version = "V1";
  query.parameter = [{ name: "input", use: "in", type: "integer", min: 1 }, { name: "declared", use: "out", type: "integer", min: 1, documentation: "Declared result" }];
  store.put(query);
  const initial = store.list();
  const request = parts({ name: "subjectCanonical", valueCanonical: query.url + "|V1" }, { name: "context", resource: view });
  const response = await fetch(path, postBody(request));
  assert.equal(response.status, 200);
  const model = await response.json() as Artifact;
  assert.deepEqual(validateRelation(model), []);
  assert.equal(extension(model, `${EXT}/describes`)?.valueCanonical, query.url + "|V1");
  const [unknown, declared] = leaves(model);
  assert.ok(!unknown!.type && !unknown!.mapping && /unknown/i.test(String(unknown!.comment)));
  assert.equal(declared!.definition, "Declared result");
  assert.deepEqual([declared!.min, declared!.mustHaveValue], [1, true]);
  const noValue = await fetch(base + "/$sql-run", postBody(request));
  assert.equal(noValue.status, 400); assert.match(await noValue.text(), /Missing query parameter/);
  const stepped = await fetch(base + "/$sql-run", postBody(parts(inline(view))));
  assert.equal(stepped.status, 422); assert.match(await stepped.text(), /integer overflow/i);
  for (const extra of [{ name: "_limit", valueInteger: 0 }, { name: "parameters", resource: parts() }, { name: "header", valueBoolean: true }]) {
    assert.equal((await fetch(path, postBody(parts(inline(view), extra)))).status, 400);
  }
  assert.equal((await fetch(path + "?_format=sql", postBody(parts(inline(view))))).status, 400);
  const unsupported = await fetch(path, postBody(parts(inline(view), { name: "dialect", valueCode: "application/sql;dialect=ansi-sql" })));
  assert.equal(unsupported.status, 422); assert.match(await unsupported.text(), /not-supported/);
  for (const sql of ["SELECT 1 AS n, 2 AS n", "SELECT 1; SELECT 2", "DELETE FROM patient RETURNING id"]) {
    assert.equal((await fetch(path, postBody(parts(inline(sqlLibrary("bad", sql, [])))))).status, 422);
  }
  assert.equal((await fetch(path + "?subjectReference=StructureDefinition/patient")).status, 422);
  assert.deepEqual(store.list(), initial);
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM patient").get()!.n, 2);
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map((r) => r.name), ["patient", "visit"]);
  } finally { db.close(); }
});

test("projection and Library nullability differ; returned DDL provisions only the client's empty destination", async (t) => {
  const { base } = await serverFixture(t, { verifyOutput: true });
  for (const [ref, names, types, required] of [
    ["Library/patient-visits", ["patient_id", "patient_name", "visit_id", "occurred_on", "cost"], ["integer64", "string", "integer64", "date", "decimal"], false],
    ["ViewDefinition/patient-projection", ["patient_id", "patient_name", "active"], ["integer64", "string", "boolean"], true],
  ] as const) {
    const path = `${base}/$sql-describe?subjectReference=${ref}`;
    const response = await fetch(path); assert.equal(response.status, 200);
    const model = await response.json() as Artifact;
    assert.deepEqual(validateRelation(model), []);
    const facts = readRelation(model)!.columns;
    assert.deepEqual(facts.map((c) => c.name), names);
    assert.deepEqual(facts.map((c) => c.primitive), types);
    assert.ok(facts.every((c) => c.min === Number(required) && c.mustHaveValue === required));
    assert.match(String(extension(leaves(model)[0]!, `${EXT}/origin`)?.valueUri), /StructureDefinition\/patient#patient.id$/);
    if (!required) assert.equal(facts.at(-1)!.sqlTypes[0]?.declaredType, "DECIMAL(10,2)");
    const ddl = await (await fetch(path + "&_format=sql")).text();
    assert.equal(ddl, extension(model, `${EXT}/sql-ddl`)?.valueString);
    const destination = new DatabaseSync(":memory:");
    try {
      destination.exec(ddl);
      const info = destination.prepare("SELECT name, type, \"notnull\" AS required FROM pragma_table_info(?) ORDER BY cid").all(String(model.name));
      assert.deepEqual(info.map((r) => [r.name, r.type, r.required]), facts.map((c) => [c.physicalName, c.sqlTypes[0]!.declaredType, c.min]));
    } finally { destination.close(); }
  }
  const ref = `${base}/$sql-run?subjectReference=ViewDefinition/patient-projection&_format=`;
  assert.deepEqual((await (await fetch(ref + "json")).json() as FhirObject[]).map((r) => r.active), [true, false]);
  assert.equal(await (await fetch(ref + "csv")).text(), "patient_id,patient_name,active\r\n1,Example One,1\r\n2,Example Two,0\r\n");
});

test("tags, collection and documentation survive a direct projection; contradictions fail describe", async (t) => {
  const { base } = await serverFixture(t, { verifyOutput: true });
  const v = sample("patient-projection");
  const column = { name: "label", path: "name", description: "Labels", collection: true, type: "string",
    tag: [{ name: "ansi/type", value: "CHARACTER VARYING" }] };
  v.select = [{ column: [column] }];
  const describe = (subject: Artifact) => fetch(`${base}/$sql-describe`, postBody(parts(inline(subject))));
  const model = await (await describe(v)).json() as Artifact;
  assert.deepEqual(validateRelation(model), []);
  const facts = readRelation(model)!.columns[0]!;
  assert.deepEqual([facts.max, facts.min, leaves(model)[0]!.definition], ["*", 1, "Labels"]);
  assert.deepEqual(facts.sqlTypes, [{ declaredType: "TEXT", dialect: SQLITE_CONTENT_TYPE }, { declaredType: "CHARACTER VARYING", dialect: "application/sql;dialect=ansi-sql" }]);
  const run = (subject: Artifact) => fetch(base + "/$sql-run", postBody(parts(inline(subject), { name: "_format", valueCode: "json" })));
  assert.deepEqual(await (await run(v)).json(), [{ label: ["Example One"] }, { label: ["Example Two"] }]);
  for (const type of ["Reference", "integer"]) { column.type = type; assert.equal((await describe(v)).status, 422); }
  const query = sqlLibrary("left", "SELECT v.id AS visit_id FROM patient p LEFT JOIN visit v ON 0", []);
  assert.equal(readRelation(await (await describe(query)).json() as Artifact)!.columns[0]!.min, 0);
  assert.deepEqual(await (await run(query)).json(), [{ visit_id: null }, { visit_id: null }]);
  for (const parameter of [[{ name: "visit_id", use: "out", type: "boolean" }], [{ name: "not_there", use: "out", type: "string" }],
    Array(2).fill({ name: "visit_id", use: "out", type: "integer64" })]) {
    assert.equal((await describe({ ...query, parameter })).status, 422);
  }
});

test("unfamiliar declared types stay one quoted type, not executable DDL", (t) => {
  const { engine } = fixture(t, 100, `CREATE TABLE unusual (c "TEXT NOT NULL");`);
  const contract = engine.describe(sqlLibrary("quoted", "SELECT c FROM unusual", []));
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(contract.ddl);
    const info = db.prepare('SELECT type, "notnull" AS required FROM pragma_table_info(?)').get(String(contract.model.name))!;
    assert.deepEqual([info.type, info.required], ["TEXT NOT NULL", 0]);
  } finally { db.close(); }
});

test("describe checks duplicate, unused and cyclic context; anonymous subjects do not get invented canonical links", (t) => {
  const { engine } = fixture(t);
  const dep = sqlLibrary("dep", "SELECT 1 AS n", [], "sql-view");
  const query = sqlLibrary("anonymous", "SELECT * FROM d", [{ label: "d", resource: dep.url! }]);
  delete query.url;
  assert.equal(extension(engine.describe(query, { context: [dep] }).model, `${EXT}/describes`), undefined);
  assert.throws(() => engine.describe(query, { context: [dep, dep] }), /Duplicate context/);
  assert.throws(() => engine.describe(query, { context: [dep, sqlLibrary("unused", "SELECT 2", [])] }), /did not match/);
  dep.relatedArtifact = [{ type: "depends-on", label: "d", resource: dep.url }];
  assert.throws(() => engine.describe(query, { context: [dep] }), /Dependency cycle/);
});
