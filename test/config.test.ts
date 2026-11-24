import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { EXT, SOF, SOF_RELATION, SQLITE_CONTENT_TYPE, array, extension, object, sqlLibrary } from "../src/fhir.js";
import type { Artifact, FhirObject } from "../src/fhir.js";
import { createLogicalModels } from "../src/models.js";
import { createApp } from "../src/server.js";
import { readSqliteSchema } from "../src/schema.js";
import type { PlaygroundCatalog } from "../src/playground.js";
import { fixture, operatorExamples, postBody, sample, serverFixture } from "./helpers.js";

const leaves = (model: Artifact) => array(object(model.differential).element, "element").slice(1).map((e) => object(e));
const parts = (...parameter: FhirObject[]) => ({ resourceType: "Parameters", parameter });
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));

test("configured curated dependency projects only checked columns for Libraries and ViewDefinitions", async (t) => {
  const { person, relations, annotations } = operatorExamples();
  const { base, database, store } = await serverFixture(t, { relations, annotations, verifyOutput: true, relationValidation: "warn" });
  const initial = readFileSync(database);
  const network = fetch;
  let offServer = 0;
  t.mock.method(globalThis, "fetch", (url: string, init?: RequestInit) => {
    if (new URL(url).origin !== base) { offServer++; throw new Error("Unexpected network access"); }
    return network(url, init);
  });
  const pin = person.url + "|1";
  person.extension = [{ url: `${EXT}/sql-name`, valueString: "visit" },
    { url: `${SOF}/StructureDefinition/relation-source`, valueUrl: "https://unreachable.invalid/other" }];
  const put = (model: Artifact) => fetch(`${base}/StructureDefinition/${model.id}`, { ...postBody(model), method: "PUT" });
  const saved = await put(person);
  assert.equal(saved.status, 201); assert.equal(saved.headers.get("X-Relation-Issue-Count"), "1");
  const lib = (sql: string, source = pin) => sqlLibrary("people", sql, [{ label: "people", resource: source }]);
  const all = lib("SELECT * FROM people ORDER BY person_id");
  const view: Artifact = { ...sample("patient-projection"), resource: "ClinicPerson", extension: [{ url: `${EXT}/source`, valueCanonical: pin }],
    select: [{ column: [{ name: "person_id", path: "person_id" }, { name: "display", path: "display" }] }] };
  const invoke = (op: string, subject: Artifact, ...inputs: FhirObject[]) => fetch(`${base}/$sql-${op}`,
    postBody(parts({ name: "subjectResource", resource: subject }, ...inputs)));
  const expected = [{ person_id: "1", display: "Example One" }, { person_id: "2", display: "Example Two" }];
  for (const subject of [all, view]) {
    const run = await invoke("run", subject, { name: "_format", valueCode: "json" });
    assert.equal(run.status, 200); assert.deepEqual(await run.json(), expected);
    const model = await (await invoke("describe", subject)).json() as Artifact;
    const cols = leaves(model);
    assert.deepEqual(cols.map((c) => c.path), [`${model.name}.person_id`, `${model.name}.display`]);
    assert.deepEqual(cols.map((c) => extension(c, `${EXT}/origin`)?.valueUri), [`${person.url}#ClinicPerson.person_id`, `${person.url}#ClinicPerson.display`]);
    assert.deepEqual(cols.map((c) => c.min), subject === view ? [1, 1] : [0, 0]);
  }
  assert.equal((await invoke("run", lib("SELECT active FROM people"))).status, 422);
  // Declaring a dependency does not make it the origin of a direct physical read. When the
  // statement reads the same physical column both ways, only the physical origin is certain.
  for (const sql of ["SELECT id FROM patient", "SELECT p.id FROM patient p JOIN people ON p.id = people.person_id"]) {
    const model = await (await invoke("describe", lib(sql))).json() as Artifact;
    assert.equal(extension(leaves(model)[0]!, `${EXT}/origin`)?.valueUri, "https://example.org/sql/StructureDefinition/patient#patient.id");
  }
  const other = { ...person, version: "2", id: "person-2" };
  assert.equal((await put(other)).status, 201);
  const unbound = await invoke("describe", lib("SELECT * FROM people", person.url + "|2"));
  assert.equal(unbound.status, 422); assert.match(await unbound.text(), /No configured physical relation/);
  const catalog = await (await fetch(base + "/playground/api/catalog")).json() as PlaygroundCatalog;
  assert.deepEqual([person, other].map((r) => catalog.artifacts.find((a) => a.id === r.id)?.dependency), [true, false]);
  const bad = structuredClone(person);
  leaves(bad)[1]!.extension = [{ url: `${EXT}/sql-name`, valueString: "not_in_patient" }];
  const rejected = await put(bad);
  assert.equal(rejected.status, 422); assert.match(await rejected.text(), /not_in_patient/);
  for (const subject of [all, view]) assert.equal((await invoke("describe", subject, { name: "context", resource: bad })).status, 422);
  assert.deepEqual(store.get("StructureDefinition", person.id), person);
  const notes: Artifact = { ...view, resource: "visit", extension: [{ url: `${EXT}/source`, valueCanonical: "https://example.org/sql/StructureDefinition/visit" }],
    select: [{ column: [{ name: "note_alias", path: "note" }] }] };
  const note = leaves(await (await invoke("describe", notes)).json() as Artifact)[0]!;
  assert.equal(note.meaningWhenMissing, "NULL means no note was recorded.");
  assert.deepEqual(note.binding, { strength: "example", valueSet: "urn:example:ValueSet:visit-notes" });
  assert.equal(offServer, 0);
  assert.deepEqual(readFileSync(database), initial);
});

test("configuration rejects ambiguous, untyped and semantically incompatible physical bindings before serving", (t) => {
  const setup = fixture(t, 1000, `CREATE TABLE "odd""table" ("a b" INT CHECK (1), missing_type, flag BOOLEAN, day DATE, n INTEGER CHECK(n BETWEEN 0 AND 20));`);
  const { person } = operatorExamples(), pin = person.url + "|1";
  const initial = readFileSync(setup.database);
  const open = (relations: Record<string, string>, integerType: "integer64" | "integer" | "auto" = "integer64") =>
    createApp({ database: setup.database, artifacts: setup.artifacts, relations, integerType, relationValidation: "warn" });
  for (const invalid of [{ [person.url!]: "patient" }, { [pin + "|1"]: "patient" }, { [pin]: "absent" }, { [pin]: "visit_totals" },
    { [pin]: "main.patient" }, { [pin]: ["patient", "visit"] }]) assert.throws(() => open(invalid as Record<string, string>));
  const model = (columns: FhirObject[]): Artifact => ({ ...person, differential: { element: [{ path: "ClinicPerson" }, ...columns] } });
  const col = (name: string, physical: string, code: string, sql?: string): FhirObject => ({
    path: `ClinicPerson.${name}`, type: [{ code }], extension: [{ url: `${SOF}/StructureDefinition/sql-name`, valueString: physical }],
    ...(sql ? { mapping: [{ identity: "sql", language: SQLITE_CONTENT_TYPE, map: sql }] } : {}),
  });
  const target = { [pin]: 'ODD"TABLE' };
  for (const columns of [
    [col("one", "a b", "integer64"), col("two", "A B", "integer64")],
    [col("a", "flag", "decimal")], [col("a", "flag", "boolean", "NUMERIC")], [col("a", "day", "date", "DECIMAL")],
    [col("a", "missing_type", "string")], [col("a", "n", "integer")],
    [{ ...col("a", "a b", "integer64"), min: 1 }], [{ ...col("a", "n", "integer64"), max: "*", mapping: [{ identity: "sql", language: "application/sql;dialect=other", map: "INT[]" }] }],
  ]) {
    setup.store.put(model(columns));
    assert.throws(() => open(target), /duplicate physical column|Incompatible|incompatible/i);
  }
  setup.store.put({ ...model([col("a", "a b", "integer64")]), baseDefinition: "urn:unrelated" });
  assert.throws(() => open(target), /concrete Relation/);
  setup.store.put(model([col("a", "A B", "integer", "INTEGER"), col("v", "n", "integer")]));
  open(target, "integer").close();
  assert.throws(() => open(target, "auto"), /Incompatible/);
  setup.store.put(model([col("a", "A B", "integer64", "INTEGER"), col("v", "n", "integer")]));
  open(target, "auto").close();
  assert.deepEqual(readFileSync(setup.database), initial);
});

test("curated descendant resolves against SQLite identifiers, quotes and operator integer policy", async (t) => {
  const { person } = operatorExamples(), pin = person.url + "|1";
  const { base, store } = await serverFixture(t, { relations: { [pin]: 'ODD"TABLE' }, integerType: "integer" },
    `CREATE TABLE "odd""table" ("id KEY" INT, extra TEXT); INSERT INTO "odd""table" VALUES (40, 'not projected');`);
  const parent = { ...person, id: "ancestor", url: "https://example.org/ancestor", type: "https://example.org/ancestor", baseDefinition: SOF_RELATION };
  store.put(parent);
  person.baseDefinition = parent.url + "|1";
  person.differential = { element: [{ path: "ClinicPerson" }, { path: "ClinicPerson.key", type: [{ code: "integer" }],
    extension: [{ url: `${SOF}/StructureDefinition/sql-name`, valueString: "ID key" }] }] };
  assert.equal((await fetch(`${base}/StructureDefinition/${person.id}`, { ...postBody(person), method: "PUT" })).status, 201);
  const subject = sqlLibrary("odd", "SELECT * FROM checked", [{ label: "checked", resource: pin }]);
  const r = await fetch(base + "/$sql-run", postBody(parts({ name: "subjectResource", resource: subject }, { name: "_format", valueCode: "json" })));
  assert.equal(r.status, 200); assert.deepEqual(await r.json(), [{ key: 40 }]);
});

test("derive and serve merge the same operator file before publishing any model", async (t) => {
  const { database, directory, artifacts } = fixture(t);
  const { annotations } = operatorExamples();
  const file = join(directory, "annotations.json");
  const relations = fileURLToPath(new URL("../../examples/relations.json", import.meta.url));
  const target = "https://example.org/sql/StructureDefinition/visit";
  writeFileSync(file, JSON.stringify([...annotations, { url: target, differential: { element: [
    { path: "visit.note", binding: { strength: "preferred" } },
  ] } }]));
  const flags = ["--database", database, "--annotations", file];
  const derive = spawnSync(process.execPath, [cli, "derive", ...flags], { encoding: "utf8" });
  assert.equal(derive.status, 0, derive.stderr);
  const model = array(object(JSON.parse(derive.stdout)).entry, "entry").map((e) => object(e).resource as Artifact).find((r) => r.url === target)!;
  const note = leaves(model).find((c) => c.path === "visit.note")!;
  assert.match(String(model.description), /do not enforce declared lengths/);
  assert.match(String(model.description), /Synthetic clinic encounters/);
  assert.deepEqual([note.label, note.definition, note.code, note.alias, note.meaningWhenMissing, note.example, note.binding], [
    "Visit note", "A short note recorded at the encounter.", [{ system: "urn:example:clinic:columns", code: "visit-note" }],
    ["encounter note"], "NULL means no note was recorded.", [{ label: "Synthetic note", valueString: "Synthetic visit" }],
    { strength: "preferred", valueSet: "urn:example:ValueSet:visit-notes" },
  ]);
  assert.deepEqual([note.min, note.max, note.type, note.mapping], [0, "1", [{ code: "string" }],
    [{ identity: "sql", language: SQLITE_CONTENT_TYPE, map: "TEXT" }]]);
  const child = spawn(process.execPath, [cli, "serve", ...flags, "--relations", relations, "--artifacts", artifacts, "--port", "0"], { stdio: ["ignore", "pipe", "pipe"] });
  const finished = once(child, "close");
  try {
    const [message] = await once(child.stdout, "data", { signal: AbortSignal.timeout(4000) });
    const address = /(http:\/\/127\.0\.0\.1:\d+)\/playground/.exec(String(message))?.[1]; assert.ok(address);
    const served = await fetch(address + "/StructureDefinition/visit", { signal: AbortSignal.timeout(4000) });
    assert.equal(served.status, 200); assert.deepEqual(await served.json(), model);
    // Prove that the *serve CLI*, not just the API fixture, installed the relations file.
    const { person } = operatorExamples();
    const saved = await fetch(address + "/StructureDefinition/clinic-person", { ...postBody(person), method: "PUT" });
    assert.equal(saved.status, 201);
    const catalog = await (await fetch(address + "/playground/api/catalog")).json() as PlaygroundCatalog;
    assert.ok(catalog.artifacts.find((a) => a.id === "clinic-person")?.dependency);
  } finally { child.kill(); await finished; }
  writeFileSync(file, JSON.stringify([{ url: target, differential: { element: [{ path: "visit.absent", label: "Bad" }] } }]));
  const out = join(directory, "rejected.json");
  const rejected = spawnSync(process.execPath, [cli, "derive", ...flags, "--out", out], { encoding: "utf8" });
  assert.notEqual(rejected.status, 0); assert.match(rejected.stderr, /annotation path/); assert.ok(!existsSync(out));
  writeFileSync(file, '{"https://example.org/person|1":"patient","https://example.org/person\\u007c1":"visit"}');
  const duplicate = spawnSync(process.execPath, [cli, "serve", "--database", database, "--artifacts", artifacts, "--relations", file, "--port", "0"],
    { encoding: "utf8", timeout: 4000 });
  assert.notEqual(duplicate.status, 0); assert.match(duplicate.stderr, /Duplicate configuration key/);
});

test("overlays preserve derived facts and warnings and reject contradictions even in warn mode", (t) => {
  const { database, artifacts } = fixture(t, 1000, `CREATE TABLE mixed (untyped, limited VARCHAR(5));`);
  const { annotations } = operatorExamples();
  const schema = readSqliteSchema(database), before = readFileSync(database);
  const noFetch = t.mock.method(globalThis, "fetch", () => { throw new Error("No terminology resolution"); });
  const url = "https://example.org/sql/StructureDefinition/visit";
  const patch = (path: string, fields: FhirObject): FhirObject => ({ url, differential: { element: [{ path, ...fields }] } });
  const base = createLogicalModels(schema);
  const visit = base.bindings.find((b) => b.table === "visit")!.model;
  const original = leaves(visit).find((e) => e.path === "visit.patient_id")!;
  const assertions = [
    patch("visit.patient_id", { type: original.type, min: original.min, max: original.max, mustHaveValue: true, mapping: [{ identity: "sql", map: "INTEGER" }] }),
    { url: "https://example.org/sql/StructureDefinition/mixed", differential: { element: [{ path: "mixed.untyped", comment: "Author's note." }] } },
  ];
  const merged = createLogicalModels(schema, { annotations: assertions });
  assert.deepEqual(merged.bindings.find((b) => b.table === "visit")!.model, visit);
  assert.match(String(leaves(merged.bindings.find((b) => b.table === "mixed")!.model)[0]!.comment), /No declared type;[\s\S]+Author's note/);
  const name = (v: string) => ({ url: `${EXT}/sql-name`, valueString: v });
  const vs = "urn:example:ValueSet:visit-notes";
  const withStrength = (strength: string) => patch("visit.note", { binding: { strength, valueSet: vs } });
  for (const [i, overlays] of [
    [patch("visit.note", { min: 1 })], [patch("visit.id", { type: [{ code: "integer" }] })],
    [patch("visit.cost", { mapping: [{ identity: "sql", map: "DECIMAL(3,0)" }] })],
    [patch("visit.note", { extension: [{ url: `${EXT}/primary-key-position`, valueInteger: 1 }] })],
    [patch("visit.note", { extension: [name("cost")] })], [patch("visit.id", { mustHaveValue: false })],
    [{ url: "https://example.org/sql/StructureDefinition/patient", differential: { element: [{ path: "patient.name", binding: { strength: "preferred" } }] } }],
    [patch("visit.note", { binding: { strength: "example", valueSet: "relative" } })],
    [patch("visit.patient_id", { binding: { strength: "example", valueSet: vs } })], [withStrength("required")],
    [withStrength("extensible"), withStrength("preferred")], [patch("visit.missing", { label: "Unused" })],
    [{ url, extension: [name("patient")] }], [{ extension: [name("visit"), name("patient")] }], [{ description: "No selector" }],
    [patch("visit.note", { label: "first" }), patch("visit.note", { label: "second" })],
    [patch("visit.cost", { minValueDecimal: 5, maxValueDecimal: 1 })],
    [patch("visit.note", { example: [{ label: "Wrong representation", valueInteger: 5 }] })],
    [patch("visit.id", { mustSupport: true })],
  ].entries()) {
    assert.throws(() => createApp({ database, artifacts, annotations: [...annotations, ...overlays], relationValidation: "warn" }).close(), Error, `invalid overlay ${i}`);
  }
  assert.deepEqual(createLogicalModels(schema), base);
  assert.deepEqual(readFileSync(database), before); assert.equal(noFetch.mock.callCount(), 0);
});
