import assert from "node:assert/strict";
import test from "node:test";
import { EXT, SOF_RELATION, array, extension, object, sqlLibrary } from "../src/fhir.js";
import type { Artifact, FhirObject } from "../src/fhir.js";
import { validateRelation } from "../src/relation.js";
import { fixture, postBody, sample, serverFixture } from "./helpers.js";

function draft(): Artifact {
  const url = "https://example.org/curated";
  return { resourceType: "StructureDefinition", name: "Patient", id: "curated", kind: "logical", abstract: false,
    derivation: "specialization", baseDefinition: SOF_RELATION, type: url, url,
    differential: { element: [{ path: "Patient" }, { path: "Patient.id", type: [{ code: "integer64" }] }] } };
}
function leaf(r: Artifact) { return object(array(object(r.differential).element, "element")[1]); }
test("all generated Relations validate, while forbidden fields and incomplete tables have addressed errors", (t) => {
  const { models } = fixture(t);
  models.resources.forEach((r) => assert.deepEqual(validateRelation(r), []));
  const root = object(array(object(models.resources[0]!.differential).element, "element")[0]);
  assert.deepEqual(array(root.constraint, "constraint").map((x) => object(x).key), ["rel-1", "rel-2", "rel-3"]);
  assert.equal(extension(models.resources[0]!, "http://hl7.org/fhir/StructureDefinition/structuredefinition-type-characteristics")?.valueCode, "can-be-target");
  for (const change of [
    { path: "Patient.id.child" }, { id: "wrong" }, { max: "*" }, { min: 2 }, { mustHaveValue: true },
    { type: [] }, { type: [{ code: "Reference" }] }, { type: [{ code: "id", profile: ["urn:example:test"] }] },
    { type: [{ code: "id" }, { code: "id" }] }, { maxLength: 2 }, { minValueDecimal: 1 }, { minValueInteger64: 1 }, { condition: ["missing"] },
    { extension: [{ url: `${EXT}/foreign-key` }] }, { type: [{ code: "integer64", extension: [{ url: `${EXT}/sql-type`, valueString: "INT" }] }] },
    { orderMeaning: "arrival" }, { binding: { strength: "preferred", valueSet: "urn:example:vs" } },
    ...["representation", "slicing", "sliceName", "contentReference", "patternString", "defaultValueInteger64", "valueAlternatives", "isModifier", "mustSupport", "modifierExtension"].map((k) => ({ [k]: true })),
    { type: [{ code: "code" }], binding: { strength: "unknown", valueSet: "broken" } },
  ]) {
    const r = draft();
    Object.assign(leaf(r), change);
    const issue = validateRelation(r).find((i) => i.severity === "error");
    assert.match(String(issue?.expression), /element\[1\]/, JSON.stringify(change));
  }
  const r = draft();
  delete leaf(r).type;
  leaf(r).comment = "Unknown type";
  assert.equal(validateRelation(r)[0]?.severity, "error");
  r.extension = [{ url: `${EXT}/relation-kind`, valueCode: "result" }];
  assert.deepEqual(validateRelation(r), []);
  r.snapshot = {}; leaf(r).base = {}; leaf(r).isSummary = false;
  assert.deepEqual(validateRelation(r).map((i) => i.severity), ["warning", "warning", "warning"]);
});

test("validate a Relation descendant at write and at resolution without changing prior contents", async (t) => {
  const { base, store } = await serverFixture(t, { relationValidation: "error" });
  const parent = draft();
  const put = (r: Artifact) => fetch(`${base}/StructureDefinition/${r.id}`, { ...postBody(r), method: "PUT" });
  assert.equal((await put(parent)).status, 201);
  const child = { ...draft(), url: "https://example.org/child", type: "https://example.org/child", baseDefinition: parent.url!, id: "child" };
  assert.equal((await put(child)).status, 201);
  const invalid = structuredClone(child);
  leaf(invalid).defaultValueInteger64 = "1";
  for (const write of [() => put(invalid), () => fetch(`${base}/StructureDefinition`, postBody(invalid))]) {
    const response = await write();
    assert.equal(response.status, 422);
    assert.match(await response.text(), /element\[1\].defaultValueInteger64/);
  }
  assert.deepEqual(store.get("StructureDefinition", "child"), child);
  store.put(invalid);
  const query = sqlLibrary("reader", "SELECT * FROM dep", [{ label: "dep", resource: child.url }]);
  const view = sample("patient-projection");
  view.extension = [{ url: `${EXT}/source`, valueCanonical: child.url }];
  for (const subject of [query, view]) {
    const response = await fetch(`${base}/$sql-run`, postBody({ resourceType: "Parameters", parameter: [{ name: "subjectResource", resource: subject }] }));
    assert.equal(response.status, 422);
    assert.match(await response.text(), /defaultValueInteger64/);
  }
  const unrelated = { ...invalid, baseDefinition: "http://hl7.org/fhir/StructureDefinition/Patient", id: "other", url: "https://example.org/other" };
  assert.equal((await put(unrelated)).status, 201);
  const context: FhirObject[] = [{ name: "context", resource: invalid }, { name: "subjectResource", resource: query }];
  assert.match(await (await fetch(`${base}/$sql-describe`, postBody({ resourceType: "Parameters", parameter: context }))).text(), /defaultValueInteger64/);
  const warn = await serverFixture(t);
  const response = await fetch(warn.base + "/StructureDefinition", postBody({ ...invalid, baseDefinition: SOF_RELATION }, { Prefer: "return=OperationOutcome" }));
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("X-Relation-Issue-Count"), "1");
  assert.match(await response.text(), /"severity":"warning"/);
});

test("base resolution guards cycles and ambiguous ancestors; pinned and context ancestors are validated", async (t) => {
  const { base, store } = await serverFixture(t, { relationValidation: "error" });
  const parent = draft();
  store.put({ ...parent, version: "1" });
  store.put({ ...parent, id: "curated-two", version: "2" });
  const child = { ...draft(), id: "test-child", url: "https://example.org/test-child", type: "https://example.org/test-child", baseDefinition: parent.url! };
  const put = (r: Artifact) => fetch(`${base}/StructureDefinition/${r.id}`, { ...postBody(r), method: "PUT" });
  assert.equal((await put(child)).status, 409);
  child.baseDefinition += "|1";
  assert.equal((await put(child)).status, 201);
  const badParent = { ...parent, version: "1", kind: "complex-type" };
  const subject = sqlLibrary("queries-child", "SELECT * FROM c", [{ label: "c", resource: child.url }]);
  const response = await fetch(base + "/$sql-run", postBody({ resourceType: "Parameters", parameter: [
    { name: "subjectResource", resource: subject }, { name: "context", resource: badParent },
  ] }));
  assert.equal(response.status, 422); assert.match(await response.text(), /kind must equal logical/);
  assert.equal((await put({ ...parent, version: "1", baseDefinition: child.url })).status, 422);
  assert.equal(store.get("StructureDefinition", parent.id)?.baseDefinition, SOF_RELATION);
});
