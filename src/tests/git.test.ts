/**
 * GitUseCase unit tests: status, changed, diff, log, and show through the
 * repository permission boundary with fake Git and filesystem ports.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { GitUseCase } from "../application/git.js";
import { RESPONSE_MARKER } from "../branding.js";
import { fakePorts, type FakeGit } from "./fakes.js";

function makeGit(overrides: { git?: FakeGit } = {}): {
  git: GitUseCase;
  gitPort: FakeGit;
  ports: ReturnType<typeof fakePorts>["ports"];
  terminal: ReturnType<typeof fakePorts>["terminal"];
  clipboard: ReturnType<typeof fakePorts>["clipboard"];
  fs: ReturnType<typeof fakePorts>["fs"];
} {
  const { ports, terminal, clipboard, fs, git } = fakePorts({ git: overrides.git });
  return { git: new GitUseCase(clipboard, terminal, git, fs), gitPort: git, ports, terminal, clipboard, fs };
}

const DIRECT = { copy: false, allowSensitive: false, protocol: false } as const;

describe("GitUseCase.status", () => {
  it("prints branch and per-state buckets", async () => {
    const { git, gitPort, terminal } = makeGit();
    gitPort.statusFiles = [
      { relPath: "src/app.ts", state: "staged" },
      { relPath: "src/lib/util.ts", state: "modified" },
      { relPath: "notes.md", state: "untracked" },
      { relPath: "old.ts", state: "deleted" },
    ];

    const code = await git.status(DIRECT);

    assert.equal(code, 0);
    const out = terminal.infoLines.join("\n");
    assert.ok(out.includes("Branch: main"));
    assert.ok(out.includes("Staged: 1 | Modified: 1 | Untracked: 1 | Deleted: 1"));
    assert.ok(out.includes("Staged:"));
    assert.ok(out.includes("- src/app.ts"));
    assert.ok(out.includes("- old.ts"));
  });

  it("reports a detached HEAD and a clean working tree", async () => {
    const { git, gitPort, terminal } = makeGit();
    gitPort.branch = null;

    const code = await git.status(DIRECT);

    assert.equal(code, 1, "a clean tree produces no content");
    const out = terminal.infoLines.join("\n");
    assert.ok(out.includes("Branch: (detached HEAD)"));
    assert.ok(out.includes("Working tree clean."));
  });

  it("copies the stable response only with --copy", async () => {
    const { git, gitPort, clipboard } = makeGit();
    gitPort.statusFiles = [{ relPath: "src/app.ts", state: "staged" }];

    await git.status({ ...DIRECT, copy: true });

    const copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.startsWith(RESPONSE_MARKER));
    assert.ok(copied.includes("## Status"));
    assert.ok(copied.includes("- src/app.ts"));
  });

  it("fails with an actionable message outside a repository", async () => {
    const { git, gitPort, terminal } = makeGit();
    gitPort.rootToReport = null;

    const code = await git.status(DIRECT);

    assert.equal(code, 1);
    assert.ok(terminal.errorLines.some((l) => l.includes("requires a Git repository")));
  });

  it("reports an unexpected Git port failure", async () => {
    const { git, gitPort, terminal } = makeGit();
    gitPort.failWith = new Error("git exploded");

    const code = await git.status(DIRECT);

    assert.equal(code, 1);
    assert.ok(terminal.errorLines.some((l) => l.includes("Git operation failed: git exploded")));
  });
});

describe("GitUseCase.changed", () => {
  it("lists files with their state bucket", async () => {
    const { git, gitPort, terminal } = makeGit();
    gitPort.statusFiles = [
      { relPath: "src/app.ts", state: "modified" },
      { relPath: "notes.md", state: "untracked" },
    ];

    const code = await git.changed(null, DIRECT);

    assert.equal(code, 0);
    const out = terminal.infoLines.join("\n");
    assert.ok(out.includes("Files: 2 | Staged: 0 | Modified: 1 | Untracked: 1 | Deleted: 0"));
    assert.ok(out.includes("- src/app.ts (modified)"));
    assert.ok(out.includes("- notes.md (untracked)"));
  });

  it("scopes the list to a validated path", async () => {
    const { git, gitPort, fs, terminal } = makeGit();
    fs.seed("/repo/src/lib/util.ts", "util\n");
    fs.seed("/repo/docs/guide.md", "guide\n");
    gitPort.statusFiles = [
      { relPath: "src/lib/util.ts", state: "modified" },
      { relPath: "docs/guide.md", state: "modified" },
    ];

    const code = await git.changed("src", DIRECT);

    assert.equal(code, 0);
    const out = terminal.infoLines.join("\n");
    assert.ok(out.includes("- src/lib/util.ts (modified)"));
    assert.ok(!out.includes("docs/guide.md"), "files outside the scope are filtered");
  });

  it("explains a refused scope instead of silently filtering", async () => {
    const { git, gitPort, terminal } = makeGit();
    gitPort.statusFiles = [{ relPath: "src/app.ts", state: "staged" }];

    const code = await git.changed("missing-dir", DIRECT);

    assert.equal(code, 1);
    assert.ok(terminal.infoLines.join("\n").includes("Scope refused"));
  });

  it("reports a clean list with no changes", async () => {
    const { git, terminal } = makeGit();

    const code = await git.changed(null, DIRECT);

    assert.equal(code, 1);
    assert.ok(terminal.infoLines.join("\n").includes("No changes."));
  });
});

describe("GitUseCase.diff", () => {
  it("requests the working-tree diff unscoped", async () => {
    const { git, gitPort, terminal } = makeGit();
    gitPort.diffText = "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-alpha\n+beta\n";
    gitPort.diffFiles = 1;
    gitPort.diffInsertions = 1;
    gitPort.diffDeletions = 1;

    const code = await git.diff(null, false, DIRECT);

    assert.equal(code, 0);
    assert.equal(gitPort.lastDiffPath, null);
    assert.equal(gitPort.lastDiffStaged, false);
    const out = terminal.infoLines.join("\n");
    assert.ok(out.includes("Files: 1 | Insertions: 1 | Deletions: 1"));
    assert.ok(out.includes("+beta"));
  });

  it("requests the staged diff scoped to a validated path", async () => {
    const { git, gitPort, fs } = makeGit();
    fs.seed("/repo/src/app.ts", "app\n");
    gitPort.diffText = "";
    gitPort.diffFiles = 0;

    const code = await git.diff("src/app.ts", true, DIRECT);

    assert.equal(code, 1, "an empty diff produces no content");
    assert.equal(gitPort.lastDiffPath, "src/app.ts");
    assert.equal(gitPort.lastDiffStaged, true);
  });

  it("explains a refused scope path", async () => {
    const { git, terminal } = makeGit();

    const code = await git.diff("outside.ts", false, DIRECT);

    assert.equal(code, 1);
    assert.ok(terminal.infoLines.join("\n").includes("Scope refused"));
  });
});

describe("GitUseCase.log", () => {
  it("renders bounded commits and passes the limit to the port", async () => {
    const { git, gitPort, terminal } = makeGit();
    gitPort.logEntries = [
      { shortHash: "8f3a9b1", date: "2026-08-20", subject: "Add git context" },
      { shortHash: "1a2b3c4", date: "2026-08-19", subject: "Fix search" },
    ];

    const code = await git.log(null, { ...DIRECT, limit: 5 });

    assert.equal(code, 0);
    assert.equal(gitPort.lastLogLimit, 5);
    const out = terminal.infoLines.join("\n");
    assert.ok(out.includes("Commits: 2"));
    assert.ok(out.includes("- 8f3a9b1 2026-08-20 Add git context"));
  });

  it("scopes to a validated path", async () => {
    const { git, gitPort, fs } = makeGit();
    fs.seed("/repo/src/app.ts", "app\n");

    const code = await git.log("src/app.ts", DIRECT);

    assert.equal(code, 1, "no commits produces no content");
    assert.equal(gitPort.lastLogPath, "src/app.ts");
  });

  it("explains a refused scope path", async () => {
    const { git, terminal } = makeGit();

    const code = await git.log("missing", DIRECT);

    assert.equal(code, 1);
    assert.ok(terminal.infoLines.join("\n").includes("Scope refused"));
  });
});

describe("GitUseCase.show", () => {
  it("shows blob content at a revision", async () => {
    const { git, gitPort, terminal } = makeGit();
    gitPort.showContents.set("HEAD~1:src/app.ts", "old content\nline two\n");

    const code = await git.show("HEAD~1", "src/app.ts", DIRECT);

    assert.equal(code, 0);
    assert.equal(gitPort.lastShowRev, "HEAD~1");
    assert.equal(gitPort.lastShowPath, "src/app.ts");
    const out = terminal.infoLines.join("\n");
    assert.ok(out.includes("old content"));
    assert.ok(out.includes("line two"));
  });

  it("surfaces the Git diagnostic for a missing object", async () => {
    const { git, gitPort, terminal } = makeGit();
    gitPort.showErrors.set("deadbeef:src/app.ts", "fatal: bad revision 'deadbeef'");

    const code = await git.show("deadbeef", "src/app.ts", DIRECT);

    assert.equal(code, 1);
    assert.ok(terminal.infoLines.join("\n").includes("Not shown — fatal: bad revision 'deadbeef'"));
  });

  it("refuses an unsafe revision defensively before the port is called", async () => {
    const { git, gitPort, terminal } = makeGit();

    const code = await git.show("$(rm -rf /)", "src/app.ts", DIRECT);

    assert.equal(code, 1);
    assert.equal(gitPort.lastShowRev, "", "the Git port must never see an unsafe revision");
    assert.ok(terminal.infoLines.join("\n").includes("Refused"));
  });
});