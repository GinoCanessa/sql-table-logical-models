import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import type { TestContext } from "node:test";
import { Window } from "happy-dom";
import { initializePlayground } from "../ui/app.js";
import { serverFixture } from "./helpers.js";
import { SOF, array, object, sqlLibrary } from "../src/fhir.js";

async function uiFixture(t: TestContext, beforeFetch?: (path: string, init?: RequestInit) => Promise<void>) {
  const setup = await serverFixture(t);
  const window = new Window({
    url: `${setup.base}/playground/`,
    settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true },
  });
  window.document.write(readFileSync(new URL("../../ui/index.html", import.meta.url), "utf8"));
  Object.defineProperty(window, "confirm", { value: () => true });
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: window.document });
  const controller = await initializePlayground(undefined, async (path, init) => {
    await beforeFetch?.(path, init);
    return fetch(new URL(path, setup.base), init);
  });
  setup.cleanup.push(async () => {
    controller.dispose();
    await window.happyDOM.close();
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  });
  const node = (id: string) => {
    const element = window.document.getElementById(id);
    assert.ok(element instanceof window.HTMLElement, id);
    return element;
  };
  const field = (id: string, value: string) => {
    const element = node(id);
    assert.ok(element instanceof window.HTMLInputElement || element instanceof window.HTMLTextAreaElement || element instanceof window.HTMLSelectElement);
    element.value = value;
    element.dispatchEvent(new window.Event(element instanceof window.HTMLSelectElement ? "change" : "input", { bubbles: true }));
  };
  const checked = (id: string, value: boolean) => {
    const element = node(id);
    assert.ok(element instanceof window.HTMLInputElement);
    element.checked = value;
    element.dispatchEvent(new window.Event("change", { bubbles: true }));
  };
  const click = (id: string) => {
    const element = node(id);
    assert.ok(element instanceof window.HTMLButtonElement);
    element.click();
  };
  const choose = (key: string) => {
    const element = [...window.document.querySelectorAll("[data-key]")].find((e) => e.getAttribute("data-key") === key);
    assert.ok(element instanceof window.HTMLButtonElement, key);
    element.click();
  };
  const value = (id: string) => {
    const element = node(id);
    assert.ok(element instanceof window.HTMLInputElement || element instanceof window.HTMLTextAreaElement || element instanceof window.HTMLSelectElement);
    return element.value;
  };
  const wait = async (condition: () => boolean) => {
    for (let i = 0; i < 200; i++) {
      if (condition()) return;
      await setTimeout(10);
    }
    assert.fail(`UI action did not complete. Status: ${node("status").textContent}. Error: ${node("error-message").textContent}`);
  };
  return { ...setup, window, node, field, checked, click, choose, value, wait };
}

test("playground browsing loads bounded table pages and keeps generated artifact JSON read-only", async (t) => {
  const ui = await uiFixture(t);
  assert.match(ui.node("catalog-summary").textContent, /3 relations/);
  ui.choose("table:patient");
  await ui.wait(() => ui.node("table-title").textContent === "patient");
  assert.equal(ui.node("table-rows").textContent, "");
  ui.field("table-limit", "1");
  ui.click("preview-table");
  await ui.wait(() => ui.node("table-rows").textContent.includes("Example One"));
  ui.click("table-next");
  await ui.wait(() => ui.node("table-rows").textContent.includes("Example Two"));
  ui.click("table-next");
  await ui.wait(() => ui.node("table-page-status").textContent === "No rows at this offset.");
  assert.equal(ui.node("table-next").hasAttribute("disabled"), true);
  ui.click("table-previous");
  await ui.wait(() => ui.node("table-rows").textContent.includes("Example Two"));
  ui.click("table-show-model");
  await ui.wait(() => ui.value("artifact-json").includes('"resourceType": "StructureDefinition"'));
  assert.equal(ui.node("artifact-json").hasAttribute("readonly"), true);
  assert.equal(ui.node("artifact-save").hasAttribute("disabled"), true);
});

test("SQL workspace generates, saves and runs a parameterised Library and carries its values into FHIR operations", async (t) => {
  const ui = await uiFixture(t);
  ui.choose("table:patient");
  ui.click("table-start-sql");
  assert.match(ui.value("sql-editor"), /SELECT \* FROM "patient"/);
  ui.field("library-id", "browser-query");
  ui.field("sql-editor", "SELECT name FROM patient WHERE id = :patient_id");
  ui.field("parameter-declarations", '[{"name":"patient_id","type":"integer","use":"in","min":1,"max":"1"}]');
  ui.field("sql-parameters", '{"resourceType":"Parameters","parameter":[{"name":"patient_id","valueInteger":1}]}');
  ui.click("generate-library");
  await ui.wait(() => ui.node("status").textContent.startsWith("Generated Library"));
  assert.equal(JSON.parse(ui.value("generated-json")).id, "browser-query");
  assert.equal((await fetch(`${ui.base}/Library/browser-query`)).status, 404);
  ui.click("save-library");
  await ui.wait(() => ui.node("status").textContent.startsWith("Saved Library/browser-query"));
  assert.equal((await fetch(`${ui.base}/Library/browser-query`)).status, 200);
  ui.click("run-sql");
  await ui.wait(() => ui.node("sql-results").textContent.includes("Example One"));
  assert.ok(!ui.node("sql-results").textContent.includes("Example Two"));
  ui.click("sql-to-operation");
  await ui.wait(() => ui.node("status").textContent.startsWith("Operation request built"));
  assert.match(ui.value("operation-request"), /"valueInteger": 1/);
  ui.click("send-operation");
  await ui.wait(() => ui.node("operation-results").textContent.includes("Example One"));
  ui.field("operation-format", "csv");
  ui.checked("operation-envelope", true);
  ui.click("send-operation");
  await ui.wait(() => ui.node("operation-response").textContent.includes('"resourceType": "Binary"'));
  assert.match(ui.node("operation-results").textContent, /Example One/);
});

test("operations console handles multi-row NDJSON, export downloads, cancellation and OperationOutcome errors", async (t) => {
  const ui = await uiFixture(t);
  ui.field("sql-editor", "SELECT name FROM patient ORDER BY id");
  ui.click("sql-to-operation");
  await ui.wait(() => ui.node("status").textContent.startsWith("Operation request built"));
  ui.field("operation-format", "ndjson");
  ui.click("send-operation");
  await ui.wait(() => ui.node("status").textContent === "FHIR operation completed.");
  assert.equal(ui.node("operation-response").textContent.trim().split("\n").length, 2);
  assert.equal(ui.node("error-panel").hidden, true);
  ui.field("operation-kind", "sql-export");
  ui.click("send-operation");
  await ui.wait(() => ui.node("export-downloads").querySelector("a") !== null);
  const link = ui.node("export-downloads").querySelector("a")!;
  const location = link.href;
  const file = await fetch(location);
  assert.equal(file.status, 200);
  assert.match(await file.text(), /Example Two/);
  const manifest = JSON.parse(ui.node("operation-response").textContent);
  assert.equal(manifest.resourceType, "Parameters");
  ui.click("delete-export");
  await ui.wait(() => ui.node("status").textContent === "Export cancelled/deleted.");
  assert.equal(ui.node("export-downloads").querySelector("a"), null);
  assert.equal((await fetch(location)).status, 404);
  ui.field("operation-kind", "sql-run");
  ui.field("operation-request", '{"resourceType":"Parameters","parameter":[{"name":"unknown","valueString":"x"}]}');
  ui.checked("use-edited-request", true);
  ui.click("send-operation");
  await ui.wait(() => !ui.node("error-panel").hidden);
  assert.match(ui.node("operation-response").textContent, /OperationOutcome/);
  assert.match(ui.node("operation-response-status").textContent, /HTTP 400/);
});

test("SQL result cells render data as text and failed queries clear previous results", async (t) => {
  const ui = await uiFixture(t);
  ui.field("sql-editor", `SELECT '<img src=x onerror=alert(1)>' AS example`);
  ui.click("run-sql");
  await ui.wait(() => ui.node("sql-results").textContent.includes("<img"));
  assert.equal(ui.node("sql-results").querySelector("img"), null);
  ui.field("sql-editor", "DELETE FROM patient RETURNING id");
  ui.click("run-sql");
  await ui.wait(() => !ui.node("error-panel").hidden);
  assert.equal(ui.node("sql-results").textContent, "");
  assert.match(ui.node("sql-result-status").textContent, /Query failed/);
  const response = await fetch(`${ui.base}/playground/api/rows?name=patient`);
  const data = await response.json() as { rows: unknown[] };
  assert.equal(data.rows.length, 2);
});

test("editing a stored Library through the workspace preserves unrelated metadata, attachments and SQL comments", async (t) => {
  const ui = await uiFixture(t);
  const original = sqlLibrary("curated", "-- Keep this explanation\nSELECT 1 AS one;", []);
  original.name = "CuratedName";
  original.status = "active";
  original.description = "Author-supplied context";
  original.publisher = "Example publisher";
  original.meta = { profile: [`${SOF}/StructureDefinition/SQLQuery|3.0.0`, "https://example.org/custom-profile"], tag: [{ code: "curated" }] };
  original.content = [...array(original.content, "content"), { contentType: "text/plain", data: "bm90ZXM=" }];
  original.relatedArtifact = [{ type: "documentation", resource: "https://example.org/notes" }];
  await fetch(`${ui.base}/Library/curated`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(original) });
  ui.click("refresh");
  await ui.wait(() => !ui.node("refresh").hasAttribute("aria-busy"));
  ui.field("browser-kind", "Library");
  ui.choose("Library/curated");
  await ui.wait(() => ui.value("artifact-json").includes("Author-supplied context"));
  ui.click("artifact-load-sql");
  await ui.wait(() => ui.node("status").textContent.startsWith("Loaded Library/curated into"));
  assert.match(ui.value("sql-editor"), /Keep this explanation/);
  ui.field("sql-editor", "-- Revised explanation\nSELECT 2 AS two;");
  ui.field("library-kind", "sql-view");
  ui.click("save-library");
  await ui.wait(() => ui.node("status").textContent.startsWith("Saved Library/curated"));
  const saved = object(await (await fetch(`${ui.base}/Library/curated`)).json());
  assert.equal(saved.name, "CuratedName");
  assert.equal(saved.status, "active");
  assert.equal(saved.description, "Author-supplied context");
  assert.equal(saved.publisher, "Example publisher");
  assert.deepEqual(array(object(saved.meta).profile, "profile"), ["https://example.org/custom-profile", `${SOF}/StructureDefinition/SQLView`]);
  assert.equal(array(saved.content, "content").length, 2);
  assert.equal(object(array(saved.relatedArtifact, "relatedArtifact")[0]).type, "documentation");
  assert.match(Buffer.from(String(object(array(saved.content, "content")[0]).data), "base64").toString("utf8"), /Revised explanation/);
});

test("editing SQL while generation is pending does not enable downloading an outdated artifact", async (t) => {
  let paused = false;
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  const ui = await uiFixture(t, async (path) => {
    if (path === "/playground/api/library") { paused = true; await gate; }
  });
  t.after(resume);
  ui.click("generate-library");
  await ui.wait(() => paused);
  ui.field("sql-editor", "SELECT 2 AS updated");
  resume();
  await ui.wait(() => !ui.node("generate-library").hasAttribute("aria-busy"));
  assert.equal(ui.value("generated-json"), "");
  assert.equal(ui.node("generated-download").hasAttribute("disabled"), true);
});

test("operation submission snapshots form values before asynchronous Library generation", async (t) => {
  let paused = false;
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  const ui = await uiFixture(t, async (path) => {
    if (path === "/playground/api/library") { paused = true; await gate; }
  });
  t.after(resume);
  ui.click("send-operation");
  await ui.wait(() => paused);
  ui.field("operation-kind", "sql-export");
  ui.field("operation-format", "csv");
  resume();
  await ui.wait(() => !ui.node("send-operation").hasAttribute("aria-busy"));
  assert.equal(ui.node("status").textContent, "FHIR operation completed.");
  assert.match(ui.node("operation-http").textContent, /POST \/\$sql-run/);
  assert.equal(ui.node("export-controls").hidden, true);
  assert.match(ui.node("operation-response").textContent, /"example": 1/);
});
