import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { BINARY_CONTENT_MODEL, EXP, OperationError, RELATION, SOF, fail, object } from "./fhir.js";
import type { Artifact, FhirObject } from "./fhir.js";
import { QueryEngine } from "./engine.js";
import { ExportJobs } from "./exports.js";
import { ConfiguredRelations, createLogicalModels } from "./models.js";
import type { ModelOptions } from "./models.js";
import { assignedId, parseDescribe, parseExport, parseRun, queryParameters, runOperation } from "./operations.js";
import { AFF, featureDefinitions, featureQuery, featureSupport, requireFeatures } from "./features.js";
import { runProfile } from "./describe.js";
import { readSqliteSchema } from "./schema.js";
import { ArtifactStore, Catalog, RESOURCE_TYPES } from "./store.js";
import { generateLibrary, libraryWorkspace, playgroundCatalog, previewTable } from "./playground.js";

export interface ServerOptions extends ModelOptions {
  database: string;
  artifacts: string;
  maxRows?: number;
  relationValidation?: "warn" | "error";
  verifyOutput?: boolean;
  relations?: Record<string, string>;
}

const PLAYGROUND_FILES = new Map([
  ["/playground/", ["../../ui/index.html", "text/html"]],
  ["/playground/playground.css", ["../../ui/playground.css", "text/css"]],
  ["/playground/app.js", ["../../dist/ui/app.js", "text/javascript"]],
  ["/playground/workspace.js", ["../../dist/ui/workspace.js", "text/javascript"]],
]);

function capability(): FhirObject {
  return {
    resourceType: "CapabilityStatement", status: "draft", experimental: true,
    date: "2026-11-17", kind: "instance", fhirVersion: "5.0.0",
    format: ["json"], software: { name: "SQL table logical models", version: "0.1.0" },
    extension: [featureSupport],
    implementation: { description: "Local exploration server; partial SQL-on-FHIR behavior with experimental external relations" },
    rest: [{
      mode: "server",
      documentation: "No authentication. Loopback development only. Outputs: json, ndjson, csv; Binary JSON envelopes on sql-run. maxRows applies to every evaluation. No patient/group filters, terminology, arbitrary FHIRPath, Parquet or FHIR row format.",
      resource: RESOURCE_TYPES.map((type) => ({
        type,
        interaction: ["read", "search-type", "create", "update", "delete"].map((code) => ({ code })),
        documentation: type === "StructureDefinition" ? "Generated schema models are read-only; imported logical models require a configured physical binding." : "Local persistence only; not a full FHIR REST server.",
      })),
      operation: [
        { name: "sql-run", definition: `${EXP}/OperationDefinition/sql-run` },
        { name: "sql-export", definition: `${EXP}/OperationDefinition/sql-export` },
        { name: "sql-describe", definition: `${EXP}/OperationDefinition/sql-describe` },
        { name: "feature-query", definition: `${AFF}/OperationDefinition/feature-query` },
      ],
    }],
  };
}

function operationDefinition(isExport: boolean): FhirObject {
  const code = isExport ? "sql-export" : "sql-run";
  const parameter = (name: string, type: string, min = 0, max = "1") => ({ name, use: "in", type, min, max });
  const out = (name: string, type: string, min = 0, max = "1") => ({ name, use: "out", type, min, max });
  const subject = [parameter("subjectCanonical", "canonical"), parameter("subjectReference", "Reference"),
    parameter("subjectResource", "CanonicalResource"), parameter("parameters", "Parameters")];
  return {
    resourceType: "OperationDefinition", id: code, url: `${EXP}/OperationDefinition/${code}`,
    name: isExport ? "ExperimentalSQLExport" : "ExperimentalSQLRun",
    status: "draft", experimental: true, kind: "operation", code, system: true, type: false, instance: false,
    affectsState: isExport, base: `${SOF}/OperationDefinition/${isExport ? "SQLExport" : "SQLRun"}`,
    description: "Partial local implementation; external logical-model relations and ViewDefinition source extension are experimental. See docs for limits and unsupported features.",
    parameter: [
      ...(isExport ? [{
        name: "subject", use: "in", min: 1, max: "*", part: [parameter("name", "string"), ...subject],
      }] : [...subject, parameter("_limit", "integer")]),
      parameter("context", "CanonicalResource", 0, "*"), parameter("_format", "code"), parameter("header", "boolean"),
      ...(isExport ? [
        parameter("clientTrackingId", "string"),
        out("exportId", "string", 1), out("status", "code", 1), out("location", "uri", 1),
        out("clientTrackingId", "string"), out("_format", "code"), out("exportStartTime", "instant"), out("exportEndTime", "instant"),
        { name: "output", use: "out", min: 0, max: "*", part: [out("name", "string", 1), out("location", "uri", 1, "*"), out("model", "canonical", 1)] },
      ] : [{
        ...out("return", "Binary", 1), documentation: "Native JSON, NDJSON or CSV, or a negotiated FHIR Binary envelope.",
        extension: [{ url: BINARY_CONTENT_MODEL, valueCanonical: RELATION }],
      }]),
    ],
  };
}

function describeDefinition(): FhirObject {
  const run = operationDefinition(false);
  const names = ["subjectReference", "subjectCanonical", "subjectResource", "context", "_format"];
  return { resourceType: "OperationDefinition", id: "sql-describe", url: `${EXP}/OperationDefinition/sql-describe`,
    code: "sql-describe", name: "ExperimentalSQLDescribe", system: true, type: false, instance: false, affectsState: false,
    status: "draft", kind: "operation", experimental: true,
    description: "Prepare without binding or stepping. Proposed names $viewdefinition-describe, $sqlquery-describe and $describe are not invocation routes.",
    parameter: [...(run.parameter as FhirObject[]).filter((p) => names.includes(String(p.name))),
      { name: "dialect", use: "in", min: 0, max: "1", type: "code" },
      { name: "return", use: "out", min: 1, max: "1", type: "Resource", documentation: "StructureDefinition by default; native SQL text or system run profile by _format." }] };
}

async function body(req: IncomingMessage): Promise<unknown> {
  if (!/^application\/(?:fhir\+)?json(?:\s*;|$)/i.test(req.headers["content-type"] ?? "")) fail(415, "not-supported", "Use application/json or application/fhir+json");
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 1024 * 1024) fail(413, "too-costly", "Request body exceeds 1 MiB");
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) fail(400, "invalid", "Malformed JSON request body");
    throw error;
  }
}

function send(res: ServerResponse, status: number, value?: unknown, contentType = "application/fhir+json"): void {
  res.writeHead(status, { "Content-Type": `${contentType}; charset=utf-8`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(value === undefined ? undefined : typeof value === "string" ? value : JSON.stringify(value));
}

function issueHeaders(res: ServerResponse, issues: FhirObject[]) {
  if (issues.length) res.setHeader("X-Relation-Issue-Count", issues.length);
  const warnings = issues.filter((i) => i.severity === "warning").length;
  if (warnings) res.setHeader("X-Relation-Warning-Count", warnings);
}

export function createApp(options: ServerOptions): { server: Server; close: () => void } {
  const normalizedPath = (path: string) => {
    const full = existsSync(path) ? realpathSync(path) : resolve(path);
    return process.platform === "win32" ? full.toLowerCase() : full;
  };
  if (normalizedPath(options.database) === normalizedPath(options.artifacts)) {
    throw new Error("Source database and writable artifact store must be different files");
  }
  if (existsSync(options.database) && existsSync(options.artifacts)) {
    const source = statSync(options.database);
    const target = statSync(options.artifacts);
    if (source.dev === target.dev && source.ino === target.ino) throw new Error("Source database and artifact store cannot be links to the same file");
  }
  const schema = readSqliteSchema(options.database);
  const derived = createLogicalModels(schema, options);
  const configured = options.relations === undefined ? undefined : new ConfiguredRelations(options.relations, schema, derived.resources, options.integerType);
  const baseUrl = (options.baseUrl ?? "https://example.org/sql").replace(/\/+$/, "");
  const store = new ArtifactStore(options.artifacts);
  let catalog: Catalog;
  try { catalog = new Catalog(store, derived.resources, options.relationValidation, configured); }
  catch (error) { store.close(); throw error; }
  const engine = new QueryEngine(options.database, catalog, derived.bindings, options.maxRows, options);
  const jobs = new ExportJobs(options.artifacts, engine);
  engine.snapshots = () => jobs.snapshots();

  function generatedContract(id?: string, url?: string, type?: string): Artifact | undefined {
    const matches = (r: Artifact) => (!type || type === r.resourceType) && (r.id === id || (!!url && r.url === url));
    if (!/^(result|run)-[a-f0-9]{48}$/.test(id ?? "") &&
      !/\/(?:StructureDefinition\/result|OperationDefinition\/run)-[a-f0-9]{48}$/.test(url ?? "")) return undefined;
    const snapshot = jobs.snapshots().find(matches);
    if (snapshot) return snapshot;
    for (const subject of catalog.list().filter((r) => r.resourceType === "Library" || r.resourceType === "ViewDefinition")) {
      try {
        const contract = engine.describe(subject);
        if (matches(contract.model)) return contract.model;
        const profile = runProfile(contract, operationDefinition(false), false);
        if (matches(profile)) return profile;
      } catch (error) { if (!(error instanceof OperationError)) throw error; }
    }
    return undefined;
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (!(error instanceof OperationError)) console.error("Request failed", error);
      const failure = error instanceof OperationError ? error :
        new OperationError(500, "exception", "Unexpected server error; see server log");
      send(res, failure.status, failure.outcome());
    });
  });
  server.requestTimeout = 30_000;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const base = `http://${req.headers.host ?? "localhost"}`;
    if (req.headers.origin && req.headers.origin !== base) fail(403, "forbidden", "Cross-origin requests are not supported");
    const url = new URL(req.url ?? "/", base);
    const path = url.pathname;
    const method = req.method;
    const required = req.headers["required-features"];
    if (required !== undefined && ["/$sql-run", "/$sql-export", "/$sql-describe"].includes(path)) requireFeatures(engine, String(required));
    if (method === "GET" && path.startsWith("/FeatureDefinition/")) {
      const def = featureDefinitions.find((d) => path === `/FeatureDefinition/${d.id}`) ?? fail(404, "not-found", "Unknown feature definition");
      send(res, 200, def, "application/json"); return;
    }
    if (path === "/$feature-query" && (method === "GET" || method === "POST")) {
      if (method === "POST" && url.search) fail(400, "invalid", "POST inputs belong in Parameters");
      send(res, 200, featureQuery(engine, method === "GET" ? url.searchParams : await body(req))); return;
    }
    if (path === "/$sql-describe" && (method === "GET" || method === "POST")) {
      if (method === "POST" && url.search) fail(400, "invalid", "POST inputs belong in Parameters");
      const request = parseDescribe(engine, method === "GET" ? queryParameters(url.searchParams) : await body(req));
      const issues: FhirObject[] = [];
      const contract = engine.describe(request.subject, request, issues);
      issueHeaders(res, issues);
      if (request.format === "sql") send(res, 200, contract.ddl, "application/sql");
      else send(res, 200, request.format === "operation" ? runProfile(contract, operationDefinition(false), request.local) : contract.model);
      return;
    }
    if (path === "/playground" && method === "GET") {
      res.setHeader("Location", "/playground/");
      send(res, 303);
      return;
    }
    const playgroundFile = PLAYGROUND_FILES.get(path);
    if (method === "GET" && playgroundFile) {
      send(res, 200, await readFile(new URL(playgroundFile[0]!, import.meta.url), "utf8"), playgroundFile[1]!);
      return;
    }
    if (method === "GET" && path === "/playground/api/catalog") {
      send(res, 200, playgroundCatalog(schema, engine, baseUrl), "application/json");
      return;
    }
    if (method === "GET" && path === "/playground/api/rows") {
      send(res, 200, previewTable(schema, engine, url.searchParams), "application/json");
      return;
    }
    if (method === "POST" && path === "/playground/api/library") {
      send(res, 200, generateLibrary(await body(req), baseUrl));
      return;
    }
    if (method === "GET" && path === "/playground/api/workspace") {
      send(res, 200, libraryWorkspace(catalog.get(url.searchParams.get("reference") ?? "")), "application/json");
      return;
    }
    if (method === "GET" && ["/", "/metadata"].includes(path)) {
      send(res, 200, capability());
      return;
    }
    if (method === "GET" && ["/OperationDefinition/sql-run", "/OperationDefinition/sql-export"].includes(path)) {
      send(res, 200, operationDefinition(path.endsWith("sql-export")));
      return;
    }
    if (method === "GET" && path === "/OperationDefinition/sql-describe") { send(res, 200, describeDefinition()); return; }
    if (method === "GET" && ["/docs", "/docs/", "/docs/index.html", "/docs/theme.css", "/docs/theme.js"].includes(path)) {
      const file = path.endsWith(".css") ? "theme.css" : path.endsWith(".js") ? "theme.js" : "index.html";
      send(res, 200, await readFile(new URL(`../../docs/${file}`, import.meta.url), "utf8"),
        file.endsWith(".css") ? "text/css" : file.endsWith(".js") ? "text/javascript" : "text/html");
      return;
    }
    if (path === "/$sql-run" && (method === "GET" || method === "POST")) {
      if (method === "POST" && url.search) fail(400, "invalid", "POST operation inputs belong in the Parameters body");
      const input = method === "GET" ? queryParameters(url.searchParams) : await body(req);
      const output = runOperation(engine, parseRun(engine, input, req.headers.accept));
      issueHeaders(res, output.issues);
      send(res, 200, output.body, output.contentType);
      return;
    }
    if (path === "/$sql-export" && method === "GET") fail(400, "required", "Export requires POST and Prefer: respond-async");
    if (path === "/$sql-export" && method === "POST") {
      if (url.search) fail(400, "invalid", "Export inputs belong in the Parameters body");
      const prefer = req.headers.prefer;
      if (!(Array.isArray(prefer) ? prefer.join(",") : prefer ?? "").split(",").some((v) => v.trim().toLowerCase() === "respond-async")) fail(400, "required", "Export requires Prefer: respond-async");
      const parsed = parseExport(engine, await body(req));
      const id = jobs.start(parsed.subjects, base, parsed.trackingId);
      res.setHeader("Content-Location", `${base}/$sql-export/${id}/status`);
      res.setHeader("Retry-After", "1");
      send(res, 202);
      return;
    }
    const exportPath = /^\/\$sql-export\/([0-9a-f-]{36})\/(status|result|[A-Za-z0-9_-]{1,64}\.(?:json|ndjson|csv))$/.exec(path);
    if (exportPath) {
      const id = exportPath[1]!;
      const target = exportPath[2]!;
      if (method === "DELETE" && target === "status") {
        jobs.delete(id);
        send(res, 202);
        return;
      }
      if (method !== "GET") fail(405, "not-supported", "Unsupported export method");
      const job = jobs.get(id);
      if (target === "status") {
        if (job.state === "running") {
          res.setHeader("Retry-After", "1");
          send(res, 202);
        } else {
          res.setHeader("Location", `${base}/$sql-export/${id}/result`);
          send(res, 303);
        }
      } else if (target === "result") {
        if (job.state === "running") fail(409, "conflict", "Export is still running");
        send(res, job.state === "failed" ? job.errorStatus ?? 500 : 200, job.result);
      } else {
        const file = job.files[target] ?? fail(404, "not-found", "Export file not found");
        if (file.issues) issueHeaders(res, file.issues);
        send(res, 200, file.body, file.contentType);
      }
      return;
    }
    const match = /^\/(OperationDefinition|StructureDefinition|Library|ViewDefinition)(?:\/([A-Za-z0-9.-]{1,64}))?$/.exec(path);
    if (match) {
      const type = match[1]!;
      const id = match[2];
      if (method === "GET") {
        if (id) {
          const generated = generatedContract(id, undefined, type);
          if (generated) send(res, 200, generated);
          else if (type === "OperationDefinition") fail(404, "not-found", "Operation profile not found");
          else {
            const issues: FhirObject[] = [];
            const r = catalog.get(`${type}/${id}`, issues);
            issueHeaders(res, issues);
            send(res, 200, r);
          }
        } else {
          for (const name of url.searchParams.keys()) {
            if (!["url", "version"].includes(name) || url.searchParams.getAll(name).length > 1) fail(400, "not-supported", `Unsupported search parameter: ${name}`);
          }
          const resources = catalog.list(type).filter((r) =>
            (!url.searchParams.has("url") || r.url === url.searchParams.get("url")) &&
            (!url.searchParams.has("version") || r.version === url.searchParams.get("version")));
          const contract = generatedContract(undefined, url.searchParams.get("url") ?? undefined, type);
          if (contract && (!url.searchParams.has("version") || contract.version === url.searchParams.get("version"))) resources.push(contract);
          if (type === "OperationDefinition" && !url.searchParams.has("version")) {
            for (const op of [operationDefinition(false), operationDefinition(true), describeDefinition()]) {
              if (!url.searchParams.has("url") || op.url === url.searchParams.get("url")) resources.push(op as Artifact);
            }
          }
          send(res, 200, { resourceType: "Bundle", type: "searchset", total: resources.length, entry: resources.map((resource) => ({ resource })) });
        }
        return;
      }
      if (type === "OperationDefinition") fail(405, "not-supported", "Operation definitions are read-only");
      if ((method === "POST" && !id) || (method === "PUT" && id)) {
        const input = object(await body(req), type);
        if (input.resourceType !== type || (id && input.id !== undefined && input.id !== id)) fail(400, "invalid", "Artifact type/id must match the request URL");
        const actualId = id ?? assignedId();
        if (generatedContract(actualId, undefined, type) || generatedContract(undefined, typeof input.url === "string" ? input.url : undefined)) {
          fail(409, "conflict", "Generated result contracts are read-only");
        }
        const existed = catalog.list(type).some((r) => r.id === actualId);
        const issues: FhirObject[] = [];
        const resource = catalog.put({ ...input, id: actualId }, issues);
        res.setHeader("Location", `/${type}/${resource.id}`);
        issueHeaders(res, issues);
        const prefer = String(req.headers.prefer ?? "").toLowerCase().split(",").map((p) => p.trim());
        if (prefer.includes("return=operationoutcome")) {
          res.setHeader("Preference-Applied", "return=OperationOutcome");
          send(res, existed ? 200 : 201, { resourceType: "OperationOutcome", issue: issues.length ? issues : [
            { severity: "information", code: "success", diagnostics: "Artifact saved." },
          ] });
        } else send(res, existed ? 200 : 201, resource);
        return;
      }
      if (method === "DELETE" && id) {
        if (generatedContract(id, undefined, type) || catalog.generated.some((r) => r.resourceType === type && r.id === id)) fail(409, "conflict", "Generated schema artifacts are read-only");
        if (!store.delete(type, id)) fail(404, "not-found", "Artifact not found");
        send(res, 204);
        return;
      }
      fail(405, "not-supported", "Unsupported artifact method");
    }
    fail(404, "not-found", "Unknown endpoint");
  }

  let closed = false;
  return { server, close: () => {
    if (closed) return;
    closed = true;
    jobs.close();
    store.close();
  } };
}
