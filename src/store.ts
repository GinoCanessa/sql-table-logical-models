import { DatabaseSync } from "node:sqlite";
import { array, fail, object, text } from "./fhir.js";
import type { Artifact, FhirObject } from "./fhir.js";
import { readRelation } from "./relation.js";

export const RESOURCE_TYPES = ["StructureDefinition", "Library", "ViewDefinition"];

function interpret(resource: Artifact, issues?: FhirObject[]): Artifact {
  const relation = readRelation(resource);
  if (relation && issues) issues.push(...relation.issues);
  return resource;
}

export function artifact(value: unknown, requireId = true): Artifact {
  const resource = object(value, "artifact");
  if (!RESOURCE_TYPES.includes(String(resource.resourceType))) fail(400, "not-supported", "Supported artifacts: StructureDefinition, Library, ViewDefinition");
  if (requireId && (typeof resource.id !== "string" || !/^[A-Za-z0-9.-]{1,64}$/.test(resource.id))) {
    fail(400, "invalid", "Artifact id must be a FHIR id (1-64 letters, digits, hyphens or periods)");
  }
  if (resource.id !== undefined && (typeof resource.id !== "string" || !/^[A-Za-z0-9.-]{1,64}$/.test(resource.id))) {
    fail(400, "invalid", "Invalid artifact id");
  }
  if (resource.url !== undefined) {
    const url = text(resource.url, "url");
    if (!/^https?:\/\/[^|?#]+$/.test(url)) fail(400, "invalid", "Artifact url must be an absolute HTTP(S) canonical without a version suffix, query or fragment");
  }
  if (resource.version !== undefined) {
    const version = text(resource.version, "version");
    if (version.includes("|")) fail(400, "invalid", "version cannot contain '|'");
  }
  return { ...resource, resourceType: String(resource.resourceType), id: typeof resource.id === "string" ? resource.id : "inline" };
}

export class ArtifactStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path, { allowExtension: false });
    this.db.exec(`CREATE TABLE IF NOT EXISTS artifacts (
      resource_type TEXT NOT NULL, id TEXT NOT NULL, url TEXT, version TEXT NOT NULL,
      json TEXT NOT NULL, PRIMARY KEY (resource_type, id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS artifact_canonical ON artifacts(url, version) WHERE url IS NOT NULL;`);
  }

  list(type?: string): Artifact[] {
    const rows = type ? this.db.prepare("SELECT json FROM artifacts WHERE resource_type = ? ORDER BY id").all(type) :
      this.db.prepare("SELECT json FROM artifacts ORDER BY resource_type, id").all();
    return rows.map((row) => artifact(JSON.parse(String(row.json))));
  }

  get(type: string, id: string): Artifact | undefined {
    const row = this.db.prepare("SELECT json FROM artifacts WHERE resource_type = ? AND id = ?").get(type, id);
    return row ? artifact(JSON.parse(String(row.json))) : undefined;
  }

  put(value: unknown, issues?: FhirObject[]): Artifact {
    const resource = interpret(artifact(value), issues);
    try {
      this.db.prepare(`INSERT INTO artifacts(resource_type, id, url, version, json) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(resource_type, id) DO UPDATE SET url=excluded.url, version=excluded.version, json=excluded.json`)
        .run(resource.resourceType, resource.id, resource.url ?? null, resource.version ?? "", JSON.stringify(resource));
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
        fail(409, "conflict", "Another artifact already owns this canonical URL and version");
      }
      throw error;
    }
    return resource;
  }

  delete(type: string, id: string): boolean {
    return Number(this.db.prepare("DELETE FROM artifacts WHERE resource_type = ? AND id = ?").run(type, id).changes) > 0;
  }

  close(): void {
    this.db.close();
  }
}

export class Catalog {
  constructor(
    readonly store: ArtifactStore,
    readonly generated: Artifact[],
  ) {}

  list(type?: string): Artifact[] {
    return [...this.generated, ...this.store.list()].filter((r) => !type || r.resourceType === type);
  }

  get(reference: string, issues?: FhirObject[]): Artifact {
    if (!/^(StructureDefinition|Library|ViewDefinition)\/[A-Za-z0-9.-]{1,64}$/.test(reference)) {
      fail(400, "invalid", "subjectReference must be a local ResourceType/id reference");
    }
    return interpret(this.list().find((r) => `${r.resourceType}/${r.id}` === reference) ??
      fail(404, "not-found", `Artifact not found: ${reference}`), issues);
  }

  resolve(canonical: string, context: Artifact[] = [], issues?: FhirObject[]): Artifact {
    const [url, version, extra] = canonical.split("|");
    if (!url || extra !== undefined || (canonical.includes("|") && !version)) fail(400, "invalid", "Invalid canonical reference");
    const match = (r: Artifact) => r.url === url && (version === undefined || r.version === version);
    const supplied = context.filter(match);
    const candidates = supplied.length ? supplied : this.list().filter(match);
    if (candidates.length > 1) fail(409, "conflict", `Ambiguous canonical; pin a unique version: ${canonical}`);
    return interpret(candidates[0] ?? fail(404, "not-found", `Unresolved dependency: ${canonical}`), issues);
  }

  put(value: unknown, issues?: FhirObject[]): Artifact {
    const resource = artifact(value);
    if (this.generated.some((r) =>
      (r.resourceType === resource.resourceType && r.id === resource.id) ||
      (resource.url && r.url === resource.url && r.version === resource.version))) {
      fail(409, "conflict", "Generated schema artifacts are read-only; change the database and restart");
    }
    return this.store.put(resource, issues);
  }
}

export function parameters(value: unknown): FhirObject[] {
  const resource = object(value, "Parameters");
  if (resource.resourceType !== "Parameters") fail(400, "invalid", "Expected a FHIR Parameters resource");
  return array(resource.parameter, "parameter").map((p) => object(p, "parameter"));
}
