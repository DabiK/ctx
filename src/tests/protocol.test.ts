/**
 * Protocol parser tests: `@ctx file` / `@ctx files` requests and path specs.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parsePathSpec, parseRequestText, isSafeRevision, isSafeShowPath } from "../protocol.js";

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
    const r = parseRequestText("@ctx nope");
    assert.ok(!r.ok);
    if (!r.ok) {
      assert.ok(r.reason.includes("unsupported operation `nope`"));
    }
    const b = parseRequestText("@ctx patch");
    assert.ok(!b.ok);
    if (!b.ok) {
      assert.ok(b.reason.includes("unsupported operation `patch`"));
    }
  });

  it("parses a @ctx batch container and flattens its members in order", () => {
    const r = parseRequestText(
      [
        "@ctx batch",
        "@ctx file src/app.ts:1-20",
        "@ctx search \"foo bar\"",
        "@ctx status",
      ].join("\n"),
    );
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.batch, true);
      assert.deepEqual(r.ops, [
        { kind: "file", specs: ["src/app.ts:1-20"] },
        { kind: "search", query: "foo bar" },
        { kind: "status" },
      ]);
    }
  });

  it("keeps operations before the batch outside it but still orders them", () => {
    const r = parseRequestText(
      ["@ctx file a.ts", "@ctx batch", "@ctx tree --depth 2", "chat text", "@ctx changed"].join("\n"),
    );
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.batch, true);
      assert.deepEqual(r.ops, [
        { kind: "file", specs: ["a.ts"] },
        { kind: "tree", depth: 2 },
        { kind: "changed", path: null },
      ]);
    }
  });

  it("refuses a batch with arguments", () => {
    const r = parseRequestText("@ctx batch read a.ts");
    assert.ok(!r.ok);
    if (!r.ok) {
      assert.ok(r.reason.includes("batch` accepts no arguments"));
    }
  });

  it("refuses malformed batch nesting", () => {
    const r = parseRequestText(["@ctx batch", "@ctx batch", "@ctx file a.ts"].join("\n"));
    assert.ok(!r.ok);
    if (!r.ok) {
      assert.ok(r.reason.includes("malformed nesting"));
    }
  });

  it("refuses an empty batch", () => {
    const r = parseRequestText("@ctx batch");
    assert.ok(!r.ok);
    if (!r.ok) {
      assert.ok(r.reason.includes("empty @ctx batch"));
    }
    const onlyOutside = parseRequestText(["@ctx file a.ts", "@ctx batch"].join("\n"));
    assert.ok(!onlyOutside.ok);
    if (!onlyOutside.ok) {
      assert.ok(onlyOutside.reason.includes("empty @ctx batch"));
    }
  });

  it("marks plain requests as non-batch", () => {
    const r = parseRequestText("@ctx status");
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.batch, false);
    }
    const mixed = parseRequestText(["@ctx file a.ts", "@ctx tree"].join("\n"));
    assert.ok(mixed.ok);
    if (mixed.ok) {
      assert.equal(mixed.batch, false);
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

  it("parses the Git context operations", () => {
    const status = parseRequestText("@ctx status");
    assert.ok(status.ok);
    if (status.ok) {
      assert.deepEqual(status.ops, [{ kind: "status" }]);
    }

    const changed = parseRequestText("@ctx changed src/lib");
    assert.ok(changed.ok);
    if (changed.ok) {
      assert.deepEqual(changed.ops, [{ kind: "changed", path: "src/lib" }]);
    }

    const changedPlain = parseRequestText("@ctx changed");
    assert.ok(changedPlain.ok);
    if (changedPlain.ok) {
      assert.deepEqual(changedPlain.ops, [{ kind: "changed", path: null }]);
    }

    const diff = parseRequestText("@ctx diff src/app.ts");
    assert.ok(diff.ok);
    if (diff.ok) {
      assert.deepEqual(diff.ops, [{ kind: "diff", staged: false, path: "src/app.ts" }]);
    }

    const staged = parseRequestText("@ctx diff --staged");
    assert.ok(staged.ok);
    if (staged.ok) {
      assert.deepEqual(staged.ops, [{ kind: "diff", staged: true, path: null }]);
    }

    const log = parseRequestText("@ctx log --limit 5 src/lib");
    assert.ok(log.ok);
    if (log.ok) {
      assert.deepEqual(log.ops, [{ kind: "log", limit: 5, path: "src/lib" }]);
    }

    const show = parseRequestText("@ctx show HEAD~1 src/app.ts");
    assert.ok(show.ok);
    if (show.ok) {
      assert.deepEqual(show.ops, [{ kind: "show", rev: "HEAD~1", path: "src/app.ts" }]);
    }
  });

  it("mixes Git operations with reads and discovery in one request", () => {
    const r = parseRequestText(["@ctx status", "@ctx diff --staged src/app.ts"].join("\n"));
    assert.ok(r.ok);
    if (r.ok) {
      assert.deepEqual(r.ops, [
        { kind: "status" },
        { kind: "diff", staged: true, path: "src/app.ts" },
      ]);
    }
  });

  it("refuses malformed Git context requests", () => {
    assert.ok(!parseRequestText("@ctx status extra").ok);
    assert.ok(!parseRequestText("@ctx changed a b").ok);
    assert.ok(!parseRequestText("@ctx diff a b").ok);
    assert.ok(!parseRequestText("@ctx log --limit 0").ok);
    assert.ok(!parseRequestText("@ctx log --limit 1001").ok);
    assert.ok(!parseRequestText("@ctx log a b").ok);
    assert.ok(!parseRequestText("@ctx show HEAD").ok);
    assert.ok(!parseRequestText("@ctx show HEAD a b").ok);
  });

  it("refuses unsafe revisions in show requests before any execution", () => {
    for (const rev of [
      "$(rm -rf /)",
      "HEAD;ls",
      "a..b",
      "-n",
      "--all",
      "feature x",
      "..",
      "HEAD~",
      "a//b",
      "a/./b",
      "refs\\heads\\main",
      "",
    ]) {
      const r = parseRequestText(`@ctx show ${rev} src/app.ts`);
      assert.ok(!r.ok, `revision \`${rev}\` must be refused`);
      if (!r.ok) {
        assert.ok(
          r.reason.includes("unsafe revision") || r.reason.includes("requires exactly"),
          `reason for \`${rev}\`: ${r.reason}`,
        );
      }
    }
  });

  it("refuses unsafe show paths", () => {
    for (const path of ["/etc/passwd", "../secret", "C:\\Windows\\x", "a:b", "a%b", "..", "", "dir//..", "."]) {
      const r = parseRequestText(`@ctx show HEAD ${path}`);
      assert.ok(!r.ok, `path \`${path}\` must be refused`);
      if (!r.ok) {
        assert.ok(
          r.reason.includes("unsafe path") || r.reason.includes("requires exactly"),
          `reason for \`${path}\`: ${r.reason}`,
        );
      }
    }
  });
});

describe("isSafeRevision", () => {
  it("accepts HEAD, ancestry, hashes, and plain branch/tag names", () => {
    for (const rev of [
      "HEAD",
      "HEAD~1",
      "HEAD~42",
      "HEAD^",
      "HEAD^2",
      "a1b2c3d",
      "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
      "main",
      "feature/x",
      "release-1.2",
      "v1.2.3",
      "refs/heads/main",
      "origin/main",
      "fix_123",
    ]) {
      assert.equal(isSafeRevision(rev), true, `\`${rev}\` should be safe`);
    }
  });

  it("refuses command fragments, ranges, and option-like forms", () => {
    for (const rev of [
      "",
      "HEAD;ls",
      "$(echo x)",
      "`id`",
      "a..b",
      "-x",
      "--all",
      "feature x",
      "HEAD~",
      "HEAD~-1",
      "a//b",
      "a/./b",
      "a.",
      ".hidden",
      "a b/c",
    ]) {
      assert.equal(isSafeRevision(rev), false, `\`${rev}\` must be refused`);
    }
  });
});

describe("isSafeShowPath", () => {
  it("accepts repository-relative paths", () => {
    for (const path of ["src/app.ts", "docs/guide.md", "README.md", "a/b/c.txt", "dir.with-dots/x"]) {
      assert.equal(isSafeShowPath(path), true, `\`${path}\` should be safe`);
    }
  });

  it("refuses absolute, traversal, and special-character paths", () => {
    for (const path of [
      "",
      "/etc/passwd",
      "C:\\Windows\\x",
      "../secret",
      "a/../b",
      "a:b",
      "a%b",
      "..",
      ".",
      "  ",
    ]) {
      assert.equal(isSafeShowPath(path), false, `\`${path}\` must be refused`);
    }
  });
});