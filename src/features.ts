import { EXP, OperationError, SQLITE_CONTENT_TYPE, array, fail, object, text } from "./fhir.js";
import type { Artifact, FhirObject, Json } from "./fhir.js";
import type { QueryEngine } from "./engine.js";
import { checkNames, named, valueOf } from "./operations.js";
import { parameters } from "./store.js";

export const AFF = "http://hl7.org/fhir/uv/application-feature";
const namespace = `${EXP}/FeatureDefinition/`;
const definitions = [
  ["operation-profile", "canonical", "subject", "Retrievable system sql-run profile for the subject."],
  ["result-model", "canonical", "subject", "Retrievable result Relation for the subject."],
  ["binary-content-model", "boolean", "operation", "The Binary return identifies its content model."],
  ["output-format", "code", "operation", "A supported flat row format; values repeat."],
  ["sql-dialect", "code", "server", "The SQL dialect supported by the runner."],
  ["integer64-json", "code", "server", "JSON representation of modeled integer64 values."],
  ["describe", "boolean", "server", "Metadata-only sql-describe is supported."],
] as const;
export const featureDefinitions: Artifact[] = definitions.map(([id, valueType, scope, description]) => ({
  resourceType: `${AFF}/StructureDefinition/FeatureDefinition`, id, url: namespace + id,
  name: id.split("-").map((s) => s[0]!.toUpperCase() + s.slice(1)).join(""), status: "draft", experimental: true,
  valueType, description, contextExpressionLanguage: "text/url",
  context: [`http://hl7.org/fhir/StructureDefinition/CapabilityStatement#CapabilityStatement.rest${
    scope === "subject" ? ".resource.operation" : scope === "operation" ? ".operation" : ""}`],
  contextDefinition: scope === "subject" ? "A local Library/id or ViewDefinition/id; a canonical (including url|version) requires POST." :
    scope === "operation" ? "A system operation code, without the dollar sign." : "Server-wide; omit context.",
}));
export const featureSupport = { url: `${AFF}/StructureDefinition/feature`, extension: [
  { url: "definition", valueCanonical: `${AFF}/FeatureDefinition/FeatureSupport` }, { url: "value", valueCode: "1.0.0" },
] };

interface Query { definition: string; context?: string; value?: FhirObject }
const field = (definition: Artifact) => definition.valueType === "canonical" ? "valueCanonical" :
  definition.valueType === "boolean" ? "valueBoolean" : "valueCode";

function parseGet(query: URLSearchParams): Query[] {
  return [...query].map(([key, expression]) => {
    const m = /^([a-z][a-z0-9-]*)(?:@([A-Za-z0-9.-]+(?:\/[A-Za-z0-9.-]+)?))?(?:\(([^()]*)\))?$/.exec(expression);
    if (key !== "param" || !m) fail(400, "invalid", "Use param=feature@literal-reference(value); canonical scopes require POST");
    const def = featureDefinitions.find((d) => d.id === m[1]);
    const valueField = def ? field(def) : "valueString";
    const raw = m[3];
    if (raw !== undefined && valueField === "valueBoolean" && !["true", "false"].includes(raw)) fail(400, "invalid", "Expected boolean feature value");
    return { definition: namespace + m[1], ...(m[2] ? { context: m[2] } : {}),
      ...(raw !== undefined ? { value: { name: "value", [valueField]: valueField === "valueBoolean" ? raw === "true" : raw } } : {}) };
  });
}
function parsePost(input: unknown): Query[] {
  const parts = parameters(input);
  checkNames(parts, ["feature"], ["feature"]);
  return parts.map((p) => {
    const entries = array(valueOf(p, "part"), "feature.part").map((v) => object(v));
    checkNames(entries, ["definition", "context", "value"]);
    const def = named(entries, "definition") ?? fail(400, "required", "feature.definition required");
    const context = named(entries, "context"), value = named(entries, "value");
    return { definition: text(valueOf(def, "valueCanonical"), "definition"),
      ...(context ? { context: text(valueOf(context, "valueString"), "context") } : {}), ...(value ? { value } : {}) };
  });
}
function evaluate(engine: QueryEngine, query: Query) {
  const { definition, context, value } = query;
  const def = featureDefinitions.find((d) => d.url === definition);
  let values: Json[] = [];
  if (def) switch (def.id) {
    case "operation-profile": case "result-model":
      if (context) {
        try {
          const subject = /^(Library|ViewDefinition)\//.test(context) ? engine.catalog.get(context) : engine.catalog.resolve(context);
          const contract = engine.describe(subject);
          values = [def.id === "result-model" ? contract.model.url! : contract.profileUrl];
        } catch (error) { if (!(error instanceof OperationError)) throw error; }
      } break;
    case "output-format": if (context === "sql-run" || context === "sql-export") values = ["json", "ndjson", "csv"]; break;
    case "binary-content-model": if (context === "sql-run") values = [true]; break;
    case "integer64-json": if (!context) values = ["string"]; break;
    case "describe": if (!context) values = [true]; break;
    case "sql-dialect": if (!context) values = [SQLITE_CONTENT_TYPE]; break;
  }
  const key = def ? field(def) : "valueString";
  const answer = !!def && (value ? Object.keys(value).length === 2 && values.some((v) => v === value[key]) : values.length > 0);
  const part: FhirObject[] = [{ name: "definition", valueCanonical: definition }, ...(context ? [{ name: "context", valueString: context }] : []),
    ...(value ? [value, { name: "answer", valueBoolean: answer }] : values.map((v) => ({ name: "value", [key]: v }))),
    { name: "processing-status", valueCode: def ? "all-ok" : "feature" }];
  return { answer, feature: { name: "feature", part } };
}
export function featureQuery(engine: QueryEngine, input: unknown): FhirObject {
  const queries = input instanceof URLSearchParams ? parseGet(input) : parsePost(input);
  if (!queries.length) fail(400, "required", "At least one feature is required");
  return { resourceType: "Parameters", meta: { profile: [`${AFF}/StructureDefinition/FeatureQueryOutputParameters`] },
    parameter: queries.map((q) => evaluate(engine, q).feature) };
}
export function requireFeatures(engine: QueryEngine, header: string) {
  const queries = parseGet(new URLSearchParams(header.replace(/,\s*param=/g, "&param=")));
  if (!queries.length || !queries.every((q) => evaluate(engine, q).answer)) fail(501, "not-supported", "Required feature not satisfied");
}
