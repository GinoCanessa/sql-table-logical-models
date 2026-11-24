import { parseArgs } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { array, object } from "./fhir.js";
import { createLogicalModels, modelSettings } from "./models.js";
import { readSqliteSchema } from "./schema.js";
import { ArtifactStore } from "./store.js";
import { createApp } from "./server.js";

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      database: { type: "string" }, artifacts: { type: "string", default: ".data/artifacts.sqlite" },
      base: { type: "string", default: "https://example.org/sql" },
      version: { type: "string" }, out: { type: "string" },
      "type-encoding": { type: "string" }, "relation-base": { type: "string" }, "integer-type": { type: "string" },
      "relation-validation": { type: "string" }, "verify-output": { type: "boolean" },
      port: { type: "string", default: "3000" }, "max-rows": { type: "string", default: "1000" },
      help: { type: "boolean", short: "h" },
    },
  });
  const command = positionals[0];
  if (values.help || !command) {
    console.log("Usage: node dist\\src\\cli.js <derive|serve|demo> --database <file> [--base <canonical>] [--version <version>]\n" +
      "derive: [--out <bundle.json>] (stdout if omitted)\n" +
      "derive/serve: [--type-encoding mapping|extension|both] [--relation-base local|sof] [--integer-type integer64|integer|auto]\n" +
      "serve: [--artifacts .data\\artifacts.sqlite] [--port 3000] [--max-rows 1000] [--relation-validation warn|error] [--verify-output]\n" +
      "demo: creates a synthetic database and artifacts; refuses to overwrite an existing database");
    return;
  }
  if (positionals.length !== 1 || !["derive", "serve", "demo"].includes(command)) throw new Error("Choose exactly one command: derive, serve, demo");
  const relationValidation = values["relation-validation"] ?? "warn";
  if (command !== "serve" && (values["relation-validation"] !== undefined || values["verify-output"])) throw new Error("Validation options apply only to serve");
  if (relationValidation !== "warn" && relationValidation !== "error") throw new Error("--relation-validation must be warn or error");
  if (!values.database && command !== "demo") throw new Error("--database is required; the source database is always opened read-only");
  const database = resolve(values.database ?? ".data/demo.sqlite");
  const artifacts = resolve(values.artifacts);
  if (command !== "derive" && database.toLowerCase() === artifacts.toLowerCase()) throw new Error("Source database and artifact store must be different files");
  const flags = {
    ...(values["type-encoding"] !== undefined ? { typeEncoding: values["type-encoding"] } : {}),
    ...(values["relation-base"] !== undefined ? { relationBase: values["relation-base"] } : {}),
    ...(values["integer-type"] !== undefined ? { integerType: values["integer-type"] } : {}),
  };
  if (command === "demo" && Object.keys(flags).length) throw new Error("Model generation options apply only to derive and serve");
  const modelOptions = { ...modelSettings(flags), baseUrl: values.base, ...(values.version ? { version: values.version } : {}) };
  if (command === "derive") {
    if (values.out && resolve(values.out).toLowerCase() === database.toLowerCase()) throw new Error("--out cannot overwrite the source database");
    const output = JSON.stringify(createLogicalModels(readSqliteSchema(database), modelOptions).bundle, null, 2) + "\n";
    if (values.out) {
      await mkdir(dirname(resolve(values.out)), { recursive: true });
      await writeFile(values.out, output, { flag: "wx" });
      console.error(`Wrote logical model Bundle to ${resolve(values.out)}`);
    } else process.stdout.write(output);
    return;
  }
  await mkdir(dirname(artifacts), { recursive: true });
  if (command === "demo") {
    if (existsSync(database)) throw new Error(`Demo database already exists: ${database}`);
    if (values.base !== "https://example.org/sql" || values.version) throw new Error("Demo artifacts use the default canonical base and unversioned models");
    await mkdir(dirname(database), { recursive: true });
    await writeFile(database, "", { flag: "wx" });
    const db = new DatabaseSync(database);
    try {
      db.exec(await readFile(new URL("../../examples/clinic.sql", import.meta.url), "utf8"));
    } finally { db.close(); }
    const store = new ArtifactStore(artifacts);
    try {
      const bundle = object(JSON.parse(await readFile(new URL("../../examples/artifacts.json", import.meta.url), "utf8")));
      for (const entry of array(bundle.entry, "entry")) store.put(object(entry).resource);
    } finally { store.close(); }
    console.log(`Created synthetic demo: ${database}\nRun npm start -- --database \"${database}\" --artifacts \"${artifacts}\"`);
    return;
  }
  const port = Number(values.port);
  const maxRows = Number(values["max-rows"]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port must be an integer from 1 to 65535");
  if (!Number.isSafeInteger(maxRows) || maxRows < 1) throw new Error("--max-rows must be a positive safe integer");
  const app = createApp({ database, artifacts, ...modelOptions, maxRows, relationValidation, verifyOutput: !!values["verify-output"] });
  app.server.once("error", (error) => { app.close(); console.error(error); process.exitCode = 1; });
  app.server.listen(port, "127.0.0.1", () => console.log(`Playground: http://127.0.0.1:${port}/playground/\nDocumentation: http://127.0.0.1:${port}/docs/\nSource: ${database} (read-only)`));
  const stop = () => app.server.close(() => app.close());
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
