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
    const r = parseRequestText("@ctx tree --depth 2");
    assert.ok(!r.ok);
    if (!r.ok) {
      assert.ok(r.reason.includes("unsupported operation `tree`"));
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