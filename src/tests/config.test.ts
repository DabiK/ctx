/**
 * Project-config (.ctx.toml) parser tests.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_CONFIG, parseProjectConfig } from "../config.js";

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
});