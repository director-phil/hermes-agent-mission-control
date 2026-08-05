import type { OperationValidationIssue } from "./index";

const MAX_SCHEMA_ERRORS = 16;

type JsonSchema = {
  oneOf?: JsonSchema[];
  type?: string;
  const?: unknown;
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  pattern?: string;
  format?: string;
};

type SchemaValidationResult = { ok: true } | { ok: false; errors: OperationValidationIssue[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function add(errors: OperationValidationIssue[], code: string, path: string, message: string) {
  if (errors.length < MAX_SCHEMA_ERRORS) {
    errors.push({ code, path, message });
  }
}

function validateType(schema: JsonSchema, value: unknown, path: string, errors: OperationValidationIssue[]) {
  if (!schema.type) {
    return;
  }
  if (schema.type === "object" && !isRecord(value)) {
    add(errors, "schema_invalid_type", path, "field does not match schema type");
  } else if (schema.type === "string" && typeof value !== "string") {
    add(errors, "schema_invalid_type", path, "field does not match schema type");
  } else if (schema.type === "integer" && (!Number.isInteger(value) || typeof value !== "number")) {
    add(errors, "schema_invalid_type", path, "field does not match schema type");
  } else if (schema.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) {
    add(errors, "schema_invalid_type", path, "field does not match schema type");
  } else if (schema.type === "boolean" && typeof value !== "boolean") {
    add(errors, "schema_invalid_type", path, "field does not match schema type");
  }
}

function validateSchemaNode(schema: JsonSchema, value: unknown, path: string, errors: OperationValidationIssue[]) {
  if (schema.oneOf) {
    const passing = schema.oneOf.filter((branch) => {
      const branchErrors: OperationValidationIssue[] = [];
      validateSchemaNode(branch, value, path, branchErrors);
      return branchErrors.length === 0;
    });
    if (passing.length !== 1) {
      add(errors, "schema_one_of", path, "record does not match exactly one schema branch");
    }
    return;
  }

  validateType(schema, value, path, errors);
  if (errors.length >= MAX_SCHEMA_ERRORS) {
    return;
  }
  if ("const" in schema && value !== schema.const) {
    add(errors, "schema_invalid_const", path, "field does not match required schema value");
  }
  if (schema.enum && !schema.enum.includes(value)) {
    add(errors, "schema_invalid_enum", path, "field is not an allowed schema enum value");
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      add(errors, "schema_invalid_length", path, "field length is outside schema bounds");
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      add(errors, "schema_invalid_length", path, "field length is outside schema bounds");
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      add(errors, "schema_invalid_pattern", path, "field does not match schema pattern");
    }
    if (schema.format === "date-time" && Number.isNaN(Date.parse(value))) {
      add(errors, "schema_invalid_timestamp", path, "field does not match schema timestamp format");
    }
  }
  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) {
    add(errors, "schema_invalid_minimum", path, "field is below schema minimum");
  }
  if (schema.type === "object" && isRecord(value)) {
    const properties = schema.properties ?? {};
    if (schema.required) {
      for (const key of schema.required) {
        if (!(key in value)) {
          add(errors, "schema_missing_required", `${path}${path === "/" ? "" : "/"}${key}`, "required field is missing");
        }
      }
    }
    for (const [key, item] of Object.entries(value)) {
      const property = properties[key];
      if (!property) {
        if (schema.additionalProperties === false) {
          add(errors, "schema_unknown_field", path, "unknown field is forbidden");
        }
        continue;
      }
      validateSchemaNode(property, item, `${path}${path === "/" ? "" : "/"}${key}`, errors);
    }
  }
}

export function validateOperationTelemetryJsonSchema(schema: unknown, value: unknown): SchemaValidationResult {
  if (!isRecord(schema)) {
    return {
      ok: false,
      errors: [{ code: "schema_invalid", path: "/", message: "schema must be an object" }],
    };
  }
  const errors: OperationValidationIssue[] = [];
  validateSchemaNode(schema as JsonSchema, value, "/", errors);
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
