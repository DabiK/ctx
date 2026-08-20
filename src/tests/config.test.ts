/**
 * Project-config (.ctx.toml) parser tests.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  clampBatchBytes,
  clampFileBytes,
  DEFAULT_CONFIG,
  MAX_BATCH_BYTES,
  MAX_FILE_BYTES,
  parseProjectConfig,
} from "../config.js";

describe("parseProjectConfig", () => {
  it("returns defaults for missing config", () => {
    assert.deepEqual(parseProjectConfig(null), DEFAULT_CONFIG);
  });

  it("parses line_numbers, allowed_roots, and sensitive_paths", () => {
    const config = parseProjectConfig(
      [
        `# ctx project configuration`,
        `allowed_roots = ["/projects/other", "/projects/third"]`,
        `line_numbers = false`,
        `sensitive_paths = [".env", "secrets/"]`,
      ].join("\n"),
    );
    assert.deepEqual(config.allowedRoots, ["/projects/other", "/projects/third"]);
    assert.equal(config.lineNumbers, false);
    assert.deepEqual(config.sensitivePaths, [".env", "secrets/"]);
  });

  it("parses the discovery limits tree_depth, inspect_depth, and max_results", () => {
    const config = parseProjectConfig(
      ["tree_depth = 5", "inspect_depth = 2", "max_results = 250"].join("\n"),
    );
    assert.equal(config.treeDepth, 5);
    assert.equal(config.inspectDepth, 2);
    assert.equal(config.maxResults, 250);
  });

  it("keeps the default discovery limits for missing or malformed values", () => {
    assert.equal(parseProjectConfig(null).treeDepth, DEFAULT_CONFIG.treeDepth);
    assert.equal(parseProjectConfig(null).inspectDepth, DEFAULT_CONFIG.inspectDepth);
    assert.equal(parseProjectConfig(null).maxResults, DEFAULT_CONFIG.maxResults);
    const malformed = parseProjectConfig(["tree_depth = deep", "max_results = many"].join("\n"));
    assert.equal(malformed.treeDepth, DEFAULT_CONFIG.treeDepth);
    assert.equal(malformed.maxResults, DEFAULT_CONFIG.maxResults);
  });

  it("defaults line_numbers to true", () => {
    assert.equal(parseProjectConfig("# nothing here\n").lineNumbers, true);
    assert.equal(parseProjectConfig("").lineNumbers, true);
  });

  it("ignores malformed values and keeps defaults", () => {
    const config = parseProjectConfig(
      ["line_numbers = maybe", 'allowed_roots = "not-an-array"', "sensitive_paths = broken"].join("\n"),
    );
    assert.equal(config.lineNumbers, true);
    assert.deepEqual(config.allowedRoots, []);
    assert.deepEqual(config.sensitivePaths, []);
  });

  it("accepts single-quoted strings and empty arrays", () => {
    const config = parseProjectConfig(
      ['allowed_roots = []', `sensitive_paths = ['a', 'b']`].join("\n"),
    );
    assert.deepEqual(config.allowedRoots, []);
    assert.deepEqual(config.sensitivePaths, ["a", "b"]);
  });

  it("parses the budget limits max_file_bytes and max_batch_bytes", () => {
    const config = parseProjectConfig(
      ["max_file_bytes = 4096", "max_batch_bytes = 65536"].join("\n"),
    );
    assert.equal(config.maxFileBytes, 4096);
    assert.equal(config.maxBatchBytes, 65536);
  });

  it("keeps the default budgets for missing or malformed values", () => {
    assert.equal(parseProjectConfig(null).maxFileBytes, DEFAULT_CONFIG.maxFileBytes);
    assert.equal(parseProjectConfig(null).maxBatchBytes, DEFAULT_CONFIG.maxBatchBytes);
    const malformed = parseProjectConfig(
      ["max_file_bytes = many", "max_batch_bytes = 0", "max_batch_bytes = big"].join("\n"),
    );
    assert.equal(malformed.maxFileBytes, DEFAULT_CONFIG.maxFileBytes);
    assert.equal(malformed.maxBatchBytes, DEFAULT_CONFIG.maxBatchBytes);
  });

  it("clamps budgets to the hard caps", () => {
    assert.equal(clampFileBytes(0), 1);
    assert.equal(clampFileBytes(Number.MAX_SAFE_INTEGER), MAX_FILE_BYTES);
    assert.equal(clampFileBytes(3.9), 3);
    assert.equal(clampBatchBytes(0), 1);
    assert.equal(clampBatchBytes(Number.MAX_SAFE_INTEGER), MAX_BATCH_BYTES);
    assert.equal(clampBatchBytes(10.9), 10);
  });
});