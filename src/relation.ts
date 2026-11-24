import { EXT, RELATION, SOF, SOF_RELATION, SQL_CONTENT_TYPE_EXTENSION, SQL_CONTENT_TYPE_SYSTEM, array, extension, object, text } from "./fhir.js";
import type { Artifact, FhirObject } from "./fhir.js";

export type TypeEncoding = "mapping" | "extension" | "both";
export interface ColumnFacts {
  name: string;
  physicalName: string;
  primitive?: string;
  sqlTypes: { declaredType: string; dialect?: string }[];
  min: number;
  max: string;
  mustHaveValue: boolean;
  warning?: string;
  maxLength?: number;
  primaryKey: boolean;
  primaryKeyPosition?: number;
}

export function columnElement(root: string, column: ColumnFacts, encoding: TypeEncoding, extensions: FhirObject[]): FhirObject {
  const path = `${root}.${column.name}`;
  const type = { code: column.primitive };
  const sqlTypes = column.sqlTypes;
  if (column.physicalName !== column.name) extensions.push({ url: `${EXT}/sql-name`, valueString: column.physicalName });
  if (column.primaryKeyPosition) extensions.push({ url: `${EXT}/primary-key-position`, valueInteger: column.primaryKeyPosition });
  return {
    id: path, path, short: column.physicalName, min: column.min, max: column.max,
    ...(column.mustHaveValue ? { mustHaveValue: true } : {}),
    ...(column.maxLength !== undefined ? { maxLength: column.maxLength } : {}),
    ...(column.warning ? { comment: column.warning } : {}),
    ...(extensions.length ? { extension: extensions } : {}),
    type: [{ ...type, ...(encoding !== "mapping" && sqlTypes.length ? {
      extension: sqlTypes.map(({ declaredType, dialect }) => ({
        url: `${EXT}/sql-type`, extension: [
          { url: "dialect", valueCoding: { system: SQL_CONTENT_TYPE_SYSTEM, code: dialect } },
          { url: "type", valueString: declaredType },
        ],
      })),
    } : {}) }],
    ...(encoding !== "extension" && sqlTypes.length ? {
      mapping: sqlTypes.map(({ declaredType, dialect }) => ({ identity: "sql", language: dialect, map: declaredType })),
    } : {}),
  };
}

function draftExtension(value: FhirObject, name: string) {
  return extension(value, `${EXT}/${name}`) ?? extension(value, `${SOF}/StructureDefinition/${name}`);
}

/** Interpret a direct Relation without normalizing or dereferencing the stored resource. */
export function readRelation(model: Artifact): { columns: ColumnFacts[]; issues: FhirObject[] } | undefined {
  if (model.resourceType !== "StructureDefinition" || (model.baseDefinition !== RELATION && model.baseDefinition !== SOF_RELATION)) return undefined;
  const issues: FhirObject[] = [];
  if (draftExtension(model, "relation-source")) issues.push({
    severity: "information", code: "informational", diagnostics: "relation-source retained; no data is fetched or bound.",
    expression: ["StructureDefinition.extension"],
  });
  const dialectCoding = extension(model, SQL_CONTENT_TYPE_EXTENSION)?.valueCoding;
  const dialect = dialectCoding && object(dialectCoding).code;
  const differential = model.differential === undefined ? {} : object(model.differential);
  const elements = array(differential.element, "differential.element").map((e) => object(e));
  const columns = elements.slice(1).map((element): ColumnFacts => {
    const path = text(element.path, "column.path");
    const name = path.slice(path.lastIndexOf(".") + 1);
    const physical = extension(element, `${EXT}/sql-name`)?.valueString;
    const typeEntry = array(element.type, "column.type")[0];
    const type = typeEntry === undefined ? {} : object(typeEntry);
    const sqlTypes: ColumnFacts["sqlTypes"] = [];
    const add = (declared: unknown, language: unknown) => {
      if (typeof declared !== "string" || !declared || sqlTypes.some((s) => s.declaredType === declared && s.dialect === language)) return;
      sqlTypes.push({ declaredType: declared, ...(typeof language === "string" ? { dialect: language } : {}) });
    };
    for (const m of array(element.mapping, "column.mapping").map((v) => object(v))) {
      if (m.identity === "sql") add(m.map, m.language ?? dialect);
    }
    for (const e of array(type.extension, "type.extension").map((v) => object(v))) {
      if (e.url !== `${EXT}/sql-type`) continue;
      const coding = extension(e, "dialect")?.valueCoding;
      add(extension(e, "type")?.valueString, coding && object(coding).code);
    }
    const position = extension(element, `${EXT}/primary-key-position`)?.valueInteger;
    return {
      name, physicalName: typeof physical === "string" ? physical : name,
      ...(typeof type.code === "string" ? { primitive: type.code } : {}), sqlTypes,
      min: typeof element.min === "number" ? element.min : 0, max: typeof element.max === "string" ? element.max : "1",
      mustHaveValue: element.mustHaveValue === true,
      ...(typeof element.comment === "string" ? { warning: element.comment } : {}),
      ...(typeof element.maxLength === "number" ? { maxLength: element.maxLength } : {}),
      primaryKey: typeof position === "number" || draftExtension(element, "primary-key")?.valueBoolean === true,
      ...(typeof position === "number" ? { primaryKeyPosition: position } : {}),
    };
  });
  return { columns, issues };
}
