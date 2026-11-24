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

Open the [playground](http://127.0.0.1:3000/playground/) or the [HTML documentation](http://127.0.0.1:3000/docs/). The server binds to loopback; use `--port` to choose another port. Restart the server after code or source-schema changes.

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

`derive` and `serve` accept the same options. Use the same settings for both (`typeEncoding`, `relationBase`, `integerType` in the TypeScript API).

| Option | Default | Alternatives |
| --- | --- | --- |
| `--type-encoding` | `mapping`: exact declared type in a dialect-qualified `sql` mapping | `extension`: complex `sql-type` on the primitive type entry; `both`: both new forms |
| `--relation-base` | `local`: bundled experimental Relation | `sof`: draft SQL-on-FHIR Relation canonical |
| `--integer-type` | `integer64`: signed 64-bit | `integer`: operator assertion of signed 32-bit values; `auto`: narrow only with a recognized range CHECK, never from a width name |

Migrate readers away from the old column-level `sql-type.valueString`, `sqlite-affinity` and root table-name mapping. See the [before/after `visit.cost` encodings](docs/index.html#type-encodings). `readRelation()` reads either base without rewriting the artifact. Draft column IDs are optional, omitted column cardinalities mean `0..1`, and a boolean primary key records membership, not order. An uploaded `relation-source` is retained but never opened or bound.

**JSON/NDJSON change:** Run and export now write every modeled `integer64` as a decimal string, including `"1"`. Modeled `integer` and `decimal` are numbers; `40` remains a number for an integral cost. SQL NULL remains `null`. An untyped expression still uses its SQLite storage value, not a guessed type. CSV retains its raw fields, optional headers, quoting and CRLF. The completed export manifest distinguishes its top-level polling `location` from each file's `output.location`.

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
