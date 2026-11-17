import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { SqliteSchemaReader } from "../src/schema.js";
import { createLogicalModels, sqliteType } from "../src/models.js";
import { EXT, array, extension, object } from "../src/fhir.js";
import { artifact } from "../src/store.js";

test("SQLite schema preserves key order, true nullability, generated columns and indexes", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`
      CREATE TABLE parent(a TEXT, b INTEGER, PRIMARY KEY(a,b)) WITHOUT ROWID;
      CREATE TABLE ordinary(k TEXT PRIMARY KEY, label TEXT, doubled TEXT GENERATED ALWAYS AS (label || label) STORED);
      CREATE UNIQUE INDEX filtered ON ordinary(lower(label) DESC) WHERE label IS NOT NULL;
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

test("type hints retain SQLite affinity precedence and flag untyped columns", () => {
  assert.deepEqual(sqliteType("FLOATING POINT"), { affinity: "INTEGER", fhir: "integer64" });
  assert.deepEqual(sqliteType("VARCHAR(100)"), { affinity: "TEXT", fhir: "string" });
  assert.deepEqual(sqliteType("BOOLEAN"), { affinity: "NUMERIC", fhir: "boolean" });
  assert.equal(sqliteType("DATETIME").fhir, "dateTime");
  assert.equal(sqliteType("BLOB").fhir, "base64Binary");
  assert.ok(sqliteType("").warning);
});
