import assert from "node:assert/strict";
import test from "node:test";
import { AFF } from "../src/features.js";
import { BINARY_CONTENT_MODEL, EXP, array, extension, object, sqlLibrary } from "../src/fhir.js";
import type { Artifact, FhirObject } from "../src/fhir.js";
import { QueryEngine } from "../src/engine.js";
import { ExportJobs } from "../src/exports.js";
import { Catalog } from "../src/store.js";
import { postBody, sample, serverFixture } from "./helpers.js";

const ns = `${EXP}/FeatureDefinition/`;
function answers(r: FhirObject) {
  assert.equal(r.resourceType, "Parameters");
  return array(r.parameter, "parameter").map((p) => array(object(p).part, "part").map((v) => object(v)));
}
const returnModel = (r: FhirObject) => extension(array(r.parameter, "parameter").map((p) => object(p)).find((p) => p.name === "return")!, BINARY_CONTENT_MODEL)?.valueCanonical;
const localPath = (canonical: string) => new URL(canonical).pathname.match(/\/(?:StructureDefinition|OperationDefinition)\/[^/]+$/)![0];

test("retrieve the reported profile and result model for both kinds by literal and versioned canonical, including cold reads", async (t) => {
  const setup = await serverFixture(t);
  let base = setup.base;
  const metadata = object(await (await fetch(base + "/metadata")).json());
  assert.deepEqual(extension(extension(metadata, `${AFF}/StructureDefinition/feature`)!, "value"), { url: "value", valueCode: "1.0.0" });
  assert.ok(!JSON.stringify(metadata).includes(ns));
  const ops = array(object(array(metadata.rest, "rest")[0]).operation, "operation").map((o) => object(o).name);
  assert.deepEqual(ops, ["sql-run", "sql-export", "sql-describe", "feature-query"]);
  for (const id of ["operation-profile", "result-model", "binary-content-model", "output-format", "sql-dialect", "integer64-json", "describe"]) {
    const response = await fetch(`${base}/FeatureDefinition/${id}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("Content-Type")!, /^application\/json/);
    const d = object(await response.json());
    assert.equal(d.url, ns + id); assert.equal(d.contextExpressionLanguage, "text/url");
    assert.match(String(d.context), /StructureDefinition\/CapabilityStatement#CapabilityStatement\.rest/);
    assert.ok(d.contextDefinition);
  }
  const saved = new Map<string, Artifact>();
  for (const [type, id] of [["Library", "patient-visits"], ["ViewDefinition", "patient-projection"]] as const) {
    const subject = sample(id);
    setup.store.put({ ...subject, version: "v1" });
    const get = answers(object(await (await fetch(`${base}/$feature-query?param=operation-profile@${type}/${id}&param=result-model@${type}/${id}`)).json()));
    const post = answers(object(await (await fetch(base + "/$feature-query", postBody({ resourceType: "Parameters",
      parameter: ["operation-profile", "result-model"].map((name) => ({ name: "feature", part: [
        { name: "definition", valueCanonical: ns + name }, { name: "context", valueString: subject.url + "|v1" },
      ] })) }))).json()));
    const urls = get.map((a) => String(a.find((p) => p.name === "value")?.valueCanonical));
    assert.deepEqual(post.map((a) => a.find((p) => p.name === "value")?.valueCanonical), urls);
    const [profile, model] = await Promise.all(urls.map(async (u) => {
      const path = localPath(u);
      const r = await (await fetch(base + path)).json() as Artifact;
      assert.equal(r.url, u); saved.set(path, r);
      const search = object(await (await fetch(base + path.slice(0, path.lastIndexOf("/")) + "?url=" + encodeURIComponent(u))).json());
      assert.equal(search.total, 1); assert.deepEqual(object(array(search.entry, "entry")[0]).resource, r);
      return r;
    }));
    assert.equal(returnModel(profile!), model!.url);
    const run = object(await (await fetch(base + "/OperationDefinition/sql-run")).json());
    assert.deepEqual([profile!.code, profile!.base, profile!.system, profile!.instance, profile!.type], ["sql-run", run.url, true, false, false]);
    assert.deepEqual(array(profile!.parameter, "parameter").map((v) => ({ ...object(v), extension: undefined })),
      array(run.parameter, "parameter").map((v) => ({ ...object(v), extension: undefined })));
    assert.deepEqual(await (await fetch(`${base}/$sql-describe?subjectReference=${type}/${id}`)).json(), model);
    assert.equal((await fetch(`${base}/${type}/${id}/$sql-run`)).status, 404);
    assert.deepEqual(setup.store.get(type, id), { ...subject, version: "v1" });
  }
  // Updating the projection invalidated its dependents; pin cold reads for the current graph.
  const before = await (await fetch(`${base}/$sql-describe?subjectReference=Library/patient-visits&_format=operation`)).json() as Artifact;
  base = await setup.reopen();
  assert.deepEqual(await (await fetch(base + localPath(before.url!))).json(), before);
  for (const [path, resource] of [...saved].slice(-2)) assert.deepEqual(await (await fetch(base + path)).json(), resource);
  assert.equal((await fetch(base + "/$sqlquery-run")).status, 404);
});

test("identity distinguishes versions, kind, changed body, dependencies and occupied IDs/canonicals", async (t) => {
  const { base, store } = await serverFixture(t);
  const get = async (r: Artifact) => await (await fetch(`${base}/$sql-describe?subjectReference=${r.resourceType}/${r.id}`)).json() as Artifact;
  const id = "long".repeat(16);
  const query = sqlLibrary(id, "SELECT id FROM patient", []);
  query.version = "1"; store.put(query);
  const first = await get(query);
  assert.ok(first.id.length <= 64);
  const second = { ...query, id: "v2", version: "2" }; store.put(second);
  const view = { ...sample("patient-projection"), id, url: `https://example.org/sql/ViewDefinition/${id}` }; store.put(view);
  const initial = store.list();
  assert.equal(new Set([first.id, (await get(second)).id, (await get(view)).id]).size, 3);
  assert.deepEqual(store.list(), initial);
  // Simulate artifacts present before discovery (HTTP writes cannot replace a live contract).
  store.put({ ...first, url: "https://example.org/occupied", type: "https://example.org/occupied" });
  const next = await get(query); assert.notEqual(next.id, first.id);
  store.put({ ...next, id: "canonical-collision" });
  const third = await get(query); assert.notEqual(third.id, next.id);
  assert.deepEqual(await get(query), third);
  assert.equal((await fetch(`${base}/StructureDefinition/${third.id}`, { method: "DELETE" })).status, 409);
  const dep = sqlLibrary("dep", "SELECT 1 AS a", [], "sql-view");
  const inlineQuery = sqlLibrary("inline", "SELECT * FROM dep", [{ label: "dep", resource: dep.url! }]);
  const inspect = async (subject: Artifact, context: Artifact, format = "json") => await (await fetch(base + "/$sql-describe", postBody({
    resourceType: "Parameters", parameter: [{ name: "subjectResource", resource: subject }, { name: "context", resource: context }, { name: "_format", valueCode: format }],
  }))).json() as Artifact;
  const inline = await inspect(inlineQuery, dep);
  const reordered = Object.fromEntries(Object.entries(inlineQuery).reverse()) as Artifact;
  assert.deepEqual(await inspect(reordered, dep), inline);
  const changed = await inspect(inlineQuery, sqlLibrary("dep", "SELECT 2 AS a", [], "sql-view"));
  const changedSubject = await inspect({ ...inlineQuery, description: "Changed" }, dep);
  assert.equal(new Set([inline.id, changed.id, changedSubject.id]).size, 3);
  const profile = await inspect(inlineQuery, dep, "operation");
  assert.deepEqual(profile.contained, [inline]); assert.equal(returnModel(profile), "#" + inline.id);
  assert.equal((await fetch(base + localPath(inline.url!))).status, 404);
  assert.equal((await fetch(base + localPath(profile.url!))).status, 404);
  assert.equal(store.get("Library", "dep"), undefined);
  const copy = { ...inline, url: "https://example.org/saved", type: "https://example.org/saved" };
  const saved = await fetch(base + "/StructureDefinition", postBody(copy)); assert.equal(saved.status, 201);
});

test("typed feature matching distinguishes missing subject, unknown feature and mismatched value", async (t) => {
  const { base } = await serverFixture(t);
  const params = ["integer64-json(string)", "integer64-json(number)", "binary-content-model@sql-run(true)", "output-format@sql-export", "absent", "result-model@Library/absent"];
  const result = answers(object(await (await fetch(`${base}/$feature-query?` + params.map((p) => "param=" + encodeURIComponent(p)).join("&"))).json()));
  assert.deepEqual(result.slice(0, 3).map((r) => r.find((p) => p.name === "answer")?.valueBoolean), [true, false, true]);
  assert.deepEqual(result[3]!.filter((p) => p.name === "value").map((p) => p.valueCode), ["json", "ndjson", "csv"]);
  assert.deepEqual(result.slice(-2).map((r) => r.find((p) => p.name === "processing-status")?.valueCode), ["feature", "all-ok"]);
  assert.ok(result.slice(-2).every((r) => !r.some((p) => p.name === "value")));
  assert.equal((await fetch(`${base}/$feature-query?param=result-model@${encodeURIComponent("https://example.org/a|v1")}`)).status, 400);
});

test("unmet requirements fail before subject resolution, preparation, export preflight or job allocation", async (t) => {
  const { base } = await serverFixture(t);
  const spies = [t.mock.method(Catalog.prototype, "get"), t.mock.method(QueryEngine.prototype, "describe"),
    t.mock.method(QueryEngine.prototype, "runPreparedBatch"), t.mock.method(QueryEngine.prototype, "runBatch"), t.mock.method(ExportJobs.prototype, "start")];
  for (const allowed of [false, true]) {
    const headers = { "Required-Features": `param=integer64-json(${allowed ? "string" : "number"})`, Prefer: "respond-async" };
    const name = { name: "subjectReference", valueReference: { reference: "Library/patient-visits" } };
    for (const op of ["run", "describe", "export"]) {
      const r = await fetch(`${base}/$sql-${op}`, postBody({ resourceType: "Parameters", parameter: op === "export" ? [{ name: "subject", part: [name] }] : [name] }, headers));
      assert.equal(r.status, allowed ? op === "export" ? 202 : 200 : 501);
      if (!allowed) { assert.match(await r.text(), /OperationOutcome/); assert.ok(spies.every((s) => !s.mock.callCount())); }
    }
  }
  assert.ok(spies.every((s) => s.mock.callCount() > 0));
});
