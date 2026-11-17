import type { Artifact, FhirObject } from "../src/fhir.js";
import type { PlaygroundArtifact, PlaygroundCatalog, PlaygroundRelation, TablePreview } from "../src/playground.js";
import { buildOperation, canonical, dependencyLabel, parseArray, parseObject, subjectPart } from "./workspace.js";
import type { Dependency } from "./workspace.js";

type Fetcher = (path: string, init?: RequestInit) => Promise<Response>;
type Pane = "explore" | "sql" | "operations";
const EMPTY_PARAMETERS = '{"resourceType":"Parameters","parameter":[]}';
const DEFAULT_SQL = "SELECT 1 AS example;";

class ApiError extends Error {
  constructor(public readonly status: number, public readonly payload: unknown) {
    const issues = record(payload) && Array.isArray(payload.issue) ? payload.issue : [];
    const diagnostics = issues.filter(record).map((i) => String(i.diagnostics ?? i.code)).join("; ");
    super(`HTTP ${status}: ${diagnostics || (typeof payload === "string" ? payload : "Request failed")}`);
  }
}

function record(value: unknown): value is FhirObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export async function initializePlayground(doc: Document = document, fetcher: Fetcher = fetch) {
  const el = <T extends HTMLElement = HTMLElement>(id: string): T => {
    const found = doc.getElementById(id);
    if (!found) throw new Error(`Missing playground element: ${id}`);
    return found as T;
  };
  const input = (id: string) => el<HTMLInputElement>(id);
  const editor = (id: string) => el<HTMLTextAreaElement>(id);
  const select = (id: string) => el<HTMLSelectElement>(id);
  const button = (id: string) => el<HTMLButtonElement>(id);
  const listeners: (() => void)[] = [];
  const busy = new WeakSet<HTMLButtonElement>();
  let catalog: PlaygroundCatalog | undefined;
  let dependencies: Dependency[] = [];
  let relation: PlaygroundRelation | undefined;
  let selectedArtifact: PlaygroundArtifact | undefined;
  let generated: Artifact | undefined;
  let sourceLibrary: Artifact | undefined;
  let generationVersion = 0;
  let inspectedJson = "";
  let pageOffset = 0;
  let pageLimit = 25;
  let jobUrl: string | undefined;
  let selection = "";
  let selectionVersion = 0;
  let rowsVersion = 0;
  let disposed = false;

  function status(message: string) {
    el("status").textContent = message;
  }

  function showError(error: unknown) {
    el("error-panel").hidden = false;
    el("error-message").textContent = error instanceof Error ? error.message : String(error);
    el("error-detail").textContent = error instanceof ApiError ? typeof error.payload === "string" ? error.payload : pretty(error.payload) : "";
    status("Action failed. See the error details above.");
  }

  async function perform(task: () => void | Promise<void>, source?: HTMLButtonElement) {
    if (source && busy.has(source)) return;
    el("error-panel").hidden = true;
    const operationControls = source && ["send-operation", "check-export", "delete-export"].includes(source.id) ?
      ["send-operation", "check-export", "delete-export"].map(button) : [];
    for (const control of operationControls) control.disabled = true;
    if (source) { busy.add(source); source.setAttribute("aria-busy", "true"); }
    try { await task(); }
    catch (error) { if (!disposed) showError(error); }
    finally {
      if (source) { busy.delete(source); source.removeAttribute("aria-busy"); }
      for (const control of operationControls) control.disabled = false;
    }
  }

  function on(id: string, event: string, task: () => void | Promise<void>) {
    const target = el(id);
    const handler = () => { void perform(task, target.tagName === "BUTTON" ? target as HTMLButtonElement : undefined); };
    target.addEventListener(event, handler);
    listeners.push(() => target.removeEventListener(event, handler));
  }

  async function request(path: string, init?: RequestInit) {
    const response = await fetcher(path, init);
    const raw = await response.text();
    const media = response.headers.get("Content-Type")?.split(";")[0]?.trim();
    const data: unknown = raw && (media === "application/json" || media?.endsWith("+json")) ? JSON.parse(raw) as unknown : raw;
    if (!response.ok) throw new ApiError(response.status, data);
    return { response, raw, data };
  }

  async function json<T>(path: string, init?: RequestInit): Promise<T> {
    return (await request(path, init)).data as T;
  }

  const post = (value: unknown, contentType = "application/fhir+json"): RequestInit => ({
    method: "POST", headers: { "Content-Type": contentType }, body: JSON.stringify(value),
  });

  function showPane(pane: Pane) {
    for (const name of ["explore", "sql", "operations"]) el(`${name}-pane`).hidden = name !== pane;
    for (const tab of doc.querySelectorAll<HTMLButtonElement>("[data-pane]")) tab.setAttribute("aria-pressed", String(tab.dataset.pane === pane));
  }

  function option(value: string, label: string) {
    const node = doc.createElement("option");
    node.value = value;
    node.textContent = label;
    return node;
  }

  function invalidateGenerated() {
    generationVersion++;
    generated = undefined;
    button("generated-download").disabled = true;
    editor("generated-json").value = "";
  }

  function renderDependencies() {
    el("dependencies").replaceChildren();
    dependencies.forEach((dependency, index) => {
      const row = doc.createElement("div");
      row.className = "dependency-row";
      const label = doc.createElement("input");
      label.value = dependency.label;
      label.setAttribute("aria-label", `SQL label for ${dependency.resource}`);
      label.addEventListener("input", () => { dependency.label = label.value; invalidateGenerated(); });
      const url = doc.createElement("code");
      url.textContent = dependency.resource;
      const remove = doc.createElement("button");
      remove.type = "button";
      remove.textContent = "Remove";
      remove.setAttribute("aria-label", `Remove dependency ${dependency.label}`);
      remove.addEventListener("click", () => { dependencies.splice(index, 1); invalidateGenerated(); renderDependencies(); });
      row.append(label, url, remove);
      el("dependencies").append(row);
    });
  }

  function addDependency(resource: { url?: string; version?: string }, name: string) {
    const url = canonical(resource);
    const existing = dependencies.find((d) => d.resource === url);
    if (existing) return existing.label;
    const label = dependencyLabel(name, dependencies);
    dependencies.push({ label, resource: url });
    invalidateGenerated();
    renderDependencies();
    return label;
  }

  function renderCatalog() {
    const kind = select("browser-kind").value;
    const filter = input("catalog-search").value.toLowerCase();
    const items = kind === "relations" ?
      (catalog?.relations ?? []).filter((r) => `${r.name} ${r.canonical}`.toLowerCase().includes(filter)).map((r) => ({
        key: `table:${r.name}`, title: r.name, detail: `${r.kind} / ${r.columns.length} columns`,
        open: () => selectRelation(r),
      })) :
      (catalog?.artifacts ?? []).filter((a) => a.resourceType === kind && `${a.id} ${a.title} ${a.url ?? ""}`.toLowerCase().includes(filter)).map((a) => ({
        key: a.reference, title: a.title, detail: `${a.id} / ${a.generated ? "generated, read-only" : "stored"}`,
        open: () => selectArtifact(a),
      }));
    el("catalog-list").replaceChildren();
    el("catalog-count").textContent = `${items.length} ${kind === "relations" ? "relations" : "artifacts"}`;
    for (const item of items) {
      const node = doc.createElement("button");
      node.type = "button";
      node.className = "catalog-item";
      node.dataset.key = item.key;
      node.setAttribute("aria-current", String(selection === item.key));
      const title = doc.createElement("strong");
      title.textContent = item.title;
      const detail = doc.createElement("small");
      detail.textContent = item.detail;
      node.append(title, detail);
      node.addEventListener("click", () => { void perform(item.open); });
      el("catalog-list").append(node);
    }
    if (!items.length) el("catalog-list").textContent = "No matching items. Generated models appear automatically; stored Libraries and ViewDefinitions appear after saving.";
  }

  async function refresh() {
    catalog = await json<PlaygroundCatalog>("/playground/api/catalog");
    if (disposed) return;
    el("catalog-summary").textContent = `${catalog.relations.length} relations / ${catalog.artifacts.length} artifacts / ${catalog.maxRows} row execution ceiling`;
    input("table-limit").max = String(Math.min(100, catalog.maxRows));
    input("table-limit").value = String(catalog.pageSize);
    for (const id of ["sql-limit", "operation-limit"]) {
      input(id).max = String(catalog.maxRows);
      if (Number(input(id).value) > catalog.maxRows) input(id).value = String(Math.min(100, catalog.maxRows));
    }
    input("library-url").placeholder = `${catalog.baseUrl}/Library/{id}`;
    input("operation-canonical").placeholder = `${catalog.baseUrl}/Library/{id}`;
    const previousDependency = select("dependency-source").value;
    select("dependency-source").replaceChildren(...catalog.artifacts.filter((a) => a.dependency && a.url).map((a) => option(a.reference, `${a.title} (${a.resourceType})`)));
    if (catalog.artifacts.some((a) => a.reference === previousDependency && a.dependency)) select("dependency-source").value = previousDependency;
    button("add-dependency").disabled = !select("dependency-source").options.length;
    const previousSubject = select("operation-reference").value;
    select("operation-reference").replaceChildren(...catalog.artifacts.filter((a) => ["Library", "ViewDefinition"].includes(a.resourceType)).map((a) => option(a.reference, a.reference)));
    if (catalog.artifacts.some((a) => a.reference === previousSubject)) select("operation-reference").value = previousSubject;
    renderCatalog();
    status("Catalog loaded. Select a table or artifact, or open the SQL workspace.");
  }

  function makeTable(columns: string[], rows: Record<string, unknown>[], caption: string) {
    const region = doc.createElement("div");
    region.className = "data-grid";
    region.tabIndex = 0;
    region.setAttribute("role", "region");
    region.setAttribute("aria-label", caption);
    const table = doc.createElement("table");
    const title = doc.createElement("caption");
    title.textContent = caption;
    const head = doc.createElement("thead");
    const tr = doc.createElement("tr");
    for (const name of columns) {
      const th = doc.createElement("th");
      th.scope = "col";
      th.textContent = name;
      tr.append(th);
    }
    head.append(tr);
    const body = doc.createElement("tbody");
    for (const row of rows) {
      const line = doc.createElement("tr");
      for (const name of columns) {
        const cell = doc.createElement("td");
        const value = row[name];
        cell.textContent = value === null ? "NULL" : value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
        if (value === null) cell.className = "sql-null";
        line.append(cell);
      }
      body.append(line);
    }
    table.append(title, head, body);
    region.append(table);
    if (!rows.length) {
      const empty = doc.createElement("p");
      empty.className = "help";
      empty.textContent = "No rows returned.";
      region.append(empty);
    }
    return region;
  }

  function selectRelation(value: PlaygroundRelation) {
    if (!confirmDiscardArtifact()) return;
    selectionVersion++;
    relation = value;
    selectedArtifact = undefined;
    selection = `table:${value.name}`;
    pageOffset = 0;
    showPane("explore");
    el("explore-empty").hidden = true;
    el("artifact-inspector").hidden = true;
    el("table-inspector").hidden = false;
    el("table-title").textContent = value.name;
    el("table-kind").textContent = `SQLite ${value.kind} / source is read-only`;
    el("table-canonical").textContent = value.canonical;
    el("table-ddl").textContent = value.ddl;
    el("table-keys").textContent = pretty({ foreignKeys: value.foreignKeys, indexes: value.indexes });
    el("table-columns").replaceChildren(makeTable(["name", "declaredType", "nullable", "primaryKeyPosition", "defaultSql", "generated"],
      value.columns.map((c) => ({ ...c })), `${value.name}: schema`));
    el("table-rows").replaceChildren();
    el("table-page-status").textContent = "Rows are not loaded until requested. Primary keys define preview order; otherwise row order is unspecified.";
    button("table-previous").disabled = true;
    button("table-next").disabled = true;
    renderCatalog();
    status(`Inspecting ${value.name}.`);
  }

  async function loadRows(offset: number) {
    if (!relation) throw new Error("Select a table first");
    const token = selectionVersion;
    const version = ++rowsVersion;
    const limit = Number(input("table-limit").value);
    const params = new URLSearchParams({ name: relation.name, offset: String(offset), limit: String(limit) });
    const result = await json<TablePreview>(`/playground/api/rows?${params}`);
    if (token !== selectionVersion || version !== rowsVersion || disposed) return;
    pageOffset = result.offset;
    pageLimit = result.limit;
    el("table-rows").replaceChildren(makeTable(result.columns, result.rows, `${relation.name}: rows`));
    el("table-page-status").textContent = result.rows.length ?
      `Showing rows ${result.offset + 1}-${result.offset + result.rows.length}. A full page enables Next; the next page may be empty.` : "No rows at this offset.";
    button("table-previous").disabled = result.offset === 0;
    button("table-next").disabled = !result.mayHaveMore;
    status(`Loaded ${result.rows.length} rows from ${relation.name}.`);
  }

  async function selectArtifact(value: PlaygroundArtifact) {
    if (!confirmDiscardArtifact()) return;
    const token = ++selectionVersion;
    const resource = await json<Artifact>(`/${value.reference}`);
    if (token !== selectionVersion || disposed) return;
    relation = undefined;
    selectedArtifact = value;
    selection = value.reference;
    showPane("explore");
    el("explore-empty").hidden = true;
    el("table-inspector").hidden = true;
    el("artifact-inspector").hidden = false;
    el("artifact-title").textContent = value.title;
    el("artifact-kind").textContent = value.reference;
    el("artifact-canonical").textContent = value.url ? canonical(value) : "No canonical URL";
    el("artifact-notice").textContent = value.generated ? "Generated from the source schema. Read-only; restart the server after schema changes." :
      "Stored artifact. Edit its JSON and save to update it. Keep the resource type and ID unchanged.";
    editor("artifact-json").value = pretty(resource);
    inspectedJson = editor("artifact-json").value;
    editor("artifact-json").readOnly = value.generated;
    button("artifact-save").disabled = value.generated;
    button("artifact-load-sql").hidden = value.resourceType !== "Library";
    button("artifact-use-operation").hidden = !["Library", "ViewDefinition"].includes(value.resourceType);
    renderCatalog();
    status(`Loaded ${value.reference}.`);
  }

  function confirmReplaceSql() {
    const unchanged = editor("sql-editor").value.trim() === DEFAULT_SQL && input("library-id").value === "playground-query" &&
      !input("library-url").value && !input("library-title").value && !input("library-version").value &&
      select("library-kind").value === "sql-query" && !dependencies.length &&
      editor("parameter-declarations").value.trim() === "[]" && editor("sql-parameters").value === EMPTY_PARAMETERS;
    return unchanged || doc.defaultView?.confirm("Replace the current SQL workspace, including unsaved SQL and metadata?") === true;
  }

  function confirmDiscardArtifact() {
    if (el("artifact-inspector").hidden || editor("artifact-json").readOnly || editor("artifact-json").value === inspectedJson) return true;
    if (doc.defaultView?.confirm("Discard unsaved artifact JSON edits?") !== true) return false;
    editor("artifact-json").value = inspectedJson;
    return true;
  }

  function resetWorkspace() {
    input("library-id").value = "playground-query";
    select("library-kind").value = "sql-query";
    for (const id of ["library-url", "library-version", "library-title"]) input(id).value = "";
    editor("sql-editor").value = DEFAULT_SQL;
    editor("parameter-declarations").value = "[]";
    editor("sql-parameters").value = EMPTY_PARAMETERS;
    dependencies = [];
    sourceLibrary = undefined;
    invalidateGenerated();
    renderDependencies();
  }

  async function makeLibrary(): Promise<Artifact> {
    const version = ++generationVersion;
    const resource = await json<Artifact>("/playground/api/library", post({
      id: input("library-id").value,
      kind: select("library-kind").value,
      sql: editor("sql-editor").value,
      title: input("library-title").value,
      version: input("library-version").value,
      ...(input("library-url").value ? { url: input("library-url").value } : {}),
      ...(sourceLibrary ? { source: sourceLibrary } : {}),
      dependencies, parameters: parseArray(editor("parameter-declarations").value, "Parameter declarations"),
    }, "application/json"));
    if (version === generationVersion && !disposed) {
      generated = resource;
      editor("generated-json").value = pretty(resource);
      button("generated-download").disabled = false;
    }
    return resource;
  }

  function renderRows(target: string, data: unknown) {
    const container = el(target);
    container.replaceChildren();
    if (Array.isArray(data) && data.every(record)) {
      const columns = [...new Set(data.flatMap((row) => Object.keys(row)))];
      container.append(makeTable(columns, data, `${data.length} result rows`));
    }
  }

  async function runSql() {
    status("Running read-only SQL...");
    el("sql-results").replaceChildren();
    el("sql-result-status").textContent = "Running query...";
    try {
      const values = parseObject(editor("sql-parameters").value, "Query input values");
      const limit = Number(input("sql-limit").value);
      const library = await makeLibrary();
      const requestBody = buildOperation({
        operation: "sql-run", subject: subjectPart("inline", library), format: "json",
        limit, header: true, parameters: values,
        context: [], exportName: "", trackingId: "",
      });
      const result = await request("/$sql-run", post(requestBody));
      renderRows("sql-results", result.data);
      el("sql-result-status").textContent = `${Array.isArray(result.data) ? result.data.length : 0} rows returned by POST /$sql-run.`;
      status("SQL completed.");
    } catch (error) {
      el("sql-result-status").textContent = "Query failed. See the error details above.";
      throw error;
    }
  }

  function download(resource: FhirObject) {
    const blob = new Blob([pretty(resource) + "\n"], { type: "application/fhir+json" });
    const url = URL.createObjectURL(blob);
    const anchor = doc.createElement("a");
    anchor.href = url;
    anchor.download = `${String(resource.id ?? "artifact").replace(/[^A-Za-z0-9.-]/g, "-")}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function operationFields() {
    const mode = select("operation-subject-kind").value;
    el("reference-subject").hidden = mode !== "reference";
    el("canonical-subject").hidden = mode !== "canonical";
    el("inline-subject").hidden = mode !== "inline";
    const exporting = select("operation-kind").value === "sql-export";
    el("run-limit-field").hidden = exporting;
    el("envelope-field").hidden = exporting;
    el("export-name-field").hidden = !exporting;
    el("tracking-field").hidden = !exporting;
  }

  async function buildRequest() {
    const mode = select("operation-subject-kind").value;
    const envelope = input("operation-envelope").checked;
    const fields = {
      operation: select("operation-kind").value === "sql-export" ? "sql-export" as const : "sql-run" as const,
      format: select("operation-format").value,
      limit: Number(input("operation-limit").value), header: input("operation-header").checked,
      parameters: parseObject(editor("operation-parameters").value, "Operation input values"),
      context: parseArray(editor("operation-context").value, "Supporting context"),
      exportName: input("operation-export-name").value, trackingId: input("operation-tracking").value,
    };
    let subject: FhirObject;
    if (mode === "workspace") subject = subjectPart("inline", await makeLibrary());
    else if (mode === "reference") {
      const reference = select("operation-reference").value;
      if (!reference) throw new Error("No stored runnable artifacts. Save a Library or choose the SQL workspace.");
      subject = subjectPart("reference", reference);
    } else if (mode === "canonical") {
      if (!input("operation-canonical").value.trim()) throw new Error("Enter a subject canonical URL");
      subject = subjectPart("canonical", input("operation-canonical").value);
    } else subject = subjectPart("inline", parseObject(editor("operation-inline").value, "Inline subject"));
    const body = buildOperation({ ...fields, subject });
    editor("operation-request").value = pretty(body);
    updateHttpPreview(fields.operation, envelope);
    return body;
  }

  function updateHttpPreview(operation = select("operation-kind").value, envelope = input("operation-envelope").checked) {
    const exporting = operation === "sql-export";
    el("operation-http").textContent = `POST /$${operation}\nContent-Type: application/fhir+json\n` +
      (exporting ? "Prefer: respond-async" : `Accept: ${envelope ? "application/fhir+json" : "*/*"}`);
  }

  function sameOriginUrl(value: string, pattern: RegExp): string {
    const url = new URL(value, doc.URL);
    if (url.origin !== new URL(doc.URL).origin || !pattern.test(url.pathname) || url.search || url.hash) throw new Error("Server returned an unexpected export URL");
    return url.href;
  }

  function renderResponse(data: unknown, raw: string) {
    el("operation-response").textContent = typeof data === "object" && data !== null ? pretty(data) : raw;
    renderRows("operation-results", data);
    el("export-downloads").replaceChildren();
    if (record(data) && data.resourceType === "Binary" && typeof data.data === "string") {
      const decoded = new TextDecoder().decode(Uint8Array.from(atob(data.data), (c) => c.charCodeAt(0)));
      const pre = doc.createElement("pre");
      pre.tabIndex = 0;
      pre.setAttribute("aria-label", "Decoded Binary content");
      pre.textContent = decoded;
      el("operation-results").append(pre);
    }
    if (record(data) && data.resourceType === "Parameters" && Array.isArray(data.parameter)) {
      for (const output of data.parameter.filter(record).filter((p) => p.name === "output")) {
        const parts = Array.isArray(output.part) ? output.part.filter(record) : [];
        const name = String(parts.find((p) => p.name === "name")?.valueString ?? "output");
        for (const location of parts.filter((p) => p.name === "location" && typeof p.valueUri === "string")) {
          const link = doc.createElement("a");
          link.href = sameOriginUrl(String(location.valueUri), /^\/\$sql-export\/[0-9a-f-]{36}\/[A-Za-z0-9_-]+\.(json|ndjson|csv)$/);
          link.textContent = `Download ${name}`;
          link.download = "";
          el("export-downloads").append(link);
        }
      }
    }
  }

  async function operationRequest(path: string, init?: RequestInit) {
    try { return await request(path, init); }
    catch (error) {
      if (error instanceof ApiError) {
        renderResponse(error.payload, typeof error.payload === "string" ? error.payload : pretty(error.payload));
        el("operation-response-status").textContent = `HTTP ${error.status}: operation failed.`;
      }
      throw error;
    }
  }

  async function checkExport() {
    if (!jobUrl) throw new Error("No export job is selected");
    const result = await operationRequest(jobUrl);
    renderResponse(result.data, result.raw);
    el("operation-response-status").textContent = result.response.status === 202 ?
      "Export is still running. Check status again shortly." : `HTTP ${result.response.status}: export result. Downloads are available below.`;
    status(result.response.status === 202 ? "Export is pending." : "Export completed.");
  }

  async function sendOperation() {
    const operation = select("operation-kind").value;
    const envelope = input("operation-envelope").checked;
    const body = input("use-edited-request").checked ? parseObject(editor("operation-request").value, "Operation request") : await buildRequest();
    updateHttpPreview(operation, envelope);
    const exporting = operation === "sql-export";
    const init = post(body);
    init.headers = { "Content-Type": "application/fhir+json", ...(exporting ? { Prefer: "respond-async" } :
      { Accept: envelope ? "application/fhir+json" : "*/*" }) };
    jobUrl = undefined;
    el("export-controls").hidden = true;
    el("export-location").textContent = "";
    el("operation-results").replaceChildren();
    el("export-downloads").replaceChildren();
    el("operation-response").textContent = "";
    el("operation-response-status").textContent = "Sending request...";
    const result = await operationRequest(`/$${operation}`, init);
    renderResponse(result.data, result.raw);
    el("operation-response-status").textContent = `HTTP ${result.response.status} / ${result.response.headers.get("Content-Type") ?? "no content type"}`;
    if (exporting) {
      const location = result.response.headers.get("Content-Location");
      if (!location) throw new Error("Export response did not include Content-Location");
      jobUrl = sameOriginUrl(location, /^\/\$sql-export\/[0-9a-f-]{36}\/status$/);
      el("export-controls").hidden = false;
      el("export-location").textContent = `Status URL: ${jobUrl}`;
      await checkExport();
    } else status("FHIR operation completed.");
  }

  for (const tab of doc.querySelectorAll<HTMLButtonElement>("[data-pane]")) {
    const handler = () => showPane(tab.dataset.pane as Pane);
    tab.addEventListener("click", handler);
    listeners.push(() => tab.removeEventListener("click", handler));
  }
  on("refresh", "click", refresh);
  on("browser-kind", "change", renderCatalog);
  on("catalog-search", "input", renderCatalog);
  on("preview-table", "click", () => loadRows(0));
  on("table-next", "click", () => loadRows(pageOffset + pageLimit));
  on("table-previous", "click", () => loadRows(Math.max(0, pageOffset - pageLimit)));
  on("table-show-model", "click", async () => {
    const model = catalog?.artifacts.find((a) => a.reference === relation?.modelReference);
    if (!model) throw new Error("No logical model found for this relation");
    await selectArtifact(model);
  });
  on("table-add-dependency", "click", () => {
    const model = catalog?.artifacts.find((a) => a.reference === relation?.modelReference);
    if (!model || !relation) throw new Error("Select a table first");
    const label = addDependency(model, relation.name);
    showPane("sql");
    status(`Added dependency ${label}. Use "${label.replaceAll('"', '""')}" in SQL.`);
  });
  on("table-start-sql", "click", () => {
    if (!relation || !confirmReplaceSql()) return;
    const selected = relation;
    resetWorkspace();
    const model = catalog?.artifacts.find((a) => a.reference === selected.modelReference);
    if (!model) throw new Error("No model for this table");
    const label = addDependency(model, selected.name);
    editor("sql-editor").value = `SELECT * FROM "${label.replaceAll('"', '""')}";`;
    showPane("sql");
    status(`Started a query over ${selected.name}.`);
  });
  on("add-dependency", "click", () => {
    const artifact = catalog?.artifacts.find((a) => a.reference === select("dependency-source").value);
    if (!artifact) throw new Error("Choose a dependency artifact");
    addDependency(artifact, artifact.title);
    status("Dependency added. Use its SQL label in the statement.");
  });
  on("new-query", "click", () => { if (confirmReplaceSql()) { resetWorkspace(); status("New SQL workspace."); } });
  for (const id of ["sql-editor", "library-id", "library-url", "library-title", "library-version", "library-kind", "parameter-declarations"]) on(id, "input", invalidateGenerated);
  on("generate-library", "click", async () => { await makeLibrary(); status("Generated Library JSON. Nothing executed or saved."); });
  on("generated-download", "click", () => { if (!generated) throw new Error("Generate a Library first"); download(generated); });
  on("run-sql", "click", runSql);
  on("save-library", "click", async () => {
    const library = await makeLibrary();
    if (catalog?.artifacts.some((a) => a.reference === `Library/${library.id}`) &&
      doc.defaultView?.confirm(`Replace stored Library/${library.id}?`) !== true) return;
    await request(`/Library/${encodeURIComponent(library.id)}`, { ...post(library), method: "PUT" });
    await refresh();
    status(`Saved Library/${library.id}. It can now be referenced by FHIR operations${select("library-kind").value === "sql-view" ? " and used as a SQL dependency" : ""}.`);
  });
  on("artifact-save", "click", async () => {
    if (!selectedArtifact || selectedArtifact.generated) throw new Error("Generated artifacts cannot be changed");
    const reference = selectedArtifact.reference;
    const token = selectionVersion;
    const submitted = editor("artifact-json").value;
    const result = await json<Artifact>(`/${reference}`, { ...post(parseObject(submitted, "Artifact JSON")), method: "PUT" });
    if (token === selectionVersion && !disposed) {
      inspectedJson = pretty(result);
      if (editor("artifact-json").value === submitted) editor("artifact-json").value = inspectedJson;
    }
    await refresh();
    status(`Saved ${reference}.`);
  });
  on("artifact-download", "click", () => download(parseObject(editor("artifact-json").value, "Artifact JSON")));
  on("artifact-load-sql", "click", async () => {
    if (!selectedArtifact || !confirmDiscardArtifact() || !confirmReplaceSql()) return;
    const token = selectionVersion;
    const version = generationVersion;
    const result = await json<{ resource: Artifact; sql: string; kind: string }>(`/playground/api/workspace?${new URLSearchParams({ reference: selectedArtifact.reference })}`);
    if (disposed) return;
    if (token !== selectionVersion || version !== generationVersion) {
      status("Library loading cancelled because the selection or SQL workspace changed.");
      return;
    }
    const library = result.resource;
    sourceLibrary = library;
    input("library-id").value = library.id;
    input("library-url").value = library.url ?? "";
    input("library-version").value = library.version ?? "";
    input("library-title").value = typeof library.title === "string" ? library.title : "";
    select("library-kind").value = result.kind;
    editor("sql-editor").value = result.sql;
    editor("parameter-declarations").value = pretty(library.parameter ?? []);
    editor("sql-parameters").value = EMPTY_PARAMETERS;
    dependencies = (Array.isArray(library.relatedArtifact) ? library.relatedArtifact : []).filter(record)
      .filter((d) => d.type === "depends-on").map((d) => ({ label: String(d.label), resource: String(d.resource) }));
    invalidateGenerated();
    renderDependencies();
    showPane("sql");
    status(`Loaded Library/${library.id} into the SQL workspace.`);
  });
  on("artifact-use-operation", "click", () => {
    if (!selectedArtifact) throw new Error("Select a stored artifact first");
    select("operation-subject-kind").value = "reference";
    select("operation-reference").value = selectedArtifact.reference;
    editor("operation-parameters").value = EMPTY_PARAMETERS;
    input("use-edited-request").checked = false;
    operationFields();
    showPane("operations");
    status(`Selected ${selectedArtifact.reference} as the operation subject.`);
  });
  on("sql-to-operation", "click", async () => {
    await makeLibrary();
    select("operation-subject-kind").value = "workspace";
    input("use-edited-request").checked = false;
    editor("operation-parameters").value = editor("sql-parameters").value;
    operationFields();
    showPane("operations");
    await buildRequest();
    status("Operation request built from the current SQL workspace.");
  });
  for (const id of ["operation-kind", "operation-subject-kind", "operation-envelope"]) on(id, "change", () => { operationFields(); updateHttpPreview(); });
  on("build-operation", "click", async () => { await buildRequest(); status("FHIR Parameters request built. Send it when ready."); });
  on("send-operation", "click", sendOperation);
  on("check-export", "click", checkExport);
  on("delete-export", "click", async () => {
    if (!jobUrl) throw new Error("No export is selected");
    await request(jobUrl, { method: "DELETE" });
    jobUrl = undefined;
    el("export-controls").hidden = true;
    el("export-downloads").replaceChildren();
    el("operation-results").replaceChildren();
    el("operation-response").textContent = "";
    el("operation-response-status").textContent = "Export cancelled/deleted. Its result and download URLs are no longer available.";
    status("Export cancelled/deleted.");
  });
  renderDependencies();
  operationFields();
  await perform(refresh);
  return {
    refresh,
    dispose() { disposed = true; selectionVersion++; for (const remove of listeners) remove(); },
  };
}

if (typeof document !== "undefined") {
  void initializePlayground().catch((error: unknown) => {
    const target = document.getElementById("status");
    if (target) target.textContent = `Playground initialization failed: ${error instanceof Error ? error.message : String(error)}`;
    console.error("Playground initialization failed", error);
  });
}
