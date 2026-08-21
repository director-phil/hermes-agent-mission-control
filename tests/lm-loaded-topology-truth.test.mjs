import assert from "node:assert/strict";
import test from "node:test";

import { loadedModelBoxesFromLmsPs } from "../hermes-bridge/bridge.mjs";

const specs = ["coder-box|127.0.0.1:1234", "reviewer-box|10.0.0.150:1234"];
const reachable = [{ reachable: true }, { reachable: true }];

test("publishes only physically loaded generation models on their owning boxes", () => {
  const boxes = loadedModelBoxesFromLmsPs([
    { type: "llm", identifier: "qwen3.8-27b", deviceIdentifier: null, status: "generating" },
    { type: "llm", identifier: "qwen3-coder-next", deviceIdentifier: "box-2-id", status: "idle" },
    { type: "llm", identifier: "glm-ocr", deviceIdentifier: "box-2-id", status: "idle" },
    { type: "embedding", identifier: "text-embedding-bge-m3", deviceIdentifier: null },
  ], specs, reachable);

  assert.deepEqual(boxes, [
    { label: "coder-box", host: "127.0.0.1:1234", reachable: true, models: ["qwen3.8-27b"], modelStates: [{ id: "qwen3.8-27b", status: "generating" }] },
    { label: "reviewer-box", host: "10.0.0.150:1234", reachable: true, models: ["qwen3-coder-next", "glm-ocr"], modelStates: [{ id: "qwen3-coder-next", status: "idle" }, { id: "glm-ocr", status: "idle" }] },
  ]);
});

test("does not substitute the downloaded catalogue when loaded-state is unavailable", () => {
  assert.deepEqual(loadedModelBoxesFromLmsPs([], specs, reachable), [
    { label: "coder-box", host: "127.0.0.1:1234", reachable: true, models: [], modelStates: [] },
    { label: "reviewer-box", host: "10.0.0.150:1234", reachable: true, models: [], modelStates: [] },
  ]);
});
