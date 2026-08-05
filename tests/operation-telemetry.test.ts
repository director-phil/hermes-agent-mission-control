import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  canonicalOperationRecordString,
  canonicalizeOperationIdSeed,
  makeAttemptId,
  makeIdempotencyKey,
  makeOperationId,
  makeSpanId,
  recordsHaveSameIdempotency,
  validateOperationTelemetryRecord,
  type OperationTelemetryRecord,
} from "../src/lib/operation-telemetry";
import { validateOperationTelemetryJsonSchema } from "../src/lib/operation-telemetry/schema-validator";

const ROOT = process.cwd();
const FIXTURES_DIR = path.join(ROOT, "contracts/operation-telemetry/v1/fixtures");
const SCHEMA_PATH = path.join(ROOT, "contracts/operation-telemetry/v1/schema.json");
const FORBIDDEN_CONTENT_MARKERS = [
  "MALICIOUS_PROMPT_SHOULD_NOT_ECHO",
  "MALICIOUS_RESPONSE_SHOULD_NOT_ECHO",
  "MALICIOUS_ARGS_SHOULD_NOT_ECHO",
  "MALICIOUS_FILE_BODY_SHOULD_NOT_ECHO",
  "MALICIOUS_SECRET_SHOULD_NOT_ECHO",
  "MALICIOUS_PII_SHOULD_NOT_ECHO",
];

type FixtureFile = {
  file: string;
  fixture: string;
  records: unknown[];
};

function cloneRecord(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return structuredClone(value) as Record<string, unknown>;
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function readSchema() {
  return readJson(SCHEMA_PATH);
}

async function readFixtures(prefix: "valid-" | "invalid-"): Promise<FixtureFile[]> {
  const files = (await fs.readdir(FIXTURES_DIR)).filter((file) => file.startsWith(prefix) && file.endsWith(".json"));
  return Promise.all(
    files.sort().map(async (file) => {
      const fixture = await readJson(path.join(FIXTURES_DIR, file));
      assert.equal(typeof fixture, "object");
      assert.notEqual(fixture, null);
      const record = fixture as { fixture?: unknown; records?: unknown };
      assert.equal(typeof record.fixture, "string", file);
      assert.equal(Array.isArray(record.records), true, file);
      return { file, fixture: record.fixture as string, records: record.records as unknown[] };
    }),
  );
}

test("valid golden operation telemetry fixtures pass in stable normalized form", async () => {
  const schema = await readSchema();
  const fixtures = await readFixtures("valid-");
  assert.deepEqual(
    fixtures.map((fixture) => fixture.fixture).sort(),
    [
      "blocked-tool",
      "cancelled-tool",
      "coder-model-tool-success",
      "duplicate",
      "outage-local-only",
      "partial-upload",
      "planner-success",
      "replayed",
      "reviewer-failure",
      "schema-mismatch",
      "upstream-compatibility",
    ],
  );

  const kinds = new Set<string>();
  for (const fixture of fixtures) {
    assert.ok(fixture.records.length > 0, fixture.file);
    for (const record of fixture.records) {
      const schemaResult = validateOperationTelemetryJsonSchema(schema, record);
      const tsResult = validateOperationTelemetryRecord(record);
      assert.equal(schemaResult.ok, true, `${fixture.file} schema errors`);
      assert.equal(tsResult.ok, true, `${fixture.file} ts errors`);
      if (!tsResult.ok) {
        continue;
      }
      kinds.add(tsResult.value.record_kind);
      const normalizedAgain = validateOperationTelemetryRecord(tsResult.value);
      assert.equal(normalizedAgain.ok, true, `${fixture.file} normalized revalidation`);
      assert.equal(
        normalizedAgain.ok ? canonicalOperationRecordString(normalizedAgain.value) : "",
        canonicalOperationRecordString(tsResult.value),
        `${fixture.file} stable normalization`,
      );
      assert.deepEqual(tsResult.value.privacy, {
        metadata_only: true,
        content_recorded: false,
        tool_io_recorded: false,
      });
    }
  }
  assert.deepEqual([...kinds].sort(), ["export_state", "operation_start", "operation_terminal"]);
});

test("invalid operation telemetry fixtures fail deterministically and agree with JSON schema", async () => {
  const schema = await readSchema();
  const fixtures = await readFixtures("invalid-");
  assert.deepEqual(
    fixtures.map((fixture) => fixture.fixture).sort(),
    [
      "invalid-content-bearing",
      "invalid-non-scalar",
      "invalid-oversized-string",
      "invalid-privacy-flags",
      "invalid-schema-version",
      "invalid-unknown-field",
    ],
  );

  for (const fixture of fixtures) {
    for (const record of fixture.records) {
      const schemaResult = validateOperationTelemetryJsonSchema(schema, record);
      const first = validateOperationTelemetryRecord(record);
      const second = validateOperationTelemetryRecord(record);
      assert.equal(schemaResult.ok, false, `${fixture.file} schema must fail`);
      assert.equal(first.ok, false, `${fixture.file} ts must fail`);
      assert.equal(second.ok, false, `${fixture.file} ts must fail repeat`);
      if (!first.ok && !second.ok) {
        assert.deepEqual(first.errors, second.errors, `${fixture.file} deterministic errors`);
        assert.ok(first.errors.length > 0 && first.errors.length <= 16, `${fixture.file} bounded errors`);
      }
    }
  }
});

test("JSON schema and TypeScript validator agree on all golden fixture records", async () => {
  const schema = await readSchema();
  const fixtures = [...(await readFixtures("valid-")), ...(await readFixtures("invalid-"))];
  for (const fixture of fixtures) {
    for (const record of fixture.records) {
      const schemaResult = validateOperationTelemetryJsonSchema(schema, record);
      const tsResult = validateOperationTelemetryRecord(record);
      assert.equal(schemaResult.ok, tsResult.ok, `${fixture.file} agreement`);
    }
  }
});

test("usage normalization rejects every missing required token counter", async () => {
  const schema = await readSchema();
  const fixture = (await readFixtures("valid-")).find((item) => item.fixture === "planner-success");
  assert.ok(fixture);
  const base = cloneRecord(fixture.records[1]);
  const usageKeys = ["input_tokens", "output_tokens", "total_tokens", "cache_read_tokens", "cache_write_tokens"] as const;

  for (const key of usageKeys) {
    const record = cloneRecord(base);
    const usage = cloneRecord(record.usage);
    delete usage[key];
    record.usage = usage;

    const schemaResult = validateOperationTelemetryJsonSchema(schema, record);
    const tsResult = validateOperationTelemetryRecord(record);
    assert.equal(schemaResult.ok, false, `${key} schema must fail`);
    assert.equal(tsResult.ok, false, `${key} ts must fail`);
    assert.equal(
      !tsResult.ok && tsResult.errors.some((error) => error.path === `/usage/${key}`),
      true,
      `${key} missing usage error path`,
    );
  }
});

test("optional tool metadata may be absent but present numeric fields remain required", async () => {
  const schema = await readSchema();
  const fixture = (await readFixtures("valid-")).find((item) => item.fixture === "planner-success");
  assert.ok(fixture);
  const terminalRecord = cloneRecord(fixture.records[1]);
  assert.equal(validateOperationTelemetryJsonSchema(schema, terminalRecord).ok, true);
  assert.equal(validateOperationTelemetryRecord(terminalRecord).ok, true);

  terminalRecord.tool = {
    tool_signature_hash: "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    result_bytes: 0,
    failure_class: "none",
  };
  const schemaResult = validateOperationTelemetryJsonSchema(schema, terminalRecord);
  const tsResult = validateOperationTelemetryRecord(terminalRecord);
  assert.equal(schemaResult.ok, false, "missing optional tool numeric field schema must fail");
  assert.equal(tsResult.ok, false, "missing optional tool numeric field ts must fail");
  assert.equal(
    !tsResult.ok && tsResult.errors.some((error) => error.path === "/tool/argument_bytes"),
    true,
    "missing optional tool numeric field path",
  );
});

test("idempotency and duplicate semantics are stable", async () => {
  const duplicate = (await readFixtures("valid-")).find((fixture) => fixture.fixture === "duplicate");
  assert.ok(duplicate);
  const validated = duplicate.records.map((record) => {
    const result = validateOperationTelemetryRecord(record);
    assert.equal(result.ok, true);
    return (result as { ok: true; value: OperationTelemetryRecord }).value;
  });
  assert.equal(recordsHaveSameIdempotency(validated[0], validated[1]), true);
  assert.equal(recordsHaveSameIdempotency(validated[0], validated[2]), false);

  const seed = {
    goal_id: "goal_p1b",
    run_id: "run_s1",
    stage: "code",
    operation_type: "coder" as const,
    operation_name: "duplicate_terminal",
    attempt: 1,
  };
  assert.equal(canonicalizeOperationIdSeed(seed), canonicalizeOperationIdSeed({ ...seed }));
  assert.equal(makeOperationId(seed), makeOperationId({ ...seed, attempt: 2 }));
  assert.notEqual(makeAttemptId(seed), makeAttemptId({ ...seed, attempt: 2 }));
  assert.equal(makeSpanId({ ...seed, record_kind: "operation_terminal" }), makeSpanId({ ...seed, record_kind: "operation_terminal" }));

  const stableKey = makeIdempotencyKey({
    schema_version: "mc.operation.v1",
    record_kind: "operation_terminal",
    operation_id: "op_duplicate",
    attempt_id: "att_duplicate_1",
    span_id: "span_duplicate_terminal",
    status: "succeeded",
    started_at: "2026-08-05T00:05:00.000Z",
    ended_at: "2026-08-05T00:05:01.000Z",
  });
  assert.match(stableKey, /^sha256:[a-f0-9]{64}$/);
  assert.equal(
    stableKey,
    makeIdempotencyKey({
      schema_version: "mc.operation.v1",
      record_kind: "operation_terminal",
      operation_id: "op_duplicate",
      attempt_id: "att_duplicate_1",
      span_id: "span_duplicate_terminal",
      status: "succeeded",
      started_at: "2026-08-05T00:05:00.000Z",
      ended_at: "2026-08-05T00:05:01.000Z",
    }),
  );
});

test("content-bearing aliases and malicious content do not validate or echo in errors", async () => {
  const fixture = (await readFixtures("invalid-")).find((item) => item.fixture === "invalid-content-bearing");
  assert.ok(fixture);
  const result = validateOperationTelemetryRecord(fixture.records[0]);
  assert.equal(result.ok, false);
  assert.equal(
    !result.ok && result.errors.some((error) => error.code === "content_field_forbidden"),
    true,
  );
  const errorText = JSON.stringify(result);
  for (const marker of FORBIDDEN_CONTENT_MARKERS) {
    assert.equal(errorText.includes(marker), false, marker);
  }

  const validRecords = (await readFixtures("valid-")).flatMap((item) => item.records);
  for (const record of validRecords) {
    const result = validateOperationTelemetryRecord(record);
    assert.equal(result.ok, true);
    if (result.ok) {
      const text = JSON.stringify(result.value);
      assert.equal(text.includes("prompt"), false);
      assert.equal(text.includes("file_body"), false);
      assert.equal(text.includes("secret"), false);
      assert.equal(text.includes("pii"), false);
      assert.equal(text.includes("tool_args"), false);
    }
  }
});
