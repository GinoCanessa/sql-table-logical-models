import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createApp } from "../src/server.js";
import { EXP, EXT, RELATION, SOF_RELATION, array, extension, object, sqlLibrary } from "../src/fhir.js";
import type { Artifact, FhirObject } from "../src/fhir.js";
import { checkRows } from "../src/conformance.js";
import { ExportJobs } from "../src/exports.js";
import { readRelation } from "../src/relation.js";
import { fixture, operatorExamples, serverFixture } from "./helpers.js";

const headers = { "Content-Type": "application/fhir+json" };
const post = (body: unknown, extra: Record<string, string> = {}) => ({ method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body) });

async function exportResult(base: string, input: unknown) {
  const kickoff = await fetch(`${base}/$sql-export`, post(input, { Prefer: "respond-async" }));
  assert.equal(kickoff.status, 202);
  assert.equal(await kickoff.text(), "");
  assert.equal(kickoff.headers.get("Retry-After"), "1");
  const statusUrl = kickoff.headers.get("Content-Location");
  assert.ok(statusUrl?.startsWith(`${base}/$sql-export/`));
  const signal = AbortSignal.timeout(4000);
  let status = await fetch(statusUrl!, { redirect: "manual", signal });
  while (status.status === 202) {
    assert.ok(status.headers.get("Retry-After"));
    await delay(10, undefined, { signal });
    status = await fetch(statusUrl!, { redirect: "manual", signal });
  }
  assert.equal(status.status, 303);
  const result = await fetch(status.headers.get("Location")!, { signal });
  return { result, statusUrl: statusUrl! };
}
async function completedExport(base: string, input: unknown) {
  const { result, statusUrl } = await exportResult(base, input);
  assert.equal(result.status, 200);
  const manifest = object(await result.json());
  assert.equal(manifest.resourceType, "Parameters");
  const parts = array(manifest.parameter, "parameter").map((p) => object(p));
  assert.equal(parts.find((p) => p.name === "location")?.valueUri, statusUrl);
  assert.equal(parts.find((p) => p.name === "status")?.valueCode, "completed");
  assert.equal(`${base}/$sql-export/${parts.find((p) => p.name === "exportId")?.valueString}/status`, statusUrl);
  const output = parts.filter((p) => p.name === "output");
  assert.equal(output.length, 1);
  const fields = array(output[0]!.part, "part").map((p) => object(p));
  assert.deepEqual(fields.map((p) => p.name), ["name", "location", "model"]);
  const modelUrl = String(fields[2]!.valueCanonical);
  const location = String(fields[1]!.valueUri);
  const file = await fetch(location);
  assert.equal(file.status, 200);
  return { file, location, modelUrl, statusUrl: statusUrl!, parts };
}

test("server manages artifacts and evaluates GET/POST sql-run in native and Binary formats", async (t) => {
  const { base } = await serverFixture(t);
  const cap = await fetch(`${base}/metadata`);
  assert.equal(cap.status, 200);
  assert.equal(object(await cap.json()).resourceType, "CapabilityStatement");
  const docs = await fetch(`${base}/docs/`);
  assert.equal(docs.status, 200);
  assert.match(await docs.text(), /data-theme-key="sql-table-logical-models"/);
  const operation = object(await (await fetch(`${base}/OperationDefinition/sql-run`)).json());
  assert.equal(operation.resourceType, "OperationDefinition");
  assert.equal(operation.base, "http://hl7.org/fhir/uv/sql-on-fhir/OperationDefinition/SQLRun");
  const search = object(await (await fetch(`${base}/StructureDefinition`)).json());
  assert.equal(search.total, 4);
  const data = await fetch(`${base}/$sql-run?subjectReference=Library/patient-visits&_format=json`);
  assert.equal(data.status, 200);
  const expected = { patient_id: "1", patient_name: "Example One", visit_id: "10", occurred_on: "2026-01-10", cost: 40.5 };
  const rows = await data.json() as unknown[];
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], expected);
  const run = JSON.parse(readFileSync(new URL("../../examples/run.json", import.meta.url), "utf8")) as unknown;
  const result = await fetch(`${base}/$sql-run`, post(run));
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), [expected]);
  const envelope = await fetch(`${base}/$sql-run?subjectReference=Library/patient-visits&_format=csv`, { headers: { Accept: "application/fhir+json" } });
  const binary = object(await envelope.json());
  assert.equal(binary.resourceType, "Binary");
  assert.match(Buffer.from(String(binary.data), "base64").toString("utf8"), /^patient_id,patient_name,visit_id,occurred_on,cost\r\n/);

  const resource = sqlLibrary("managed", "SELECT 1 AS one", []);
  let response = await fetch(`${base}/Library/managed`, { ...post(resource), method: "PUT" });
  assert.equal(response.status, 201);
  response = await fetch(`${base}/Library/managed`);
  assert.deepEqual(await response.json(), resource);
  response = await fetch(`${base}/Library/managed`, { method: "DELETE" });
  assert.equal(response.status, 204);
  assert.equal((await fetch(`${base}/Library/managed`)).status, 404);
  assert.equal((await fetch(`${base}/StructureDefinition/patient`, { method: "DELETE" })).status, 409);
});

test("system operation definitions declare all supported inputs and outputs, including nested parts", async (t) => {
  const { base } = await serverFixture(t);
  const subject = ["subjectCanonical canonical", "subjectReference Reference", "subjectResource CanonicalResource", "parameters Parameters"];
  const inputs = ["in context CanonicalResource 0..*", "in _format code 0..1", "in header boolean 0..1"];
  for (const op of ["run", "export"]) {
    const response = await fetch(`${base}/OperationDefinition/sql-${op}`);
    assert.equal(response.status, 200);
    const def = object(await response.json());
    assert.deepEqual([def.system, def.type, def.instance, def.code, def.base], [true, false, false, `sql-${op}`,
      `http://hl7.org/fhir/uv/sql-on-fhir/OperationDefinition/SQL${op === "run" ? "Run" : "Export"}`]);
    const actual: string[] = [];
    const enumerate = (p: FhirObject, prefix: string) => {
      actual.push(`${p.use} ${prefix}${p.name} ${p.type ?? "parts"} ${p.min}..${p.max}`);
      if (p.name === "return") assert.deepEqual(p.extension, [{
        url: "http://hl7.org/fhir/StructureDefinition/binary-content-model", valueCanonical: RELATION,
      }]);
      else assert.equal(p.extension, undefined);
      for (const part of array(p.part, "part")) enumerate(object(part), `${p.name}.`);
    };
    for (const p of array(def.parameter, "parameter")) enumerate(object(p), "");
    const expected = op === "run" ? [...inputs, ...subject.map((s) => `in ${s} 0..1`), "in _limit integer 0..1", "out return Binary 1..1"] :
      [...inputs, "in subject parts 1..*", ...["name string", ...subject].map((s) => `in subject.${s} 0..1`),
        "in clientTrackingId string 0..1", "out exportId string 1..1", "out status code 1..1", "out location uri 1..1",
        "out clientTrackingId string 0..1", "out _format code 0..1", "out exportStartTime instant 0..1", "out exportEndTime instant 0..1",
        "out output parts 0..*", "out output.name string 1..1", "out output.location uri 1..*", "out output.model canonical 1..1"];
    assert.deepEqual(actual.sort(), expected.sort());
  }
});

test("uploaded draft Relations retain advisory metadata but cannot bind to a physical source", async (t) => {
  const { base } = await serverFixture(t);
  const model = { resourceType: "StructureDefinition", id: "unbound", url: "https://example.org/external", baseDefinition: SOF_RELATION,
    kind: "logical", derivation: "specialization", abstract: false, type: "https://example.org/external",
    name: "patient", extension: [{ url: `${EXT}/relation-source`, valueAttachment: { url: "urn:example:inert" } }],
    differential: { element: [{ path: "patient" }, { path: "patient.id", type: [{ code: "integer64" }] }] } };
  const path = "/StructureDefinition/unbound";
  const write = await fetch(base + path, { ...post(model), method: "PUT" });
  assert.equal(write.status, 201);
  assert.equal(write.headers.get("Location"), path);
  assert.equal(write.headers.get("X-Relation-Issue-Count"), "1");
  assert.deepEqual(await write.json(), model);
  const preferred = await fetch(base + path, { ...post(model, { Prefer: "return=OperationOutcome" }), method: "PUT" });
  assert.equal(preferred.status, 200);
  assert.equal(preferred.headers.get("Location"), path);
  const outcome = object(await preferred.json());
  assert.equal(outcome.resourceType, "OperationOutcome");
  const advisory = object(array(outcome.issue, "issue")[0]);
  assert.equal(advisory.severity, "information");
  assert.match(String(advisory.diagnostics), /relation-source/);
  assert.deepEqual(await (await fetch(base + path)).json(), model);
  const run = await fetch(`${base}/$sql-run`, post({ resourceType: "Parameters", parameter: [{
    name: "subjectResource", resource: sqlLibrary("attempt", "SELECT * FROM ext", [{ label: "ext", resource: model.url }]),
  }] }));
  assert.equal(run.status, 422);
  assert.match(await run.text(), /No configured physical relation/);
});

test("typed integers and integral decimals agree across run and completed export", async (t) => {
  const { base } = await serverFixture(t, { typeEncoding: "extension", relationBase: "sof", verifyOutput: true }, `
    CREATE TABLE wire(id INTEGER, cost DECIMAL(10,2), note TEXT);
    INSERT INTO wire VALUES (7,40,'a,"b"
c'),(9223372036854775807,NULL,NULL);`);
  const query = sqlLibrary("wire", "SELECT id AS wide, 1+1 AS narrow, cost, note FROM wire ORDER BY id", []);
  query.parameter = [{ name: "narrow", use: "out", type: "integer" }];
  const subject = { name: "subjectResource", resource: query };
  const rows = [{ wide: "7", narrow: 2, cost: 40, note: 'a,"b"\nc' }, { wide: "9223372036854775807", narrow: 2, cost: null, note: null }];
  const csv = '7,2,40,"a,""b""\nc"\r\n9223372036854775807,2,,\r\n';
  const described = await (await fetch(`${base}/$sql-describe`, post({ resourceType: "Parameters", parameter: [subject] }))).json();
  for (const [format, header, expected] of [
    ["json", true, JSON.stringify(rows)], ["ndjson", true, rows.map((r) => JSON.stringify(r) + "\n").join("")],
    ["csv", true, "wide,narrow,cost,note\r\n" + csv], ["csv", false, csv],
  ] as const) {
    const common = [{ name: "_format", valueCode: format }, { name: "header", valueBoolean: header }];
    const run = await fetch(`${base}/$sql-run`, post({ resourceType: "Parameters", parameter: [subject, ...common] }));
    assert.equal(run.status, 200);
    const { file, parts, modelUrl } = await completedExport(base, { resourceType: "Parameters", parameter: [
      { name: "subject", part: [subject] }, ...common, { name: "clientTrackingId", valueString: "batch1" },
    ] });
    assert.deepEqual(await (await fetch(`${base}/StructureDefinition/${modelUrl.split("/").at(-1)}`)).json(), described);
    assert.equal(parts.find((p) => p.name === "clientTrackingId")?.valueString, "batch1");
    assert.equal(parts.find((p) => p.name === "_format")?.valueCode, format);
    for (const name of ["exportStartTime", "exportEndTime"]) assert.ok(Number.isFinite(Date.parse(String(parts.find((p) => p.name === name)?.valueInstant))));
    for (const response of [run, file]) assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(expected));
  }
});

test("verified JSON run and download distinguish mixed storage from a declared integer64 projection", async (t) => {
  const { base } = await serverFixture(t, { verifyOutput: true },
    "CREATE TABLE readings(v); INSERT INTO readings VALUES (7), ('text'), (NULL)");
  const mixed = sqlLibrary("mixed", "SELECT v AS reading FROM readings ORDER BY rowid", []);
  const numeric = sqlLibrary("numeric", "SELECT v AS reading FROM readings WHERE rowid = 1", []);
  numeric.parameter = [{ name: "reading", use: "out", type: "integer64" }];
  for (const [query, primitive, values] of [[mixed, undefined, [7, "text", null]], [numeric, "integer64", ["7"]]] as const) {
    const subject = { name: "subjectResource", resource: query };
    const format = { name: "_format", valueCode: "json" };
    const describe = await fetch(`${base}/$sql-describe`, post({ resourceType: "Parameters", parameter: [subject] }));
    assert.equal(describe.status, 200);
    const model = await describe.json() as Artifact;
    assert.equal(readRelation(model)!.columns[0]!.primitive, primitive);
    const run = await fetch(`${base}/$sql-run`, post({ resourceType: "Parameters", parameter: [subject, format] }));
    const { file, modelUrl } = await completedExport(base, { resourceType: "Parameters", parameter: [{ name: "subject", part: [subject] }, format] });
    assert.equal(modelUrl, model.url);
    assert.deepEqual(await (await fetch(`${base}/StructureDefinition/${model.id}`)).json(), model);
    for (const response of [run, file]) {
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("X-Relation-Issue-Count"), primitive ? null : "1");
      const rows = await response.json() as FhirObject[];
      assert.deepEqual(rows, values.map((reading) => ({ reading })));
      const issues = checkRows(model, rows);
      assert.deepEqual(issues.map((i) => [i.severity, i.diagnostics]), primitive ? [] : [["information", "Partial typing: reading is unknown"]]);
    }
  }
});

test("standalone, nested and context-replaced SQLViews reject the same invalid outputs before export kickoff", async (t) => {
  const { base, store } = await serverFixture(t);
  const start = t.mock.method(ExportJobs.prototype, "start");
  const valid = sqlLibrary("declared-id", "SELECT id FROM patient", [], "sql-view");
  valid.version = "1";
  valid.parameter = [{ name: "id", use: "out", type: "integer64" }];
  const middle = sqlLibrary("middle", "SELECT id AS patient_id FROM src", [{ label: "src", resource: `${valid.url}|1` }], "sql-view");
  middle.parameter = [{ name: "patient_id", use: "out", type: "integer64" }];
  store.put(middle);
  const root = sqlLibrary("consumer", "SELECT patient_id FROM mid ORDER BY patient_id", [{ label: "mid", resource: middle.url! }]);
  const reject = async (resource: Artifact, diagnostics: string, replacement?: Artifact) => {
    const subject = { name: "subjectResource", resource };
    for (const operation of ["describe", "run", "export"]) {
      const exporting = operation === "export";
      const input = { resourceType: "Parameters", parameter: [exporting ? { name: "subject", part: [subject] } : subject,
        ...(replacement ? [{ name: "context", resource: replacement }] : [])] };
      const response = await fetch(`${base}/$sql-${operation}`, post(input, exporting ? { Prefer: "respond-async" } : {}));
      assert.equal(response.status, 422);
      assert.equal(response.headers.get("Content-Location"), null);
      assert.deepEqual(await response.json(), { resourceType: "OperationOutcome", issue: [{ severity: "error", code: "invalid", diagnostics }] });
    }
  };
  for (const [name, type, reason] of [
    ["patient_key", "integer64", "Missing declared output column: patient_key"],
    ["id", "boolean", "Conflicting primitive for id: boolean vs integer64"],
  ] as const) {
    const bad = { ...valid, parameter: [{ name, use: "out", type }] };
    store.put(bad);
    await reject(bad, reason);
    await reject(root, reason);
    store.put(valid);
    const run = await fetch(`${base}/$sql-run`, post({ resourceType: "Parameters", parameter: [
      { name: "subjectResource", resource: root }, { name: "_format", valueCode: "json" },
    ] }));
    assert.equal(run.status, 200);
    assert.deepEqual(await run.json(), [{ patient_id: "1" }, { patient_id: "2" }]);
    await reject(root, reason, bad);
  }
  assert.equal(start.mock.callCount(), 0);
});

test("verify-output catches required NULL in run and export; declared SQLite length is a nonfatal row warning", async (t) => {
  for (const verifyOutput of [false, true]) {
    const { base } = await serverFixture(t, { verifyOutput }, "CREATE TABLE short_name(n VARCHAR(3) NOT NULL); INSERT INTO short_name VALUES ('four')");
    const query = sqlLibrary("required", "SELECT NULL AS required_id", []);
    query.parameter = [{ name: "required_id", use: "out", type: "integer64", min: 1, max: "1" }];
    const invoke = (resource: Artifact) => {
      const subject = { name: "subjectResource", resource };
      const format = { name: "_format", valueCode: "csv" };
      return {
        run: () => fetch(`${base}/$sql-run`, post({ resourceType: "Parameters", parameter: [subject, format] })),
        export: { resourceType: "Parameters", parameter: [{ name: "subject", part: [subject] }, format] },
      };
    };
    const invalid = invoke(query);
    const response = await invalid.run();
    assert.equal(response.status, verifyOutput ? 422 : 200);
    const { result, statusUrl } = await exportResult(base, invalid.export);
    assert.equal(result.status, verifyOutput ? 422 : 200);
    if (verifyOutput) {
      assert.match(await response.text(), /Required column is NULL/);
      assert.match(await result.text(), /Required column is NULL/);
      assert.equal((await fetch(statusUrl.replace(/status$/, "required.csv"))).status, 404);
    }
    const view: Artifact = { resourceType: "ViewDefinition", id: "short-name", name: "ShortName", resource: "short_name",
      select: [{ column: [{ name: "label", path: "n" }] }] };
    const search = await (await fetch(base + "/StructureDefinition")).json() as { entry: { resource: Artifact }[] };
    view.extension = [{ url: `${EXT}/source`, valueCanonical: search.entry.find((e) => e.resource.name === "short_name")!.resource.url }];
    const valid = invoke(view);
    const successful = await valid.run();
    const { file } = await completedExport(base, valid.export);
    for (const response of [successful, file]) {
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("X-Relation-Issue-Count"), verifyOutput ? "1" : null);
      assert.equal(response.headers.get("X-Relation-Warning-Count"), verifyOutput ? "1" : null);
      assert.equal(await response.text(), "label\r\nfour\r\n");
    }
    const fromLibrary = await invoke(sqlLibrary("short", "SELECT n AS label FROM short_name", [])).run();
    assert.equal(fromLibrary.status, 200);
    assert.equal(fromLibrary.headers.get("X-Relation-Issue-Count"), null);
  }
});

test("a pinned clinic client provisions from describe, discovers the same contract and retains each immutable export on restart", async (t) => {
  const { person, relations, annotations } = operatorExamples();
  const setup = await serverFixture(t, { verifyOutput: true, relations, annotations });
  let base = setup.base;
  assert.equal((await fetch(base + "/StructureDefinition/clinic-person", { ...post(person), method: "PUT" })).status, 201);
  const dep = sqlLibrary("shared", "SELECT person_id AS value, note FROM people JOIN notes ON person_id = patient_id ORDER BY notes.id", [
    { label: "people", resource: `${person.url}|1` }, { label: "notes", resource: "https://example.org/sql/StructureDefinition/visit" },
  ], "sql-view"); dep.version = "1";
  setup.store.put(dep);
  const pinned = sqlLibrary("pinned", "SELECT * FROM dep", [{ label: "dep", resource: dep.url + "|1" }]); pinned.version = "2";
  setup.store.put(pinned);
  const local = sqlLibrary("request-only", "SELECT name FROM patient", [], "sql-view");
  const inline = sqlLibrary("consumer", "SELECT * FROM other", [{ label: "other", resource: local.url! }]);
  const context = { name: "context", resource: local };
  const subjects = [{ name: "subjectCanonical", valueCanonical: pinned.url + "|2" }, { name: "subjectResource", resource: inline }];
  const describes = await Promise.all(subjects.map(async (subject, i) => await (await fetch(base + "/$sql-describe", post({
    resourceType: "Parameters", parameter: [subject, ...(i ? [context] : [])],
  }))).json() as Artifact));
  const model = describes[0]!;
  const ddl = await (await fetch(base + "/$sql-describe", post({ resourceType: "Parameters", parameter: [subjects[0], { name: "_format", valueCode: "sql" }] }))).text();
  assert.equal(ddl, extension(model, `${EXT}/sql-ddl`)?.valueString);
  const target = new DatabaseSync(":memory:");
  try {
    target.exec(ddl);
    assert.deepEqual(target.prepare("SELECT name, type FROM pragma_table_info(?) ORDER BY cid").all(String(model.name)).map((c) => [c.name, c.type]),
      [["value", "INTEGER"], ["note", "TEXT"]]);
  } finally { target.close(); }
  const discovery = await (await fetch(base + "/$feature-query", post({ resourceType: "Parameters", parameter: [{ name: "feature", part: [
    { name: "definition", valueCanonical: `${EXP}/FeatureDefinition/result-model` }, { name: "context", valueString: pinned.url + "|2" },
  ] }] }))).json();
  const answer = array(object(array(object(discovery).parameter, "parameter")[0]).part, "part").map((v) => object(v));
  const canonical = String(answer.find((p) => p.name === "value")?.valueCanonical);
  assert.equal(canonical, model.url);
  const discoveryRead = await (await fetch(`${base}/StructureDefinition?url=${encodeURIComponent(canonical)}`)).json();
  assert.deepEqual(object(array(object(discoveryRead).entry, "entry")[0]).resource, model);
  const rows = await (await fetch(base + "/$sql-run", post({ resourceType: "Parameters", parameter: [subjects[0], { name: "_format", valueCode: "json" }] }))).json();
  assert.deepEqual(rows, [{ value: "1", note: "Synthetic visit" }, { value: "1", note: null }, { value: "2", note: null }]);
  assert.deepEqual(checkRows(model, rows), []);
  const input = { resourceType: "Parameters", parameter: [...subjects.map((s, i) => ({ name: "subject", part: [
    { name: "name", valueString: `file${i}` }, s] })), context, { name: "_format", valueCode: "json" }] };
  const unmet = await fetch(base + "/$sql-export", post(input, { Prefer: "respond-async", "Required-Features": "param=integer64-json(number)" }));
  assert.equal(unmet.status, 501); assert.equal(object(await unmet.json()).resourceType, "OperationOutcome");
  assert.equal(unmet.headers.get("Content-Location"), null);
  const { result, statusUrl } = await exportResult(base, input);
  assert.equal(result.status, 200);
  const outputs = array(object(await result.json()).parameter, "parameter").map((p) => object(p)).filter((p) => p.name === "output");
  assert.equal(outputs.length, 2);
  const files = await Promise.all(outputs.map(async (p, i) => {
    const fields = array(p.part, "part").map((v) => object(v));
    assert.deepEqual(fields.map((f) => f.name), ["name", "location", "model"]);
    assert.equal(fields[0]!.valueString, `file${i}`);
    assert.equal(fields[2]!.valueCanonical, describes[i]!.url);
    const path = new URL(String(fields[1]!.valueUri)).pathname;
    const body = await (await fetch(base + path)).text();
    assert.deepEqual(checkRows(describes[i]!, JSON.parse(body)), []);
    if (!i) assert.deepEqual(JSON.parse(body), rows);
    return { path, body };
  }));
  const second = await exportResult(base, input);
  assert.equal(second.result.status, 200);
  assert.equal((await fetch(second.statusUrl, { method: "DELETE" })).status, 202);
  setup.store.put({ ...sqlLibrary("shared", "SELECT name AS label FROM patient", [], "sql-view"), version: "1" });
  setup.store.put({ ...sqlLibrary("pinned", "SELECT label FROM dep ORDER BY label DESC", [{ label: "dep", resource: dep.url + "|1" }]), version: "2" });
  base = await setup.reopen();
  const current = await (await fetch(`${base}/$sql-describe?subjectReference=Library/pinned`)).json() as Artifact;
  assert.notEqual(current.url, describes[0]!.url);
  assert.deepEqual(array(object(current.differential).element, "element").slice(1).map((e) => object(e).path), [`${current.name}.label`]);
  for (const [i, model] of describes.entries()) {
    assert.deepEqual(await (await fetch(`${base}/StructureDefinition/${model.id}`)).json(), model);
    const search = object(await (await fetch(`${base}/StructureDefinition?url=${encodeURIComponent(model.url!)}`)).json());
    assert.equal(search.total, 1);
    assert.deepEqual(object(array(search.entry, "entry")[0]).resource, model);
    assert.equal(await (await fetch(base + files[i]!.path)).text(), files[i]!.body);
  }
  assert.equal(setup.store.get("Library", local.id), undefined);
  assert.equal((await fetch(base + new URL(statusUrl).pathname, { method: "DELETE" })).status, 202);
  assert.equal((await fetch(base + files[0]!.path)).status, 404);
  assert.equal((await fetch(`${base}/StructureDefinition/${describes[0]!.id}`)).status, 404);
});

test("an asserted integer range cannot silently round or overflow JSON; CSV still uses raw cells", async (t) => {
  const { base } = await serverFixture(t, { integerType: "integer" }, `
    CREATE TABLE narrow(n INT); INSERT INTO narrow VALUES (2147483647),(9223372036854775807);`);
  const invoke = (sql: string, format: string) => fetch(`${base}/$sql-run`, post({ resourceType: "Parameters", parameter: [
    { name: "subjectResource", resource: sqlLibrary("range", sql, []) }, { name: "_format", valueCode: format },
  ] }));
  assert.deepEqual(await (await invoke("SELECT n FROM narrow ORDER BY n LIMIT 1", "json")).json(), [{ n: 2147483647 }]);
  const overflow = await invoke("SELECT n FROM narrow", "json");
  assert.equal(overflow.status, 422);
  assert.match(await overflow.text(), /integer range/);
  assert.equal(await (await invoke("SELECT n FROM narrow ORDER BY n", "csv")).text(), "n\r\n2147483647\r\n9223372036854775807\r\n");
});

test("source database cannot be used as the writable artifact store", (t) => {
  const { database } = fixture(t);
  assert.throws(() => createApp({ database, artifacts: database }), /different files/);
});

test("server returns OperationOutcome for malformed, ambiguous and unsupported requests", async (t) => {
  const { base } = await serverFixture(t);
  const requests = [
    ["/$sql-run?subjectReference=Library/patient-visits&_format=parquet", undefined, 400],
    ["/$sql-run?subjectReference=Library/patient-visits&_format=toString", undefined, 400],
    ["/$sql-run?subjectReference=Library/patient-visits&_limit=1junk", undefined, 400],
    ["/$sql-run?subjectReference=Library/patient-visits&patient=Patient/1", undefined, 400],
    ["/$sql-run?subjectReference=Library/patient-visits&subjectCanonical=https://example.org/x", undefined, 400],
    ["/$sql-run?subjectReference=Library/patient-visits", { headers: { Accept: "application/fhir+xml" } }, 406],
    ["/$sql-run", { method: "POST", headers, body: "{" }, 400],
    ["/$sql-run", { method: "POST", body: "{}" }, 415],
    ["/$sql-export", post({ resourceType: "Parameters" }), 400],
  ] as const;
  for (const [path, init, status] of requests) {
    const response = await fetch(base + path, init);
    assert.equal(response.status, status, path);
    assert.equal(object(await response.json()).resourceType, "OperationOutcome");
  }
});

test("inline context resolves canonical dependencies and CSV keeps headers for empty results", async (t) => {
  const { base } = await serverFixture(t);
  const inline = sqlLibrary("inline", "SELECT * FROM c WHERE 0", [{ label: "c", resource: "https://example.org/context" }]);
  const context = sqlLibrary("provided", "SELECT 'x' AS heading", [], "sql-view");
  context.url = "https://example.org/context";
  const input = {
    resourceType: "Parameters", parameter: [
      { name: "subjectResource", resource: inline }, { name: "context", resource: context },
      { name: "_format", valueCode: "csv" },
    ],
  };
  const response = await fetch(`${base}/$sql-run`, post(input));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "heading\r\n");
});

test("sql-export validates before acceptance and persists manifests/downloads until deletion", async (t) => {
  const { base } = await serverFixture(t);
  const input = JSON.parse(readFileSync(new URL("../../examples/export.json", import.meta.url), "utf8")) as unknown;
  const { statusUrl, location, file } = await completedExport(base, input);
  assert.match(await file.text(), /Example One/);
  assert.equal((await fetch(statusUrl, { method: "DELETE" })).status, 202);
  assert.equal((await fetch(String(location))).status, 404);

  const bad = { resourceType: "Parameters", parameter: [{ name: "subject", part: [
    { name: "name", valueString: "bad" }, { name: "subjectResource", resource: sqlLibrary("bad", "SELECT * FROM no_such_table", []) },
  ] }] };
  assert.equal((await fetch(`${base}/$sql-export`, post(bad, { Prefer: "respond-async" }))).status, 422);
});

test("empty completed files match prepared column order in each format with and without CSV headers", async (t) => {
  const { base } = await serverFixture(t, { verifyOutput: true });
  const subject = { name: "subjectResource", resource: sqlLibrary("empty-files", "SELECT cost, id AS visit_id FROM visit WHERE 0", []) };
  const model = await (await fetch(base + "/$sql-describe", post({ resourceType: "Parameters", parameter: [subject] }))).json() as Artifact;
  assert.deepEqual(checkRows(model, [], ["cost", "visit_id"]), []);
  for (const [format, header, expected] of [["json", true, "[]"], ["ndjson", true, ""], ["csv", true, "cost,visit_id\r\n"], ["csv", false, ""]] as const) {
    const options = [{ name: "_format", valueCode: format }, { name: "header", valueBoolean: header }];
    const run = await fetch(base + "/$sql-run", post({ resourceType: "Parameters", parameter: [subject, ...options] }));
    const completed = await completedExport(base, { resourceType: "Parameters", parameter: [{ name: "subject", part: [subject] }, ...options] });
    assert.equal(completed.modelUrl, model.url);
    assert.equal(run.status, 200); assert.equal(await run.text(), expected);
    assert.equal(await completed.file.text(), expected);
  }
});
