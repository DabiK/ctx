/**
 * Integration tests: controlled writes (@ctx patch, @ctx write, @ctx
 * sequence, and `ctx apply`) against a real temporary Git repository, real
 * filesystem, and real Git. The clipboard is always fake; the write happens
 * in a throwaway repository that is deleted after every test.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { RESPONSE_MARKER } from "../branding.js";
import { RequestUseCase } from "../application/request.js";
import { WriteUseCase } from "../application/write.js";
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

describe("integration: controlled writes", () => {
  let dir: string;
  let fs: RepoFs;
  let git: SystemGit;
  let clipboard: FakeClipboard;
  let terminal: FakeTerminal;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ctx-write-"));
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

  function read(relPath: string): string {
    return readFileSync(join(dir, relPath), "utf8");
  }

  function gitCmd(...args: string[]): void {
    execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  }

  function commit(message: string): void {
    gitCmd("add", "-A");
    gitCmd("commit", "-q", "-m", message);
  }

  /** A real `git diff` patch against the committed tree, with the working
   * tree reset to that baseline afterwards so the patch applies cleanly.
   * New files must be staged with `git add -N` first so `git diff` includes
   * them; the reset drops the intent-to-add entries again. */
  function workingTreePatch(): string {
    const patch = execFileSync("git", ["-C", dir, "diff"], { encoding: "utf8" });
    gitCmd("checkout", "--", ".");
    gitCmd("reset", "-q");
    gitCmd("clean", "-fd");
    return patch;
  }

  function writes(): WriteUseCase {
    return new WriteUseCase(clipboard, terminal, git, fs, new FakeSearch());
  }

  function request(): RequestUseCase {
    return new RequestUseCase(clipboard, terminal, git, fs, new FakeSearch());
  }

  it("preflights a tagged multi-file patch without changing files (ctx read)", async () => {
    seed("src/a.ts", "one\n");
    seed("src/b.ts", "old\n");
    commit("initial");
    // Uncommitted changes become the patch proposal; the working tree is
    // reset to the baseline so the patch applies cleanly.
    seed("src/a.ts", "one\nchanged\n");
    seed("src/b.ts", "new content\n");
    const patch = workingTreePatch();
    clipboard.content = ["@ctx patch", "```diff", patch, "```"].join("\n");

    const code = await request().read({ allowSensitive: false });

    assert.equal(code, 0);
    const copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.includes("## Patch proposal — ready to apply"));
    assert.ok(copied.includes("- src/a.ts (modified)"));
    assert.ok(copied.includes("- src/b.ts (modified)"));
    assert.ok(copied.includes("Preflight: passed (git apply --check)"));
    assert.equal(read("src/a.ts"), "one\n", "read path never changes files");
    assert.equal(read("src/b.ts"), "old\n");
    assert.ok(!copied.includes("No files changed"), "the preview is not a refusal");
  });

  it("applies a real multi-file patch via ctx apply and git becomes the recovery path", async () => {
    seed("src/a.ts", "one\n");
    seed("src/b.ts", "old\n");
    commit("initial");
    seed("src/a.ts", "one\nchanged\n");
    seed("src/b.ts", "new content\n");
    const patch = workingTreePatch();
    clipboard.content = ["@ctx patch", "```diff", patch, "```"].join("\n");

    const code = await writes().apply({ allowSensitive: false });

    assert.equal(code, 0);
    const copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.includes("## Patch applied"));
    assert.ok(copied.includes("- src/a.ts (modified)"));
    assert.ok(copied.includes("- src/b.ts (modified)"));
    assert.equal(read("src/a.ts"), "one\nchanged\n");
    assert.equal(read("src/b.ts"), "new content\n");
    // Git is the recovery: the applied state is a normal working-tree change.
    const status = execFileSync("git", ["-C", dir, "status", "--porcelain"], { encoding: "utf8" });
    assert.ok(status.includes("M src/a.ts"));
    assert.ok(status.includes("M src/b.ts"));
  });

  it("refuses a patch that would not apply and changes no files", async () => {
    seed("src/a.ts", "one\n");
    commit("initial");
    const bogus = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "-nonexistent context",
      "+replacement",
    ].join("\n");
    clipboard.content = ["@ctx patch", bogus].join("\n");

    const code = await writes().apply({ allowSensitive: false });

    assert.equal(code, 1);
    const copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.includes("## Patch proposal — refused"));
    assert.ok(copied.includes("Preflight failed (git apply --check)"));
    assert.equal(read("src/a.ts"), "one\n", "no file changed");
    const status = execFileSync("git", ["-C", dir, "status", "--porcelain"], { encoding: "utf8" });
    assert.ok(!status.includes("M src/a.ts"));
  });

  it("creates a new file via a patch and refuses writing to sensitive paths", async () => {
    seed("src/a.ts", "one\n");
    commit("initial");
    // Create a new file (intent-to-add so git diff includes it), capture the
    // patch, and reset the tree so the patch applies cleanly.
    seed("src/new.ts", "fresh\n");
    gitCmd("add", "-N", "src/new.ts");
    const patch = workingTreePatch();
    assert.ok(patch.includes("new file"), "fixture patch adds a file");
    assert.ok(!existsSync(join(dir, "src/new.ts")), "fixture reset removed the new file");
    clipboard.content = ["@ctx patch", "```diff", patch, "```"].join("\n");

    const code = await writes().apply({ allowSensitive: false });

    assert.equal(code, 0);
    assert.equal(read("src/new.ts"), "fresh\n");

    // A patch targeting .env is refused and changes nothing.
    seed(".env", "SECRET=1\n");
    gitCmd("add", "-A");
    gitCmd("commit", "-q", "-m", "with env");
    seed(".env", "SECRET=2\n");
    const envPatch = workingTreePatch();
    clipboard.content = ["@ctx patch", "```diff", envPatch, "```"].join("\n");

    const refused = await writes().apply({ allowSensitive: false });
    assert.equal(refused, 1);
    const refusedCopied = clipboard.lastCopied() ?? "";
    assert.ok(refusedCopied.includes(".env — sensitive path"));
    assert.equal(read(".env"), "SECRET=1\n", "the baseline stays untouched");
  });

  it("creates a full-file write with missing parent directories", async () => {
    clipboard.content = [
      "@ctx write packages/lib/index.ts",
      "```ts",
      "export const ready = true;",
      "```",
    ].join("\n");

    const code = await writes().apply({ allowSensitive: false });

    assert.equal(code, 0);
    const copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.includes("## Write applied"));
    assert.ok(copied.includes("- packages/lib/index.ts (full write"));
    assert.equal(read("packages/lib/index.ts"), "export const ready = true;");
  });

  it("refuses a full write to a sensitive path and to a traversal path", async () => {
    seed(".env", "SECRET=1\n");
    clipboard.content = ["@ctx write .env", "```", "SECRET=2", "```"].join("\n");
    const sensitive = await writes().apply({ allowSensitive: false });
    assert.equal(sensitive, 1);
    assert.ok((clipboard.lastCopied() ?? "").includes("sensitive path"));
    assert.equal(read(".env"), "SECRET=1\n", "no file changed");

    clipboard.content = ["@ctx write ../outside.txt", "```", "x", "```"].join("\n");
    const traversal = await writes().apply({ allowSensitive: false });
    assert.equal(traversal, 1);
    assert.ok((clipboard.lastCopied() ?? "").includes("unsafe write path"));
    assert.ok(!existsSync(join(dir, "..", "outside.txt")));
  });

  it("runs sequence verification reads only after a real write succeeds", async () => {
    seed("src/app.ts", "alpha\n");
    commit("initial");
    seed("src/app.ts", "alpha\nchanged\n");
    const patch = workingTreePatch();
    clipboard.content = [
      "@ctx sequence",
      "@ctx patch",
      "```diff",
      patch,
      "```",
      "@ctx file src/app.ts:2",
      "@ctx status",
    ].join("\n");

    const code = await writes().apply({ allowSensitive: false });

    assert.equal(code, 0);
    const copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.includes("## Sequence — write applied"));
    assert.ok(copied.includes("## Verification: file src/app.ts:2"));
    assert.ok(copied.includes("2 | changed"), "verification read shows the written file");
    assert.ok(copied.includes("## Verification: Status"));
    assert.ok(copied.includes("- src/app.ts (modified)"), "status sees the applied change");
  });

  it("skips verification reads when the sequence write is refused", async () => {
    seed(".env", "SECRET=1\n");
    seed("src/app.ts", "alpha\n");
    clipboard.content = [
      "@ctx sequence",
      "@ctx write .env",
      "```",
      "SECRET=2",
      "```",
      "@ctx file src/app.ts",
      "@ctx status",
    ].join("\n");

    const code = await writes().apply({ allowSensitive: false });

    assert.equal(code, 1);
    const copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.includes("## Sequence proposal — refused"));
    assert.ok(copied.includes("Verification reads were skipped — the write did not succeed."));
    assert.ok(!copied.includes("## Verification"), "no verification section ran");
    assert.equal(read(".env"), "SECRET=1\n");
  });

  it("previews a sequence through ctx read without changing anything", async () => {
    seed("src/app.ts", "alpha\n");
    clipboard.content = [
      "@ctx sequence",
      "@ctx write src/app.ts",
      "```",
      "alpha\nchanged",
      "```",
      "@ctx file src/app.ts",
    ].join("\n");

    const code = await request().read({ allowSensitive: false });

    assert.equal(code, 0);
    const copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.includes("## Sequence proposal — ready to apply"));
    assert.ok(copied.includes("Verification: 1 read operation(s)"));
    assert.equal(read("src/app.ts"), "alpha\n", "read path never changes files");
  });

  it("fails with an actionable message outside a repository", async () => {
    const outside = mkdtempSync(join(tmpdir(), "ctx-write-outside-"));
    const outsideFs = new RepoFs(outside);
    const outsideWrites = new WriteUseCase(clipboard, terminal, git, outsideFs, new FakeSearch());
    clipboard.content = "@ctx write x.ts";

    const code = await outsideWrites.apply({ allowSensitive: false });

    assert.equal(code, 1);
    assert.ok(terminal.errorLines.some((l) => l.includes("requires a Git repository")));
    assert.ok(clipboard.lastCopied() === null, "nothing copied without a repository");
    rmSync(outside, { recursive: true, force: true });
  });
});