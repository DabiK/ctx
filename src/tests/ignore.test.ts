/**
 * Ignore-matcher tests: gitignore-style patterns used by `.ctxignore` and
 * sensitive-path checks.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { compileIgnorePatterns } from "../ignore.js";

function matches(patterns: string[], relPath: string): string | null {
  return compileIgnorePatterns(patterns).match(relPath);
}

describe("compileIgnorePatterns", () => {
  it("matches nothing for empty, blank, and comment lines", () => {
    assert.equal(matches(["", "   ", "# comment"], "a/b.ts"), null);
  });

  it("matches directory patterns at any depth and everything under them", () => {
    const patterns = ["dist/"];
    assert.notEqual(matches(patterns, "dist"), null);
    assert.notEqual(matches(patterns, "dist/app.js"), null);
    assert.notEqual(matches(patterns, "a/b/dist/app.js"), null);
    assert.equal(matches(patterns, "dist.js"), null);
    assert.equal(matches(patterns, "src/dist-tools/app.js"), null);
  });

  it("matches basename patterns at any depth", () => {
    const patterns = [".env.*"];
    assert.notEqual(matches(patterns, ".env.local"), null);
    assert.notEqual(matches(patterns, "config/.env.local"), null);
    assert.equal(matches(patterns, ".env"), null);
    assert.equal(matches(patterns, "src/env.local"), null);
  });

  it("matches star/glob patterns from the init template", () => {
    const patterns = ["node_modules/", "*.log", "*.tsbuildinfo", "id_rsa*", "*.pem"];
    assert.notEqual(matches(patterns, "node_modules/x/y.js"), null);
    assert.notEqual(matches(patterns, "logs/server.log"), null);
    assert.notEqual(matches(patterns, "tsconfig.tsbuildinfo"), null);
    assert.notEqual(matches(patterns, ".ssh/id_rsa.pub"), null);
    assert.notEqual(matches(patterns, "cert.pem"), null);
    assert.equal(matches(patterns, "src/server.ts"), null);
    assert.equal(matches(patterns, "my_id_rsa.txt.bak"), null);
  });

  it("anchors patterns containing a slash", () => {
    const patterns = ["build/output/"];
    assert.notEqual(matches(patterns, "build/output/x.js"), null);
    assert.equal(matches(patterns, "src/build/output/x.js"), null);
  });

  it("supports double-star at the start", () => {
    const patterns = ["**/test/"];
    assert.notEqual(matches(patterns, "test/a.ts"), null);
    assert.notEqual(matches(patterns, "packages/a/test/b.ts"), null);
  });

  it("last matching pattern wins and negation re-includes", () => {
    const patterns = ["dist/", "!dist/keep.js"];
    assert.notEqual(matches(patterns, "dist/app.js"), null);
    assert.equal(matches(patterns, "dist/keep.js"), null);
  });

  it("matches literal files and exact names", () => {
    const patterns = [".DS_Store", "Thumbs.db"];
    assert.notEqual(matches(patterns, ".DS_Store"), null);
    assert.notEqual(matches(patterns, "sub/.DS_Store"), null);
    assert.equal(matches(patterns, ".DS_Storex"), null);
  });
});