import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { artifact, ArtifactStore, Catalog } from "../src/store.js";
import { createLogicalModels } from "../src/models.js";
import { readSqliteSchema } from "../src/schema.js";
import { QueryEngine } from "../src/engine.js";
import { array, object } from "../src/fhir.js";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/server.js";
import type { ServerOptions } from "../src/server.js";
import type { FhirObject } from "../src/fhir.js";

export function operatorExamples() {
  const load = (name: string): unknown => JSON.parse(readFileSync(new URL(`../../examples/${name}.json`, import.meta.url), "utf8"));
  const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
  const example = /### Curated clinic model\s+```json\s+([\s\S]*?)```/.exec(readme);
  if (!example) throw new Error("Missing curated model example in README");
  return { person: artifact(JSON.parse(example[1]!)), relations: load("relations") as Record<string, string>,
    annotations: load("annotations") as FhirObject[] };
}

export function fixture(t: TestContext, maxRows = 1000, extraSchema = "") {
  const root = resolve(".data");
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, "test-"));
  const cleanup: (() => void | Promise<void>)[] = [];
  t.after(async () => {
    for (const close of cleanup.reverse()) await close();
    rmSync(directory, { recursive: true, force: true });
  });
  const database = join(directory, "source.sqlite");
  const artifacts = join(directory, "artifacts.sqlite");
  const db = new DatabaseSync(database);
  try {
    db.exec(readFileSync(new URL("../../examples/clinic.sql", import.meta.url), "utf8"));
    if (extraSchema) db.exec(extraSchema);
  } finally { db.close(); }
  const models = createLogicalModels(readSqliteSchema(database));
  const store = new ArtifactStore(artifacts);
  cleanup.push(() => store.close());
  const samples = object(JSON.parse(readFileSync(new URL("../../examples/artifacts.json", import.meta.url), "utf8")));
  for (const entry of array(samples.entry, "entry")) store.put(object(entry).resource);
  const catalog = new Catalog(store, models.resources);
  const engine = new QueryEngine(database, catalog, models.bindings, maxRows);
  return { directory, database, artifacts, store, catalog, engine, models, cleanup };
}

export function sample(id: string) {
  const bundle = object(JSON.parse(readFileSync(new URL("../../examples/artifacts.json", import.meta.url), "utf8")));
  return array(bundle.entry, "entry").map((e) => artifact(object(e).resource)).find((r) => r.id === id)!;
}

export async function serverFixture(t: TestContext, options: Omit<ServerOptions, "database" | "artifacts"> = {}, extraSchema = "") {
  const setup = fixture(t, options.maxRows, extraSchema);
  async function open() {
    const app = createApp({ database: setup.database, artifacts: setup.artifacts, ...options });
    app.server.listen(0, "127.0.0.1");
    await once(app.server, "listening");
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    return { app, base };
  }
  let { app, base } = await open();
  const close = async () => {
    await new Promise<void>((resolve, reject) => app.server.close((error) => error ? reject(error) : resolve()));
    app.close();
  };
  setup.cleanup.push(close);
  return { ...setup, base, reopen: async () => {
    await close();
    ({ app, base } = await open());
    return base;
  } };
}

export const postBody = (body: unknown, extra: Record<string, string> = {}) => ({
  method: "POST", headers: { "Content-Type": "application/fhir+json", ...extra }, body: JSON.stringify(body),
});
