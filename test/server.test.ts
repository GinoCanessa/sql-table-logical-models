import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createApp } from "../src/server.js";
import { EXT, RELATION, SOF_RELATION, array, object, sqlLibrary } from "../src/fhir.js";
import type { FhirObject } from "../src/fhir.js";
import { fixture, serverFixture } from "./helpers.js";

const headers = { "Content-Type": "application/fhir+json" };
const post = (body: unknown, extra: Record<string, string> = {}) => ({ method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body) });

async function completedExport(base: string, input: unknown) {
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
  assert.deepEqual(fields.map((p) => p.name), ["name", "location"]); // No model part in this manifest version.
  const location = String(fields[1]!.valueUri);
  const file = await fetch(location);
  assert.equal(file.status, 200);
  return { file, location, statusUrl: statusUrl!, parts };
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
        "out output parts 0..*", "out output.name string 1..1", "out output.location uri 1..*"];
    assert.deepEqual(actual.sort(), expected.sort());
  }
});

test("uploaded draft Relations retain advisory metadata but cannot bind to a physical source", async (t) => {
  const { base } = await serverFixture(t);
  const model = { resourceType: "StructureDefinition", id: "unbound", url: "https://example.org/external", baseDefinition: SOF_RELATION,
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
  const { base } = await serverFixture(t, { typeEncoding: "extension", relationBase: "sof" }, `
    CREATE TABLE wire(id INTEGER, cost DECIMAL(10,2), note TEXT);
    INSERT INTO wire VALUES (7,40,'a,"b"'),(9223372036854775807,NULL,NULL);`);
  const query = sqlLibrary("wire", "SELECT id AS wide, 1+1 AS narrow, cost, note FROM wire ORDER BY id", []);
  query.parameter = [{ name: "narrow", use: "out", type: "integer" }];
  const subject = { name: "subjectResource", resource: query };
  const rows = [{ wide: "7", narrow: 2, cost: 40, note: 'a,"b"' }, { wide: "9223372036854775807", narrow: 2, cost: null, note: null }];
  const csv = '7,2,40,"a,""b"""\r\n9223372036854775807,2,,\r\n';
  for (const [format, header, expected] of [
    ["json", true, JSON.stringify(rows)], ["ndjson", true, rows.map((r) => JSON.stringify(r) + "\n").join("")],
    ["csv", true, "wide,narrow,cost,note\r\n" + csv], ["csv", false, csv],
  ] as const) {
    const common = [{ name: "_format", valueCode: format }, { name: "header", valueBoolean: header }];
    const run = await fetch(`${base}/$sql-run`, post({ resourceType: "Parameters", parameter: [subject, ...common] }));
    assert.equal(run.status, 200);
    const { file, parts } = await completedExport(base, { resourceType: "Parameters", parameter: [
      { name: "subject", part: [subject] }, ...common, { name: "clientTrackingId", valueString: "batch1" },
    ] });
    assert.equal(parts.find((p) => p.name === "clientTrackingId")?.valueString, "batch1");
    assert.equal(parts.find((p) => p.name === "_format")?.valueCode, format);
    for (const name of ["exportStartTime", "exportEndTime"]) assert.ok(Number.isFinite(Date.parse(String(parts.find((p) => p.name === name)?.valueInstant))));
    for (const response of [run, file]) assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(expected));
  }
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
