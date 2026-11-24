import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { BINARY_CONTENT_MODEL, EXP, OperationError, RELATION, SOF, fail, object } from "./fhir.js";
import type { FhirObject } from "./fhir.js";
import { QueryEngine } from "./engine.js";
import { ExportJobs } from "./exports.js";
import { createLogicalModels } from "./models.js";
import type { ModelOptions } from "./models.js";
import { assignedId, parseExport, parseRun, queryParameters, runOperation } from "./operations.js";
import { readSqliteSchema } from "./schema.js";
import { ArtifactStore, Catalog, RESOURCE_TYPES } from "./store.js";
import { generateLibrary, libraryWorkspace, playgroundCatalog, previewTable } from "./playground.js";

export interface ServerOptions extends ModelOptions {
  database: string;
  artifacts: string;
  maxRows?: number;
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
        { name: "output", use: "out", min: 0, max: "*", part: [out("name", "string", 1), out("location", "uri", 1, "*")] },
      ] : [{
        ...out("return", "Binary", 1), documentation: "Native JSON, NDJSON or CSV, or a negotiated FHIR Binary envelope.",
        extension: [{ url: BINARY_CONTENT_MODEL, valueCanonical: RELATION }],
      }]),
    ],
  };
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
  const baseUrl = (options.baseUrl ?? "https://example.org/sql").replace(/\/+$/, "");
  const store = new ArtifactStore(options.artifacts);
  const catalog = new Catalog(store, derived.resources);
  const engine = new QueryEngine(options.database, catalog, derived.bindings, options.maxRows);
  const jobs = new ExportJobs(options.artifacts, engine);

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
        send(res, 200, file.body, file.contentType);
      }
      return;
    }
    const match = /^\/(StructureDefinition|Library|ViewDefinition)(?:\/([A-Za-z0-9.-]{1,64}))?$/.exec(path);
    if (match) {
      const type = match[1]!;
      const id = match[2];
      if (method === "GET") {
        if (id) send(res, 200, catalog.get(`${type}/${id}`));
        else {
          for (const name of url.searchParams.keys()) {
            if (!["url", "version"].includes(name) || url.searchParams.getAll(name).length > 1) fail(400, "not-supported", `Unsupported search parameter: ${name}`);
          }
          const resources = catalog.list(type).filter((r) =>
            (!url.searchParams.has("url") || r.url === url.searchParams.get("url")) &&
            (!url.searchParams.has("version") || r.version === url.searchParams.get("version")));
          send(res, 200, { resourceType: "Bundle", type: "searchset", total: resources.length, entry: resources.map((resource) => ({ resource })) });
        }
        return;
      }
      if ((method === "POST" && !id) || (method === "PUT" && id)) {
        const input = object(await body(req), type);
        if (input.resourceType !== type || (id && input.id !== undefined && input.id !== id)) fail(400, "invalid", "Artifact type/id must match the request URL");
        const actualId = id ?? assignedId();
        const existed = catalog.list(type).some((r) => r.id === actualId);
        const issues: FhirObject[] = [];
        const resource = catalog.put({ ...input, id: actualId }, issues);
        res.setHeader("Location", `/${type}/${resource.id}`);
        if (issues.length) res.setHeader("X-Relation-Issue-Count", issues.length);
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
        if (catalog.generated.some((r) => r.resourceType === type && r.id === id)) fail(409, "conflict", "Generated schema artifacts are read-only");
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
