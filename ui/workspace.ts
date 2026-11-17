import type { Artifact, FhirObject, Json } from "../src/fhir.js";

export interface Dependency {
  label: string;
  resource: string;
}

export interface OperationForm {
  operation: "sql-run" | "sql-export";
  subject: FhirObject;
  format: string;
  limit: number;
  header: boolean;
  parameters: FhirObject;
  context: Json[];
  exportName: string;
  trackingId: string;
}

export function parseObject(source: string, label: string): FhirObject {
  const parsed: unknown = parseJson(source, label);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${label} must be a JSON object`);
  return parsed as FhirObject;
}

export function parseArray(source: string, label: string): Json[] {
  const parsed: unknown = parseJson(source, label);
  if (!Array.isArray(parsed)) throw new Error(`${label} must be a JSON array`);
  return parsed as Json[];
}

function parseJson(source: string, label: string): unknown {
  try { return JSON.parse(source) as unknown; }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} contains invalid JSON: ${error.message}`);
    throw error;
  }
}

export function dependencyLabel(name: string, existing: Dependency[]): string {
  const cleaned = name.replace(/[^A-Za-z0-9_]/g, "_") || "relation";
  const base = /^[A-Za-z_]/.test(cleaned) ? cleaned : `_${cleaned}`;
  let label = base;
  for (let i = 2; existing.some((d) => d.label.toLowerCase() === label.toLowerCase()); i++) label = `${base}_${i}`;
  return label;
}

export function canonical(resource: { url?: string; version?: string }): string {
  if (!resource.url) throw new Error("This artifact has no canonical URL");
  return `${resource.url}${resource.version ? `|${resource.version}` : ""}`;
}

export function subjectPart(kind: string, value: string | Artifact | FhirObject): FhirObject {
  if (kind === "reference") return { name: "subjectReference", valueReference: { reference: String(value) } };
  if (kind === "canonical") return { name: "subjectCanonical", valueCanonical: String(value) };
  return { name: "subjectResource", resource: value as FhirObject };
}

export function buildOperation(form: OperationForm): FhirObject {
  if (form.parameters.resourceType !== "Parameters" ||
    (form.parameters.parameter !== undefined && !Array.isArray(form.parameters.parameter))) throw new Error("Input values must be a FHIR Parameters resource");
  const inputs: FhirObject[] = [form.subject];
  if (Array.isArray(form.parameters.parameter) && form.parameters.parameter.length) inputs.push({ name: "parameters", resource: form.parameters });
  const common: FhirObject[] = [
    { name: "_format", valueCode: form.format }, { name: "header", valueBoolean: form.header },
    ...form.context.map((resource) => ({ name: "context", resource })),
  ];
  if (form.operation === "sql-run") {
    if (!Number.isSafeInteger(form.limit) || form.limit < 0) throw new Error("Row limit must be a non-negative integer");
    return { resourceType: "Parameters", parameter: [...inputs, ...common, { name: "_limit", valueInteger: form.limit }] };
  }
  const output: FhirObject[] = [
    { name: "subject", part: [{ name: "name", valueString: form.exportName }, ...inputs] }, ...common,
  ];
  if (form.trackingId) output.push({ name: "clientTrackingId", valueString: form.trackingId });
  return { resourceType: "Parameters", parameter: output };
}
