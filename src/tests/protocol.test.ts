/**
 * Protocol parser tests: `@ctx file` / `@ctx files` requests and path specs.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parsePathSpec, parseRequestText } from "../protocol.js";

describe("parsePathSpec", () => {
  it("accepts a plain path without a range", () => {
    const r = parsePathSpec("src/foo.ts");
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.path, "src/foo.ts");
      assert.equal(r.range, null);
    }
  });

  it("accepts full, open-ended, and single-line ranges", () => {
    const full = parsePathSpec("src/foo.ts:10-20");
    assert.ok(full.ok && full.range !== null);
    if (full.ok && full.range !== null) {
      assert.equal(full.path, "src/foo.ts");
      assert.deepEqual(full.range, { start: 10, end: 20 });
    }

    const openEnd = parsePathSpec("src/foo.ts:10-");
    assert.ok(openEnd.ok && openEnd.range !== null);
    if (openEnd.ok && openEnd.range !== null) {
      assert.equal(openEnd.range.start, 10);
      assert.equal(openEnd.range.end, Number.MAX_SAFE_INTEGER);
    }

    const single = parsePathSpec("src/foo.ts:7");
    assert.ok(single.ok && single.range !== null);
    if (single.ok && single.range !== null) {
      assert.deepEqual(single.range, { start: 7, end: 7 });
    }

    const fromStart = parsePathSpec("src/foo.ts:-5");
    assert.ok(fromStart.ok && fromStart.range !== null);
    if (fromStart.ok && fromStart.range !== null) {
      assert.deepEqual(fromStart.range, { start: 1, end: 5 });
    }
  });

  it("keeps colons inside plain file names", () => {
    const r = parsePathSpec("notes:meeting.md");
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.path, "notes:meeting.md");
      assert.equal(r.range, null);
    }
  });

  it("rejects invalid ranges", () => {
    assert.ok(!parsePathSpec("src/foo.ts:0-5").ok);
    assert.ok(!parsePathSpec("src/foo.ts:10-5").ok);
    assert.ok(!parsePathSpec("src/foo.ts:0").ok);
    assert.ok(!parsePathSpec("").ok);
  });

  it("treats a non-numeric colon suffix as a plain (probably missing) path", () => {
    const r = parsePathSpec("src/foo.ts:abc");
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.path, "src/foo.ts:abc");
      assert.equal(r.range, null);
    }
  });
});

describe("parseRequestText", () => {
  it("parses a single file request", () => {
    const r = parseRequestText("@ctx file src/foo.ts:10-20");
    assert.ok(r.ok);
    if (r.ok) {
      assert.deepEqual(r.ops, [{ kind: "file", specs: ["src/foo.ts:10-20"] }]);
    }
  });

  it("parses a files request with several paths", () => {
    const r = parseRequestText("@ctx files a.ts b.ts:2-5 c.ts");
    assert.ok(r.ok);
    if (r.ok) {
      assert.deepEqual(r.ops, [{ kind: "files", specs: ["a.ts", "b.ts:2-5", "c.ts"] }]);
    }
  });

  it("parses multiple ops and ignores ordinary chat text", () => {
    const r = parseRequestText(
      ["Please look at these files:", "@ctx file a.ts", "@ctx files b.ts c.ts", "Thanks!"].join("\n"),
    );
    assert.ok(r.ok);
    if (r.ok) {
      assert.deepEqual(r.ops, [
        { kind: "file", specs: ["a.ts"] },
        { kind: "files", specs: ["b.ts", "c.ts"] },
      ]);
    }
  });

  it("refuses unsupported operations with a structured reason", () => {
    const r = parseRequestText("@ctx status");
    assert.ok(!r.ok);
    if (!r.ok) {
      assert.ok(r.reason.includes("unsupported operation `status`"));
    }
    const b = parseRequestText("@ctx batch read a.ts");
    assert.ok(!b.ok);
    if (!b.ok) {
      assert.ok(b.reason.includes("unsupported operation `batch`"));
    }
  });

  it("parses tree with an optional --depth", () => {
    const plain = parseRequestText("@ctx tree");
    assert.ok(plain.ok);
    if (plain.ok) {
      assert.deepEqual(plain.ops, [{ kind: "tree", depth: null }]);
    }
    const withDepth = parseRequestText("@ctx tree --depth 5");
    assert.ok(withDepth.ok);
    if (withDepth.ok) {
      assert.deepEqual(withDepth.ops, [{ kind: "tree", depth: 5 }]);
    }
  });

  it("rejects malformed tree requests", () => {
    assert.ok(!parseRequestText("@ctx tree --depth").ok);
    assert.ok(!parseRequestText("@ctx tree --depth 0").ok);
    assert.ok(!parseRequestText("@ctx tree --depth 11").ok);
    assert.ok(!parseRequestText("@ctx tree --depth abc").ok);
    assert.ok(!parseRequestText("@ctx tree src/").ok);
  });

  it("parses glob, inspect, and search requests", () => {
    const glob = parseRequestText("@ctx glob src/**/*.ts");
    assert.ok(glob.ok);
    if (glob.ok) {
      assert.deepEqual(glob.ops, [{ kind: "glob", pattern: "src/**/*.ts" }]);
    }

    const inspectRoot = parseRequestText("@ctx inspect");
    assert.ok(inspectRoot.ok);
    if (inspectRoot.ok) {
      assert.deepEqual(inspectRoot.ops, [{ kind: "inspect", path: null }]);
    }
    const inspectPath = parseRequestText("@ctx inspect docs");
    assert.ok(inspectPath.ok);
    if (inspectPath.ok) {
      assert.deepEqual(inspectPath.ops, [{ kind: "inspect", path: "docs" }]);
    }

    const search = parseRequestText("@ctx search TODO fix");
    assert.ok(search.ok);
    if (search.ok) {
      assert.deepEqual(search.ops, [{ kind: "search", query: "TODO fix" }]);
    }
    const quoted = parseRequestText('@ctx search "foo bar"');
    assert.ok(quoted.ok);
    if (quoted.ok) {
      assert.deepEqual(quoted.ops, [{ kind: "search", query: "foo bar" }]);
    }
  });

  it("rejects malformed glob, inspect, and search requests", () => {
    assert.ok(!parseRequestText("@ctx glob").ok);
    assert.ok(!parseRequestText("@ctx glob a b").ok);
    assert.ok(!parseRequestText("@ctx inspect a b").ok);
    assert.ok(!parseRequestText("@ctx search").ok);
    assert.ok(!parseRequestText('@ctx search ""').ok);
  });

  it("parses a mixed request with read and discovery operations", () => {
    const r = parseRequestText(["@ctx file src/app.ts", "@ctx tree --depth 2", "@ctx search TODO"].join("\n"));
    assert.ok(r.ok);
    if (r.ok) {
      assert.deepEqual(r.ops, [
        { kind: "file", specs: ["src/app.ts"] },
        { kind: "tree", depth: 2 },
        { kind: "search", query: "TODO" },
      ]);
    }
  });

  it("refuses malformed file/files requests", () => {
    assert.ok(!parseRequestText("@ctx file").ok);
    assert.ok(!parseRequestText("@ctx file a.ts b.ts").ok);
    assert.ok(!parseRequestText("@ctx files").ok);
    assert.ok(!parseRequestText("@ctx").ok);
  });

  it("reports when no request is present", () => {
    const r = parseRequestText("just some chat text");
    assert.ok(!r.ok);
    if (!r.ok) {
      assert.ok(r.reason.includes("no @ctx request found"));
    }
  });

  it("tolerates CRLF line endings and leading whitespace", () => {
    const r = parseRequestText("  @ctx file a.ts\r\n@ctx files b.ts\r\n");
    assert.ok(r.ok);
    if (r.ok) {
      assert.deepEqual(r.ops, [
        { kind: "file", specs: ["a.ts"] },
        { kind: "files", specs: ["b.ts"] },
      ]);
    }
  });
});