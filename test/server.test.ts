import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createApp } from "../src/server.js";
import { array, object, sqlLibrary } from "../src/fhir.js";
import { fixture, serverFixture } from "./helpers.js";

const headers = { "Content-Type": "application/fhir+json" };
const post = (body: unknown, extra: Record<string, string> = {}) => ({ method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body) });

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
  assert.equal((await data.json() as unknown[]).length, 2);
  const run = JSON.parse(readFileSync(new URL("../../examples/run.json", import.meta.url), "utf8")) as unknown;
  const result = await fetch(`${base}/$sql-run`, post(run));
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), [{ patient_id: 1, patient_name: "Example One", visit_id: 10, occurred_on: "2026-01-10", cost: 40.5 }]);
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
  const kickoff = await fetch(`${base}/$sql-export`, post(input, { Prefer: "respond-async" }));
  assert.equal(kickoff.status, 202);
  const statusUrl = kickoff.headers.get("Content-Location")!;
  const status = await fetch(statusUrl, { redirect: "manual" });
  assert.equal(status.status, 303);
  const result = await fetch(status.headers.get("Location")!);
  const manifest = object(await result.json());
  const output = array(manifest.parameter, "parameter").map((p) => object(p)).find((p) => p.name === "output")!;
  const location = array(output.part, "part").map((p) => object(p)).find((p) => p.name === "location")!.valueUri;
  const file = await fetch(String(location));
  assert.equal(file.status, 200);
  assert.match(await file.text(), /Example One/);
  assert.equal((await fetch(statusUrl, { method: "DELETE" })).status, 202);
  assert.equal((await fetch(String(location))).status, 404);

  const bad = { resourceType: "Parameters", parameter: [{ name: "subject", part: [
    { name: "name", valueString: "bad" }, { name: "subjectResource", resource: sqlLibrary("bad", "SELECT * FROM no_such_table", []) },
  ] }] };
  assert.equal((await fetch(`${base}/$sql-export`, post(bad, { Prefer: "respond-async" }))).status, 422);
});
