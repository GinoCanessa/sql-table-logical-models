import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { SqliteSchemaReader } from "../src/schema.js";
import { createLogicalModels, modelSettings, sqliteType } from "../src/models.js";
import { EXT, RELATION, SOF, SOF_RELATION, SQLITE_CONTENT_TYPE, SQL_CONTENT_TYPE_SYSTEM, array, extension, object, sqliteContentTypeExtension } from "../src/fhir.js";
import type { Artifact, FhirObject } from "../src/fhir.js";
import { readRelation } from "../src/relation.js";
import { artifact } from "../src/store.js";
import { fixture } from "./helpers.js";

function elements(model: Artifact) {
  return array(object(model.differential).element, "element").map((e) => object(e));
}

test("SQLite schema preserves key order, true nullability, generated columns and indexes", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`
      CREATE TABLE parent(a TEXT, b INTEGER, PRIMARY KEY(a,b)) WITHOUT ROWID;
      CREATE TABLE ordinary(k TEXT PRIMARY KEY, label TEXT, doubled TEXT GENERATED ALWAYS AS (label || label) STORED);
      CREATE UNIQUE INDEX filtered ON ordinary(lower(label) COLLATE NOCASE DESC) WHERE label IS NOT NULL;
      CREATE UNIQUE INDEX ordered ON ordinary(label, k DESC);
      CREATE UNIQUE INDEX expression_key ON ordinary(length(label));
      CREATE UNIQUE INDEX partial_key ON ordinary(label) WHERE label != '';
      CREATE TABLE child(x TEXT, y INTEGER, FOREIGN KEY(x,y) REFERENCES parent);
      CREATE TABLE row_alias(id INTEGER PRIMARY KEY, anything);
      CREATE TABLE descending(id INTEGER PRIMARY KEY DESC);
      CREATE TABLE strict_key(id TEXT PRIMARY KEY) STRICT;
      CREATE VIEW empty_view AS SELECT label FROM ordinary WHERE 0;
      CREATE TABLE "\u00c4" (upper_key INTEGER PRIMARY KEY);
      CREATE TABLE "\u00e4" (lower_key INTEGER PRIMARY KEY);
      CREATE TABLE unicode_fk (key INTEGER REFERENCES "\u00e4");
    `);
    const schema = new SqliteSchemaReader(db).readSchema();
    const table = (name: string) => schema.relations.find((r) => r.name === name)!;
    assert.equal(table("ordinary").columns[0]!.nullable, true);
    assert.equal(table("parent").columns[0]!.nullable, false);
    assert.equal(table("row_alias").columns[0]!.nullable, false);
    assert.equal(table("descending").columns[0]!.nullable, true);
    assert.equal(table("strict_key").columns[0]!.nullable, false);
    assert.equal(table("ordinary").columns[2]!.generated, "stored");
    assert.deepEqual(table("child").foreignKeys[0]!.targetColumns, ["a", "b"]);
    assert.deepEqual(table("child").foreignKeys[0]!.columns, ["x", "y"]);
    const index = table("ordinary").indexes.find((i) => i.name === "filtered")!;
    assert.equal(index.unique, true);
    assert.equal(index.partial, true);
    assert.equal(index.columns[0]!.name, null);
    assert.equal(index.columns[0]!.descending, true);
    assert.match(index.sql!, /lower\(label\)/);
    assert.equal(table("empty_view").kind, "view");
    assert.equal(table("empty_view").columns[0]!.name, "label");
    assert.equal(table("row_alias").columns[1]!.declaredType, "");
    assert.deepEqual(table("unicode_fk").foreignKeys[0]!.targetColumns, ["lower_key"]);
    const { bindings } = createLogicalModels(schema);
    const model = (name: string) => bindings.find((b) => b.table === name)!.model;
    for (const [name, required] of [["row_alias", true], ["descending", false], ["ordinary", false],
      ["strict_key", true], ["parent", true]] as const) {
      const id = elements(model(name))[1]!;
      assert.equal(id.min, required ? 1 : 0, name);
      assert.equal(id.mustHaveValue, required || undefined, name);
      assert.equal(extension(id, `${EXT}/primary-key-position`)?.valueInteger, 1);
    }
    assert.equal(extension(elements(model("parent"))[2]!, `${EXT}/primary-key-position`)?.valueInteger, 2);
    assert.equal(extension(model("parent"), `${EXT}/sqlite-without-rowid`)?.valueBoolean, true);
    assert.equal(extension(model("strict_key"), `${EXT}/sqlite-strict`)?.valueBoolean, true);
    assert.equal(extension(model("ordinary"), `${EXT}/sqlite-strict`), undefined);
    assert.equal(extension(model("ordinary"), `${EXT}/sqlite-without-rowid`), undefined);
    const extensions = array(model("ordinary").extension, "extension").map((v) => object(v));
    assert.deepEqual(extensions.filter((e) => e.url === `${EXT}/unique-key`).map((e) => e.extension), [
      [{ url: "column", valueString: "label" }, { url: "column", valueString: "k" }],
    ]);
    const indexes = extensions.filter((e) => e.url === `${EXT}/sql-index`).map((e) => JSON.parse(String(e.valueString)) as typeof index);
    assert.deepEqual(indexes.find((i) => i.name === "filtered"), {
      ...index, columns: [{ name: null, descending: true, collation: "NOCASE" }],
      sql: "CREATE UNIQUE INDEX filtered ON ordinary(lower(label) COLLATE NOCASE DESC) WHERE label IS NOT NULL",
    });
    assert.equal(extension(elements(model("ordinary"))[3]!, `${EXT}/generated`)?.valueCode, "stored");
    const fk = extension(model("child"), `${EXT}/foreign-key`)!;
    assert.deepEqual(array(fk.extension, "extension").map((e) => object(e)).filter((e) => e.url === "column").map((e) => e.extension), [
      [{ url: "source", valueString: "x" }, { url: "target", valueString: "a" }],
      [{ url: "source", valueString: "y" }, { url: "target", valueString: "b" }],
    ]);
    assert.deepEqual(elements(model("child"))[2]!.type, [{ code: "integer64" }]);
    for (const name of ["ordinary", "child", "parent"]) assert.equal(elements(model(name))[0]!.constraint, undefined);
  } finally { db.close(); }
});

test("models are deterministic and preserve physical names without invalid FHIR ids or column collisions", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE "a-b" ("a.b" INTEGER, a_b TEXT, "double""quote" BLOB);
      CREATE TABLE a_b (id INTEGER PRIMARY KEY);
      CREATE TABLE child (one INTEGER, two TEXT, FOREIGN KEY(one, two) REFERENCES a_b);
      CREATE VIEW "a view" AS SELECT * FROM a_b;`);
    const schema = new SqliteSchemaReader(db).readSchema();
    const first = createLogicalModels(schema, { version: "1.0" });
    assert.deepEqual(first.bundle, createLogicalModels(schema, { version: "1.0" }).bundle);
    assert.equal(first.resources.length, 5);
    assert.equal(new Set(first.resources.map((r) => r.id)).size, 5);
    for (const model of first.resources) artifact(model);
    const binding = first.bindings.find((b) => b.table === "a-b")!;
    assert.equal(binding.columns.size, 3);
    assert.equal(new Set(binding.columns.keys()).size, 3);
    const elements = array(object(binding.model.differential).element, "element").map((e) => object(e));
    assert.equal(elements.length, 4);
    assert.equal(elements[1]!.max, "1");
    assert.equal(object(array(elements[1]!.type, "type")[0]).code, "integer64");
    assert.equal(binding.model.baseDefinition, `${EXT}/Relation`);
    assert.equal(extension(binding.model, `${EXT}/sql-name`)?.valueString, "a-b");
    assert.equal(extension(elements[1]!, `${EXT}/sql-name`)?.valueString, "a.b");
    assert.equal(extension(elements[2]!, `${EXT}/sql-name`), undefined);
    assert.ok(array(binding.model.extension, "extension").some((e) => object(e).url === `${EXT}/sql-ddl`));
    for (const { model } of first.bindings) {
      assert.deepEqual(extension(model, `${EXT}/sql-content-type`)?.valueCoding, {
        system: "https://sql-on-fhir.org/ig/CodeSystem/SQLContentTypeCodes",
        code: "application/sql;dialect=sqlite",
      });
    }
    assert.equal(extension(first.resources[0]!, `${EXT}/sql-content-type`), undefined);
  } finally { db.close(); }
});

test("column encodings preserve declared types and SQLite nullability", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE visit(cost DECIMAL(10,2), unspecified, id INTEGER PRIMARY KEY)");
    const schema = new SqliteSchemaReader(db).readSchema();
    const mappings = [{ identity: "sql", language: SQLITE_CONTENT_TYPE, map: "DECIMAL(10,2)" }];
    const codedType = [{
      url: `${EXT}/sql-type`, extension: [
        { url: "dialect", valueCoding: { system: SQL_CONTENT_TYPE_SYSTEM, code: SQLITE_CONTENT_TYPE } },
        { url: "type", valueString: "DECIMAL(10,2)" },
      ],
    }];
    for (const encoding of [undefined, "mapping", "extension", "both"] as const) {
      const { model } = createLogicalModels(schema, encoding ? { typeEncoding: encoding, relationBase: "sof" } : {}).bindings[0]!;
      assert.equal(model.baseDefinition, encoding ? SOF_RELATION : RELATION);
      assert.equal(extension(model, `${EXT}/sql-name`), undefined);
      assert.deepEqual(extension(model, `${EXT}/sql-content-type`), sqliteContentTypeExtension());
      const [root, cost, unknown, id] = elements(model);
      assert.deepEqual([root!.min, root!.max, root!.mapping], [0, "*", undefined]);
      for (const leaf of [cost!, unknown!, id!]) {
        assert.equal(leaf.id, leaf.path);
        assert.equal(leaf.max, "1");
        assert.equal(extension(leaf, `${EXT}/sql-type`), undefined);
        assert.equal(extension(leaf, `${EXT}/sqlite-affinity`), undefined);
      }
      assert.deepEqual(cost!.mapping, encoding === "extension" ? undefined : mappings);
      assert.deepEqual(cost!.type, [{ code: "decimal", ...(encoding === "both" || encoding === "extension" ? { extension: codedType } : {}) }]);
      assert.deepEqual([cost!.min, cost!.mustHaveValue], [0, undefined]);
      assert.deepEqual([id!.min, id!.mustHaveValue], [1, true]);
      assert.deepEqual(unknown!.type, [{ code: "string" }]);
      assert.equal(unknown!.mapping, undefined);
      assert.match(String(unknown!.comment), /No declared type/);
      assert.deepEqual(readRelation(model)!.columns[0]!.sqlTypes, [{ dialect: SQLITE_CONTENT_TYPE, declaredType: "DECIMAL(10,2)" }]);
      assert.ok(!JSON.stringify(model).includes("(undeclared)"));
    }
  } finally { db.close(); }
  for (const input of [{ typeEncoding: "legacy" }, { integerType: "smallint" }, { relationBase: "" }]) {
    assert.throws(() => modelSettings(input), /must be one of/);
  }
});

test("length declarations, CHECKs and defaults retain their distinct meanings", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const types = ["CHAR", "VARCHAR", "NCHAR", "NVARCHAR", "CHARACTER", "CHARACTER VARYING", "VARYING CHARACTER"];
    const predicate = `length("CHECK(x)") > 0 AND (label != 'don''t ) CHECK(1)' /* ) */ OR x IS NULL)`;
    const ddl = `CREATE TABLE t(${types.map((type, i) => `s${i} ${type}(${i + 1})`).join(", ")},
      x SMALLINT CHECK(x BETWEEN -2 AND 9), y TINYINT, "CHECK(x)" TEXT, label TEXT DEFAULT 'CHECK(bad)',
      CHECK /* literal ( */ (${predicate}), -- CHECK(phantom)
      CHECK(label IS NOT NULL))`;
    db.exec(ddl);
    const schema = new SqliteSchemaReader(db).readSchema();
    for (const mode of ["auto", "integer", "integer64"] as const) {
      const { model } = createLogicalModels(schema, { integerType: mode }).bindings[0]!;
      assert.equal(extension(model, `${EXT}/sql-ddl`)?.valueString, ddl);
      const [root, ...leaves] = elements(model);
      assert.deepEqual(leaves.slice(0, types.length).map((c) => c.maxLength), types.map((_, i) => i + 1));
      assert.match(String(model.description), /do not enforce declared lengths/i);
      const type = (path: string) => object(array(leaves.find((c) => c.path === path)!.type, "type")[0]).code;
      assert.equal(type("t.x"), mode === "integer64" ? "integer64" : "integer");
      assert.equal(type("t.y"), mode === "integer" ? "integer" : "integer64");
      assert.ok(leaves.every((c) => !Object.keys(c).some((k) => /^(?:minValue|maxValue|defaultValue)/.test(k))));
      assert.equal(extension(leaves.at(-1)!, `${EXT}/sql-default`)?.valueString, "'CHECK(bad)'");
      const constraints = array(root!.constraint, "constraint").map((c) => object(c));
      assert.deepEqual(constraints.map((c) => c.human), ["x BETWEEN -2 AND 9", predicate, "label IS NOT NULL"]);
      assert.deepEqual(constraints.map((c) => extension(c, `${EXT}/sql-expression`)?.valueString), constraints.map((c) => c.human));
      assert.deepEqual(constraints.map((c) => c.expression), [undefined, undefined, "`label`.exists()"]);
    }
  } finally { db.close(); }
});

test("draft Relation read, import and resolution preserve id-less defaults, membership and inert source", (t) => {
  const { catalog } = fixture(t);
  const model: Artifact = {
    resourceType: "StructureDefinition", id: "external", name: "external", url: "https://example.org/external",
    kind: "logical", derivation: "specialization", abstract: false, type: "https://example.org/external",
    baseDefinition: SOF_RELATION, extension: [sqliteContentTypeExtension(), {
      url: `${SOF}/StructureDefinition/relation-source`, valueAttachment: { url: "urn:example:never-fetch", contentType: "text/csv" },
    }], differential: { element: [{ path: "external" }, ...["a", "b"].map((name) => ({
      path: `external.${name}`, type: [{ code: "integer" }], mapping: [{ identity: "sql", map: "INT" }],
      extension: [{ url: `${SOF}/StructureDefinition/primary-key`, valueBoolean: true }],
    }))] },
  };
  const issues: FhirObject[] = [];
  assert.deepEqual(catalog.put(model, issues), model);
  const resolved = catalog.resolve(model.url!, [], issues);
  assert.deepEqual(resolved, model);
  assert.deepEqual(issues.map((i) => i.severity), ["information", "information"]);
  const facts = readRelation(resolved)!.columns;
  assert.deepEqual(facts.map((c) => [c.name, c.primaryKey, c.primaryKeyPosition, c.min, c.max]), [
    ["a", true, undefined, 0, "1"], ["b", true, undefined, 0, "1"],
  ]);
  assert.deepEqual(facts[0]!.sqlTypes, [{ declaredType: "INT", dialect: SQLITE_CONTENT_TYPE }]);
});

test("type hints retain SQLite affinity precedence and flag untyped columns", () => {
  assert.deepEqual(sqliteType("FLOATING POINT"), { affinity: "INTEGER", fhir: "integer64" });
  assert.deepEqual(sqliteType("VARCHAR(100)"), { affinity: "TEXT", fhir: "string" });
  assert.deepEqual(sqliteType("BOOLEAN"), { affinity: "NUMERIC", fhir: "boolean" });
  assert.equal(sqliteType("DATETIME").fhir, "dateTime");
  assert.equal(sqliteType("BLOB").fhir, "base64Binary");
  assert.ok(sqliteType("").warning);
});
