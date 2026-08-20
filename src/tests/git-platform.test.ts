/**
 * Platform Git parser tests: the pure output parsers of the SystemGit
 * adapter (porcelain status, numstat, log format). These run on any host
 * without a Git executable.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseLogOutput, parseNumstat, parsePorcelainV1 } from "../platform/git.js";

describe("parsePorcelainV1", () => {
  it("parses branch, staged, modified, untracked, and deleted files", () => {
    const out = parsePorcelainV1(
      [
        "## main...origin/main [ahead 1]",
        "M  src/app.ts",
        " M src/lib/util.ts",
        "?? notes.md",
        " D old.ts",
        "D  gone.ts",
      ].join("\n"),
    );

    assert.equal(out.branch, "main");
    assert.deepEqual(out.files, [
      { relPath: "src/app.ts", state: "staged" },
      { relPath: "src/lib/util.ts", state: "modified" },
      { relPath: "notes.md", state: "untracked" },
      { relPath: "old.ts", state: "deleted" },
      { relPath: "gone.ts", state: "deleted" },
    ]);
  });

  it("handles a detached HEAD and empty repositories", () => {
    assert.equal(parsePorcelainV1("## HEAD (no branch)\n").branch, null);
    assert.equal(parsePorcelainV1("## No commits yet on main\n").branch, "main");
    assert.equal(parsePorcelainV1("## Initial commit on feat/x\n").branch, "feat/x");
    assert.equal(parsePorcelainV1("## main\n").branch, "main");
    assert.equal(parsePorcelainV1("## main\n").files.length, 0);
  });

  it("keeps the destination path of rename entries", () => {
    const out = parsePorcelainV1("R  old.ts -> new.ts\n");
    assert.deepEqual(out.files, [{ relPath: "new.ts", state: "staged" }]);
  });

  it("ignores blank lines", () => {
    assert.deepEqual(parsePorcelainV1("").files, []);
    assert.deepEqual(parsePorcelainV1("\n\n").files, []);
  });
});

describe("parseNumstat", () => {
  it("sums insertions and deletions per file", () => {
    const summary = parseNumstat("5\t3\tsrc/app.ts\n1\t1\tsrc/lib/util.ts\n");
    assert.deepEqual(summary, { files: 2, insertions: 6, deletions: 4 });
  });

  it("counts binary entries without summing them", () => {
    const summary = parseNumstat("5\t3\tsrc/app.ts\n-\t-\tbin/data.bin\n");
    assert.deepEqual(summary, { files: 2, insertions: 5, deletions: 3 });
  });

  it("returns zeros for empty output", () => {
    assert.deepEqual(parseNumstat(""), { files: 0, insertions: 0, deletions: 0 });
  });
});

describe("parseLogOutput", () => {
  it("parses hash, date, and subject lines", () => {
    const entries = parseLogOutput(
      "8f3a9b1\u001f2026-08-20\u001fAdd git context\n1a2b3c4\u001f2026-08-19\u001fFix search\n",
    );
    assert.deepEqual(entries, [
      { shortHash: "8f3a9b1", date: "2026-08-20", subject: "Add git context" },
      { shortHash: "1a2b3c4", date: "2026-08-19", subject: "Fix search" },
    ]);
  });

  it("returns no entries for empty output", () => {
    assert.deepEqual(parseLogOutput(""), []);
  });
});