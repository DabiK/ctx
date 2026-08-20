/**
 * Integration tests: the read/request use cases against a real temporary Git
 * repository and real filesystem (including real symlink resolution), with a
 * fake clipboard. Validates the permission boundary end to end.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { RESPONSE_MARKER } from "../branding.js";
import { ReadUseCase } from "../application/read.js";
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

describe("integration: safe clipboard file context", () => {
  let dir: string;
  let fs: RepoFs;
  let git: SystemGit;
  let clipboard: FakeClipboard;
  let terminal: FakeTerminal;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ctx-integration-"));
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

  it("executes a clipboard file request against a real repository", async () => {
    seed("src/app.ts", "one\ntwo\nthree\n");
    seed(".ctxignore", "dist/\n");
    clipboard.content = "@ctx file src/app.ts:2-3";

    const code = await new RequestUseCase(clipboard, terminal, git, fs, new FakeSearch()).read({
      allowSensitive: false,
    });

    assert.equal(code, 0);
    const copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.startsWith(RESPONSE_MARKER));
    assert.ok(copied.includes("## src/app.ts"));
    assert.ok(copied.includes("2 | two"));
    assert.ok(copied.includes("3 | three"));
  });

  it("prints direct reads to the terminal and copies only with --copy", async () => {
    seed("src/app.ts", "hello\n");
    const useCase = new ReadUseCase(clipboard, terminal, git, fs);

    const code = await useCase.file("src/app.ts", {
      copy: false,
      allowSensitive: false,
      protocol: false,
    });

    assert.equal(code, 0);
    assert.ok(terminal.infoLines.join("\n").includes("1 | hello"));
    assert.equal(clipboard.lastCopied(), null);

    await useCase.file("src/app.ts", {
      copy: true,
      allowSensitive: false,
      protocol: false,
    });
    assert.ok((clipboard.lastCopied() ?? "").includes(RESPONSE_MARKER));
  });

  it("refuses a symlink escaping the repository root", async () => {
    const outside = mkdtempSync(join(tmpdir(), "ctx-outside-"));
    try {
      writeFileSync(join(outside, "secret.ts"), "outside\n", "utf8");
      symlinkSync(join(outside, "secret.ts"), join(dir, "escape.ts"));

      const useCase = new ReadUseCase(clipboard, terminal, git, fs);
      const code = await useCase.file("escape.ts", {
        copy: true,
        allowSensitive: false,
        protocol: false,
      });

      assert.equal(code, 1);
      const copied = clipboard.lastCopied() ?? "";
      assert.ok(copied.includes("outside the allowed roots"));
      assert.ok(!copied.includes("outside\n"));
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("honours .ctxignore and configured sensitive paths against a real repo", async () => {
    seed("dist/bundle.js", "bundled\n");
    seed("creds.json", '{"password":"x"}\n');
    seed(".ctxignore", "dist/\n");
    seed(".ctx.toml", 'sensitive_paths = ["creds.json"]\n');
    clipboard.content = "@ctx files dist/bundle.js creds.json src/missing.ts";

    const code = await new RequestUseCase(clipboard, terminal, git, fs, new FakeSearch()).read({
      allowSensitive: false,
    });

    assert.equal(code, 1, "nothing readable exits non-zero");
    const copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.includes("excluded by .ctxignore"));
    assert.ok(copied.includes("sensitive path"));
    assert.ok(copied.includes("not found"));
    assert.ok(!copied.includes("bundled"));
    assert.ok(!copied.includes('"password"'));
  });
});