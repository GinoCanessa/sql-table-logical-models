import { DatabaseSync } from "node:sqlite";

export interface SqlColumn {
  name: string;
  declaredType: string;
  nullable: boolean;
  primaryKeyPosition: number;
  defaultSql: string | null;
  generated: "virtual" | "stored" | null;
}

export interface SqlForeignKey {
  id: number;
  columns: string[];
  targetTable: string;
  targetColumns: (string | null)[];
  onUpdate: string;
  onDelete: string;
  match: string;
}

export interface SqlIndex {
  name: string;
  unique: boolean;
  origin: string;
  partial: boolean;
  sql: string | null;
  columns: { name: string | null; descending: boolean; collation: string }[];
}

export interface SqlRelation {
  name: string;
  kind: "table" | "view";
  ddl: string;
  strict: boolean;
  withoutRowid: boolean;
  columns: SqlColumn[];
  foreignKeys: SqlForeignKey[];
  indexes: SqlIndex[];
}

export interface SqlSchema {
  dialect: "sqlite";
  relations: SqlRelation[];
}

export interface SchemaReader {
  readSchema(): SqlSchema | Promise<SqlSchema>;
}

export function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

export function sqliteNameKey(name: string): string {
  return name.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

export class SqliteSchemaReader implements SchemaReader {
  constructor(private readonly db: DatabaseSync) {}

  readSchema(): SqlSchema {
    const tables = this.db.prepare(
      `SELECT s.name, s.type, s.sql, p.wr, p.strict
       FROM sqlite_schema s JOIN pragma_table_list p ON p.name = s.name AND p.schema = 'main'
       WHERE s.type IN ('table', 'view') AND s.name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
         AND p.type != 'shadow' ORDER BY s.name COLLATE BINARY`,
    ).all();
    const relations: SqlRelation[] = tables.map((table) => {
      const name = String(table.name);
      const columns = this.db.prepare("SELECT * FROM pragma_table_xinfo(?) ORDER BY cid").all(name);
      const indexes: SqlIndex[] = this.db.prepare("SELECT * FROM pragma_index_list(?) ORDER BY seq").all(name).map((index) => ({
        name: String(index.name),
        unique: index.unique === 1,
        origin: String(index.origin),
        partial: index.partial === 1,
        sql: (this.db.prepare("SELECT sql FROM sqlite_schema WHERE name = ?").get(String(index.name))?.sql as string | null) ?? null,
        columns: this.db.prepare("SELECT * FROM pragma_index_xinfo(?) WHERE key = 1 ORDER BY seqno").all(String(index.name)).map((c) => ({
          name: c.name === null ? null : String(c.name),
          descending: c.desc === 1,
          collation: String(c.coll),
        })),
      }));
      const primary = columns.filter((c) => Number(c.pk) > 0);
      // An INTEGER PRIMARY KEY with a PK index (notably inline DESC) is not a rowid alias.
      const rowidAlias = table.wr === 0 && primary.length === 1 &&
        String(primary[0]?.type).toUpperCase() === "INTEGER" && !indexes.some((i) => i.origin === "pk");
      const foreignKeys = new Map<number, SqlForeignKey>();
      for (const fk of this.db.prepare("SELECT * FROM pragma_foreign_key_list(?) ORDER BY id, seq").all(name)) {
        const id = Number(fk.id);
        let key = foreignKeys.get(id);
        if (!key) {
          key = {
            id, columns: [], targetTable: String(fk.table), targetColumns: [],
            onUpdate: String(fk.on_update), onDelete: String(fk.on_delete), match: String(fk.match),
          };
          foreignKeys.set(id, key);
        }
        key.columns.push(String(fk.from));
        key.targetColumns.push(fk.to === null ? null : String(fk.to));
      }
      return {
        name, kind: table.type === "view" ? "view" : "table",
        ddl: String(table.sql ?? ""), strict: table.strict === 1, withoutRowid: table.wr === 1,
        columns: columns.filter((c) => c.hidden !== 1).map((c) => ({
          name: String(c.name),
          declaredType: String(c.type ?? ""),
          nullable: !(c.notnull === 1 || (Number(c.pk) > 0 && (rowidAlias || table.wr === 1 || table.strict === 1))),
          primaryKeyPosition: Number(c.pk),
          defaultSql: c.dflt_value === null ? null : String(c.dflt_value),
          generated: c.hidden === 2 ? "virtual" : c.hidden === 3 ? "stored" : null,
        })),
        foreignKeys: [...foreignKeys.values()], indexes,
      };
    });
    for (const relation of relations) {
      for (const key of relation.foreignKeys) {
        const target = relations.find((r) => sqliteNameKey(r.name) === sqliteNameKey(key.targetTable));
        const pk = target?.columns.filter((c) => c.primaryKeyPosition > 0).sort((a, b) => a.primaryKeyPosition - b.primaryKeyPosition);
        key.targetColumns = key.targetColumns.map((c, i) => c ?? pk?.[i]?.name ?? null);
      }
    }
    return { dialect: "sqlite", relations };
  }
}

export function readSqliteSchema(path: string): SqlSchema {
  const db = new DatabaseSync(path, { readOnly: true, allowExtension: false });
  try {
    return new SqliteSchemaReader(db).readSchema();
  } finally {
    db.close();
  }
}
