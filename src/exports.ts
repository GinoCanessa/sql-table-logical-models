import { DatabaseSync } from "node:sqlite";
import { OperationError, fail } from "./fhir.js";
import type { Artifact, FhirObject } from "./fhir.js";
import { verifyWire } from "./conformance.js";
import type { QueryEngine } from "./engine.js";
import { MEDIA, assignedId, formatResult } from "./operations.js";
import type { ExportSubject } from "./operations.js";

interface Job {
  state: "running" | "complete" | "failed";
  errorStatus?: number;
  result: FhirObject | null;
  files: Record<string, { contentType: string; body: string; issues?: FhirObject[] }>;
  models?: Artifact[];
}

export class ExportJobs {
  private readonly db: DatabaseSync;
  private readonly pending = new Set<NodeJS.Immediate>();

  constructor(path: string, private readonly engine: QueryEngine) {
    this.db = new DatabaseSync(path, { allowExtension: false });
    this.db.exec("CREATE TABLE IF NOT EXISTS export_jobs (id TEXT PRIMARY KEY, json TEXT NOT NULL)");
    for (const row of this.db.prepare("SELECT id, json FROM export_jobs").all()) {
      const job = JSON.parse(String(row.json)) as Job;
      if (job.state === "running") {
        this.save(String(row.id), {
          state: "failed", errorStatus: 500, files: {},
          result: new OperationError(500, "exception", "Server stopped before this export completed").outcome(),
        });
      }
    }
  }

  private save(id: string, job: Job): void {
    this.db.prepare("INSERT INTO export_jobs(id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json=excluded.json").run(id, JSON.stringify(job));
  }

  get(id: string): Job {
    const row = this.db.prepare("SELECT json FROM export_jobs WHERE id = ?").get(id);
    return row ? JSON.parse(String(row.json)) as Job : fail(404, "not-found", "Export not found");
  }

  snapshots(): Artifact[] {
    // Query only model JSON, not every job's (potentially large) files.
    return this.db.prepare(`SELECT DISTINCT m.value AS model FROM export_jobs j, json_each(j.json, '$.models') m`)
      .all().map((row) => JSON.parse(String(row.model)) as Artifact);
  }

  start(subjects: ExportSubject[], base: string, trackingId?: string): string {
    const id = assignedId();
    const transactionTime = new Date().toISOString();
    this.save(id, { state: "running", result: null, files: {} });
    const handle = setImmediate(() => {
      this.pending.delete(handle);
      if (!this.db.prepare("SELECT id FROM export_jobs WHERE id = ?").get(id)) return;
      try {
        const files: Job["files"] = Object.create(null);
        const results = this.engine.runPreparedBatch(subjects.map(({ request }) => ({
          subject: request.subject, ...(request.parameters ? { parameters: request.parameters } : {}),
        })), { context: subjects[0]!.request.context });
        const outputs = subjects.map(({ name, request }, index) => {
          const result = results[index]!;
          const filename = `${name}.${request.format}`;
          const body = formatResult(result, request.format, request.header);
          const issues = result.issues.concat(this.engine.settings.verifyOutput ? verifyWire(result, body, request.format, request.header) : []);
          files[filename] = { contentType: MEDIA[request.format], body, ...(issues.length ? { issues } : {}) };
          return {
            name: "output", part: [
              { name: "name", valueString: name },
              { name: "location", valueUri: `${base}/$sql-export/${id}/${filename}` },
              { name: "model", valueCanonical: result.contract.model.url },
            ],
          };
        });
        this.save(id, {
          state: "complete", files, models: results.map((r) => r.contract.model),
          result: {
            resourceType: "Parameters",
            parameter: [
              { name: "exportId", valueString: id },
              { name: "status", valueCode: "completed" },
              { name: "location", valueUri: `${base}/$sql-export/${id}/status` },
              { name: "_format", valueCode: subjects[0]!.request.format },
              { name: "exportStartTime", valueInstant: transactionTime },
              { name: "exportEndTime", valueInstant: new Date().toISOString() },
              ...(trackingId ? [{ name: "clientTrackingId", valueString: trackingId }] : []),
              ...outputs,
            ],
          },
        });
      } catch (error) {
        if (!(error instanceof OperationError)) console.error("Export execution failed", error);
        this.save(id, {
          state: "failed", errorStatus: error instanceof OperationError ? error.status : 500, files: {},
          result: error instanceof OperationError ? error.outcome() :
            new OperationError(500, "exception", "Unexpected export error; see server log").outcome(),
        });
      }
    });
    this.pending.add(handle);
    return id;
  }

  delete(id: string): void {
    if (!this.db.prepare("DELETE FROM export_jobs WHERE id = ?").run(id).changes) fail(404, "not-found", "Export not found");
  }

  close(): void {
    for (const handle of this.pending) clearImmediate(handle);
    this.pending.clear();
    this.db.close();
  }
}
