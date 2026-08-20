/**
 * Integration tests: Git context operations (status, changed, diff, log,
 * show) against a real temporary Git repository, real filesystem, and real
 * Git. The clipboard is always fake.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { RESPONSE_MARKER } from "../branding.js";
import { GitUseCase } from "../application/git.js";
import { RequestUseCase } from "../application/request.js";
import { SystemFs } from "../platform/fs.js";
import { SystemGit } from "../platform/git.js";
import { FakeClipboard, FakeSearch, FakeTerminal } from "./fakes.js";

/** Real SystemFs pinned to a directory so git root discovery targets the repo. */
class RepoFs extends SystemFs {
  constructor(private readonly dir: string) {
    super();
  }
  cwd(): string {
    return this.dir;
  }
}

describe("integration: Git context operations", () => {
  let dir: string;
  let fs: RepoFs;
  let git: SystemGit;
  let clipboard: FakeClipboard;
  let terminal: FakeTerminal;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ctx-git-"));
    fs = new RepoFs(dir);
    git = new SystemGit();
    clipboard = new FakeClipboard();
    terminal = new FakeTerminal();

    execFileSync("git", ["init", "-q", dir]);
    execFileSync("git", ["-C", dir, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", dir, "config", "user.name", "ctx test"]);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function seed(relPath: string, content: string): void {
    const abs = join(dir, relPath);
    mkdirSync(join(dir, relPath.split("/").slice(0, -1).join("/")), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }

  function gitCmd(...args: string[]): void {
    execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  }

  function commit(message: string): void {
    gitCmd("add", "-A");
    gitCmd("commit", "-q", "-m", message);
  }

  function ops(): GitUseCase {
    return new GitUseCase(clipboard, terminal, git, fs);
  }

  it("status distinguishes staged, modified, untracked, and deleted files", async () => {
    seed("src/app.ts", "one\n");
    seed("src/lib/util.ts", "util\n");
    commit("initial");
    seed("src/app.ts", "one\nchanged\n"); // unstaged modification
    seed("src/new.ts", "new\n");
    gitCmd("add", "src/new.ts"); // staged add
    seed("notes.md", "note\n"); // untracked
    gitCmd("rm", "-q", "src/lib/util.ts"); // tracked file removed

    const code = await ops().status({ copy: true, allowSensitive: false, protocol: false });

    assert.equal(code, 0);
    const copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.includes("## Status"));
    assert.ok(copied.includes("Branch: main"));
    assert.ok(copied.includes("- src/app.ts"), "modified file listed");
    assert.ok(copied.includes("Staged: 1"));
    assert.ok(copied.includes("- src/new.ts"));
    assert.ok(copied.includes("Untracked: 1"));
    assert.ok(copied.includes("- notes.md"));
    assert.ok(copied.includes("Deleted: 1"));
    assert.ok(copied.includes("- src/lib/util.ts"));
  });

  it("changed lists files with their state", async () => {
    seed("a.ts", "a\n");
    commit("initial");
    seed("a.ts", "a\nchanged\n");
    seed("b.ts", "b\n");

    const code = await ops().changed(null, {
      copy: false,
      allowSensitive: false,
      protocol: false,
    });

    assert.equal(code, 0);
    const out = terminal.infoLines.join("\n");
    assert.ok(out.includes("- a.ts (modified)"));
    assert.ok(out.includes("- b.ts (untracked)"));
  });

  it("diff distinguishes working-tree, staged, and scoped content", async () => {
    seed("src/app.ts", "one\n");
    seed("src/lib/util.ts", "util\n");
    commit("initial");
    seed("src/app.ts", "one\nchanged\n"); // working-tree change
    seed("src/staged.ts", "staged\n");
    gitCmd("add", "src/staged.ts"); // staged add

    const workingCode = await ops().diff(null, false, {
      copy: true,
      allowSensitive: false,
      protocol: false,
    });
    assert.equal(workingCode, 0);
    let copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.includes("+changed"), "working-tree diff contains the change");
    assert.ok(copied.includes("src/app.ts"));

    const stagedCode = await ops().diff(null, true, {
      copy: true,
      allowSensitive: false,
      protocol: false,
    });
    assert.equal(stagedCode, 0);
    copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.includes("src/staged.ts"), "staged diff lists the staged file");
    assert.ok(!copied.includes("+changed"), "staged diff excludes worktree changes");

    const scopedCode = await ops().diff("src/app.ts", false, {
      copy: true,
      allowSensitive: false,
      protocol: false,
    });
    assert.equal(scopedCode, 0);
    copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.includes("+changed"));
    assert.ok(!copied.includes("staged.ts"), "path-scoped diff stays in the scope");
  });

  it("log is bounded and scopes to a validated path", async () => {
    seed("src/app.ts", "one\n");
    commit("first");
    seed("src/app.ts", "two\n");
    commit("second");
    seed("notes.md", "note\n");
    commit("third");

    const code = await ops().log(null, {
      copy: true,
      allowSensitive: false,
      protocol: false,
      limit: 2,
    });
    assert.equal(code, 0);
    let copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.includes("limited: yes (max 2)"));
    assert.ok(copied.includes("third"));
    assert.ok(copied.includes("second"));
    assert.ok(!copied.includes("first"), "bounded log stops at the limit");

    const scopedCode = await ops().log("src/app.ts", {
      copy: true,
      allowSensitive: false,
      protocol: false,
    });
    assert.equal(scopedCode, 0);
    copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.includes("first"));
    assert.ok(copied.includes("second"));
    assert.ok(!copied.includes("third"), "path-scoped log excludes unrelated commits");
  });

  it("show reads blob content at a revision, including deleted files", async () => {
    seed("src/app.ts", "one\n");
    seed("old.ts", "old content\n");
    commit("first");
    seed("src/app.ts", "two\n");
    gitCmd("rm", "-q", "old.ts");
    commit("second");

    const headCode = await ops().show("HEAD", "src/app.ts", {
      copy: true,
      allowSensitive: false,
      protocol: false,
    });
    assert.equal(headCode, 0);
    assert.ok((clipboard.lastCopied() ?? "").includes("two"));

    const parentCode = await ops().show("HEAD~1", "src/app.ts", {
      copy: true,
      allowSensitive: false,
      protocol: false,
    });
    assert.equal(parentCode, 0);
    assert.ok((clipboard.lastCopied() ?? "").includes("one"));

    const deletedCode = await ops().show("HEAD~1", "old.ts", {
      copy: true,
      allowSensitive: false,
      protocol: false,
    });
    assert.equal(deletedCode, 0);
    assert.ok((clipboard.lastCopied() ?? "").includes("old content"));

    const goneCode = await ops().show("HEAD", "old.ts", {
      copy: true,
      allowSensitive: false,
      protocol: false,
    });
    assert.equal(goneCode, 1);
    assert.ok((clipboard.lastCopied() ?? "").includes("Not shown"));
  });

  it("show refuses a bad revision with the Git diagnostic", async () => {
    seed("src/app.ts", "one\n");
    commit("first");

    const code = await ops().show("deadbeef", "src/app.ts", {
      copy: true,
      allowSensitive: false,
      protocol: false,
    });

    assert.equal(code, 1);
    assert.ok((clipboard.lastCopied() ?? "").includes("Not shown"));
  });

  it("handles empty states: clean status, empty diff, and no commits", async () => {
    const statusCode = await ops().status({ copy: true, allowSensitive: false, protocol: false });
    assert.equal(statusCode, 1);
    let copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.includes("Branch: main"));
    assert.ok(copied.includes("Working tree clean."));

    const diffCode = await ops().diff(null, false, {
      copy: true,
      allowSensitive: false,
      protocol: false,
    });
    assert.equal(diffCode, 1);
    copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.includes("No changes."));

    const logCode = await ops().log(null, { copy: true, allowSensitive: false, protocol: false });
    assert.equal(logCode, 1);
    copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.includes("Commits: 0"));
  });

  it("runs a Git context request through the protocol clipboard round trip", async () => {
    seed("src/app.ts", "one\n");
    commit("first");
    seed("src/app.ts", "two\n");
    clipboard.content = "@ctx status";

    const request = new RequestUseCase(clipboard, terminal, git, fs, new FakeSearch());
    const code = await request.read({ allowSensitive: false });

    assert.equal(code, 0);
    const copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.startsWith(RESPONSE_MARKER));
    assert.ok(copied.includes("## Status"));
    assert.ok(copied.includes("Modified: 1"));
    assert.ok(copied.includes("- src/app.ts"));
  });

  it("combines Git operations with reads in one protocol response", async () => {
    seed("src/app.ts", "one\n");
    commit("first");
    clipboard.content = ["@ctx status", "@ctx log --limit 1"].join("\n");

    const request = new RequestUseCase(clipboard, terminal, git, fs, new FakeSearch());
    const code = await request.read({ allowSensitive: false });

    assert.equal(code, 0);
    const copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.includes("## Status"));
    assert.ok(copied.includes("## Log (1 commits)"));
    assert.ok(copied.includes("first"));
  });

  it("refuses unsafe show requests through the protocol without running git", async () => {
    clipboard.content = "@ctx show a..b src/app.ts";

    const request = new RequestUseCase(clipboard, terminal, git, fs, new FakeSearch());
    const code = await request.read({ allowSensitive: false });

    assert.equal(code, 1);
    const copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.includes("## Request refused"));
    assert.ok(copied.includes("unsafe revision"));
  });

  it("fails with an actionable message outside a repository", async () => {
    const outside = mkdtempSync(join(tmpdir(), "ctx-outside-"));
    const outsideFs = new RepoFs(outside);
    const outsideOps = new GitUseCase(clipboard, terminal, git, outsideFs);

    const code = await outsideOps.status({ copy: false, allowSensitive: false, protocol: false });

    assert.equal(code, 1);
    assert.ok(terminal.errorLines.some((l) => l.includes("requires a Git repository")));
    rmSync(outside, { recursive: true, force: true });
  });
});