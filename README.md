# SQL table logical models

An experimental TypeScript implementation for describing SQL database tables and views as FHIR logical models, starting with SQLite. Includes a local SQL-on-FHIR-style server and an interactive playground for composing and evaluating queries.

**External SQL relations are a proposal, not part of SQL on FHIR 3.0.0.** This project is an exploration, not a complete FHIR server or a claim of specification conformance. See [the external relations discussion](https://github.com/HL7/sql-on-fhir/issues/426).

## What it does

- Derives logical-model `StructureDefinition` resources from SQLite schema metadata, retaining column types, nullability, keys, indexes and physical names.
- Stores and manages Libraries, ViewDefinitions and imported logical models in a separate SQLite artifact store.
- Evaluates parameterized SQLQuery/SQLView Libraries, canonical dependencies, joins and a limited subset of ViewDefinition projections.
- Exposes `$sql-run` and asynchronous `$sql-export`, with JSON, NDJSON and CSV output.
- Provides a browser playground to inspect tables and artifacts, write SQL, generate/save/download Libraries and invoke FHIR operations.

Generating a Library from SQL does not create a physical database view or automatically translate rows into clinical FHIR resources.

Generated SQL uses `application/sql;dialect=sqlite`. Libraries and concrete logical models also carry a local `sql-content-type` extension with a Coding from `https://sql-on-fhir.org/ig/CodeSystem/SQLContentTypeCodes`; see the [HTML documentation](docs/index.html#composition) for its wire format and legacy compatibility.

## Quick start

Requires **Node.js 24.10 or later** and npm. SQLite and HTTP use built-in Node modules; there are no runtime npm dependencies. Commands below use PowerShell.

```powershell
git clone https://github.com/GinoCanessa/sql-table-logical-models.git
Set-Location sql-table-logical-models
npm ci
npm run demo
npm start -- --database .\.data\demo.sqlite
```

The demo creates a synthetic clinic database and sample query artifacts. It refuses to overwrite an existing demo database.

Open the [playground](http://127.0.0.1:3000/playground/) or the [HTML documentation](http://127.0.0.1:3000/docs/). The server binds to loopback; use `--port` to choose another port (`0` selects an available port and prints its URL). Restart the server after code, configuration or source-schema changes.

Try a saved demo query:

```powershell
curl.exe 'http://127.0.0.1:3000/$sql-run?subjectReference=Library/patient-visits&_format=json'
```

The server root and `/metadata` return a CapabilityStatement, not the playground.

## Use your own SQLite database

Replace `.\temp\source.sqlite` with an existing SQLite database. Keep the same canonical base when deriving models and starting the server.

```powershell
npm run derive -- --database .\temp\source.sqlite `
  --base https://example.org/my-database `
  --out .\.data\models.json

npm start -- --database .\temp\source.sqlite `
  --base https://example.org/my-database `
  --artifacts .\.data\source-artifacts.sqlite
```

Derivation reads schema metadata, not records, and writes a FHIR Bundle containing the generated logical models. `--out` refuses to overwrite an existing file.

**`--artifacts` must point to a separate SQLite database, not the generated JSON Bundle.** The server creates the artifact store if needed and derives logical models directly from the source database at startup. Use a separate artifact store for each source database; no Bundle import is needed to browse generated models.

The source database and generated models are read-only. Saved Libraries and ViewDefinitions live in the writable artifact store. Playground SQL and form inputs are not automatically retained across browser reloads; save or download artifacts to keep them.

## Model and output migration

`derive` and `serve` accept the same model-generation options. Use the same settings for both (`typeEncoding`, `relationBase`, `integerType` in the TypeScript API).

| Option | Default | Alternatives |
| --- | --- | --- |
| `--type-encoding` | `mapping`: exact declared type in a dialect-qualified `sql` mapping | `extension`: complex `sql-type` on the primitive type entry; `both`: both new forms |
| `--relation-base` | `local`: bundled experimental Relation | `sof`: draft SQL-on-FHIR Relation canonical |
| `--integer-type` | `integer64`: signed 64-bit | `integer`: operator assertion of signed 32-bit values; `auto`: narrow only with a recognized range CHECK, never from a width name |

Migrate readers away from the old column-level `sql-type.valueString`, `sqlite-affinity` and root table-name mapping. See the [before/after `visit.cost` encodings](docs/index.html#type-encodings). `readRelation()` reads either base without rewriting the artifact. Draft column IDs are optional, omitted column cardinalities mean `0..1`, and a boolean primary key records membership, not order. An uploaded `relation-source` is retained but never opened or bound.

**JSON/NDJSON change:** Run and export now write every modeled `integer64` as a decimal string, including `"1"`. Modeled `integer` and `decimal` are numbers; `40` remains a number for an integral cost. SQL NULL remains `null`. An untyped expression still uses its SQLite storage value, not a guessed type. CSV retains its raw fields, optional headers, quoting and CRLF. The completed export manifest distinguishes its top-level polling `location` from each file's `output.location`.

## Describe before running

```powershell
curl.exe -H 'Content-Type: application/fhir+json' --data-binary '@examples/describe.json' 'http://127.0.0.1:3000/$sql-describe'
curl.exe 'http://127.0.0.1:3000/$sql-describe?subjectReference=ViewDefinition/patient-projection&_format=sql'
curl.exe 'http://127.0.0.1:3000/$feature-query?param=operation-profile@Library/patient-visits'
curl.exe -H 'Content-Type: application/fhir+json' --data-binary '@examples/feature-query.json' 'http://127.0.0.1:3000/$feature-query'
```

Describe prepares the same read-only statement as run without binding values or reading a row. Use the ordered model (default), SQLite DDL for **your destination**, or `_format=operation` for the system `$sql-run` profile. Playground **Describe result** and **Operation profile** inspect a saved subject or unsaved workspace with its context; neither runs nor saves it.

Direct ViewDefinition projections retain source nullability; `collection: true` wraps each non-NULL scalar in a singleton JSON array. Library outputs default to nullable even for a NOT NULL source: joins can introduce NULL. Declare `Library.parameter` entries with `use: "out"` by output alias to assert a primitive, cardinality and documentation. An unresolved expression remains in column order with a comment and **no type**. It supports structural checks, not a fully typed contract. Modeled booleans are JSON `true`/`false`, BLOBs base64; CSV uses SQLite cells (`1`/`0`, NULL as an empty field).

Discovery reports current saved-subject contracts; POST supports canonical `url|version` scopes. Read the returned `StructureDefinition/{id}` or `OperationDefinition/{id}` on the **serving FHIR base**, not the example canonical host, or search there by `?url=`. A change to the effective graph changes the identity. An inline profile contains its model rather than promising a later read. Every completed new export includes an immutable `output.model` canonical per named file, retained with the job even if the subject changes. Older jobs have no inferred model. `Required-Features: param=integer64-json(string)` gates run, describe and export; unmet requirements return 501 before operation work.

After the warning-default transition, `serve --relation-validation error` is the default. Invalid Relation writes and resolution return a path-addressed 422 OperationOutcome; an invalid update does not replace the saved model. Use explicit `warn` for legacy imports, not to bypass configuration checks. Ignored tooling fields warn; `Prefer: return=OperationOutcome` requests write diagnostics. Neither mode creates a physical binding. `serve --verify-output` additionally checks each run and exported file against its evaluation's model; incompatible rows fail, SQLite length overruns warn (`X-Relation-Issue-Count` on successful output). It is off by default.

## Operator-owned configuration

For the synthetic clinic, use the same **local** annotations file for derive and serve. Only serve takes a relations file:

```powershell
npm run derive -- --database .\.data\demo.sqlite --annotations .\examples\annotations.json --out .\.data\annotated.json
npm start -- --database .\.data\demo.sqlite --annotations .\examples\annotations.json --relations .\examples\relations.json
```

[annotations.json](examples/annotations.json) adds a label, definition, semantic code, NULL explanation, example and example-strength ValueSet to `visit.note`. Its type stays `string` / `TEXT`, `0..1`. Inspect **Tables and views → visit → View logical model**. Select a generated model by its exact URL or physical `sql-name` extension; if both are present they must identify the same table. Match root/column paths exactly. The merge retains schema facts, warnings and SQLite caveats. Unknown paths, conflicting facts, invalid bindings and weakened strengths reject the configuration before output or serving, even in `warn` mode. Use only `example`, `preferred` or `extensible` for new bindings: the runner has no evidence the database enforces membership in an external ValueSet. No terminology lookup occurs.

[relations.json](examples/relations.json) maps `https://example.org/clinic/StructureDefinition/person|1` to the local `patient` table. No file path, attachment or SQL expression is a table selector. An entry can precede its model; existing artifacts are checked at startup, later writes and context replacements before use. Every scalar leaf must match one distinct declared physical column (SQLite identifier comparison), primitive and integer-width policy. SQLite type annotations, when supplied, must agree with declared storage including type parameters; familiar synonyms such as `INT`/`INTEGER` are accepted. The checked subset can omit physical columns. Uploading the same model without the operator mapping, or another version, does not bind it. In the API, pass decoded `annotations` to `createLogicalModels` / `createApp`, and decoded `relations` to `createApp` only.

### Curated clinic model

```json
{
  "resourceType": "StructureDefinition",
  "id": "clinic-person",
  "url": "https://example.org/clinic/StructureDefinition/person",
  "version": "1",
  "name": "ClinicPerson",
  "status": "draft",
  "kind": "logical",
  "abstract": false,
  "type": "https://example.org/clinic/StructureDefinition/person",
  "baseDefinition": "http://hl7.org/fhir/uv/sql-on-fhir/StructureDefinition/Relation",
  "derivation": "specialization",
  "differential": { "element": [
    { "path": "ClinicPerson", "min": 0, "max": "*" },
    { "path": "ClinicPerson.person_id", "min": 1, "mustHaveValue": true,
      "type": [{ "code": "integer64" }],
      "extension": [{ "url": "https://example.org/sql-table-logical-models/StructureDefinition/sql-name", "valueString": "id" }] },
    { "path": "ClinicPerson.display", "min": 1, "mustHaveValue": true,
      "type": [{ "code": "string" }],
      "extension": [{ "url": "https://example.org/sql-table-logical-models/StructureDefinition/sql-name", "valueString": "name" }] }
  ] }
}
```

PUT this JSON to the listener's `/StructureDefinition/clinic-person`. In the playground SQL workspace add **ClinicPerson** as a dependency, label it `people`, and run `SELECT * FROM people ORDER BY person_id`. The first row is `{"person_id":"1","display":"Example One"}`; the dependency does not expose `patient.active`. A flat ViewDefinition can instead use `resource: "ClinicPerson"`, the ordinary `source.valueCanonical` extension pinned to the same `url|1`, and `select.column` paths `person_id` and `display`. No DDL runs on the source, and dependency subsets are not access control for arbitrary SQL.

To provision a client destination, save and version the Library, POST its `subjectCanonical` to `$sql-describe`, and request `_format=sql` separately. Execute the DDL **only in your own destination**. Query `result-model` via AFF with the same pinned context; retrieve that canonical on the listener and compare run rows and downloaded export rows to its ordered columns. Retain the manifest's `output.model` for later reads: a changed Library gets a new describe identity, not new bytes under the old job. Send `Required-Features: param=integer64-json(number)` to see a 501 instead of starting an incompatible export.

## Development

```powershell
npm run typecheck
npm test
npm run build
node .\dist\src\cli.js --help
```

The npm `start`, `derive`, `demo` and `test` scripts build TypeScript before running. The reusable API is exported through `dist\src\index.js` after a build.

`QueryEngine.run()` and `runBatch()` retain the `{columns, rows}` result shape. `runPreparedBatch()` exposes ordered statement descriptors and raw SQLite rows to formatters; unlike JSON results, these can contain `bigint` values.

| Directory | Contents |
| --- | --- |
| `src` | Schema discovery, logical models, artifact storage, execution, server and CLI |
| `ui` | Interactive playground |
| `docs` | HTML documentation, design decisions, API reference and limitations |
| `examples` | Synthetic SQLite schema, artifacts and operation requests |
| `test` | Schema, execution, HTTP and playground integration tests |

`temp`, `.data`, `node_modules` and `dist` are gitignored. Keep private databases, generated schemas and query outputs out of version control.

## Scope and limitations

This is a **trusted local development tool**, with no authentication. SQL can read any source table. Execution is synchronous and buffered: row ceilings do not impose execution-time or memory limits. Do not expose the server to untrusted users.

SQLite type mappings are schema-derived hints, not full row validation. Numeric JSON output fails rather than silently rounding an incompatible value. SQLite does not enforce declared character lengths. ViewDefinition support is limited; arbitrary FHIRPath, terminology, patient/group filtering and Parquet output are not implemented.

See the [HTML documentation source](docs/index.html), or serve it at `/docs/`, for modeling choices, supported operations and their restrictions.

## License

[MIT](LICENSE). Copyright (c) 2026 Gino Canessa.
