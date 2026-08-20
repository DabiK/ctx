/**
 * Integration tests: discovery operations (tree, glob, inspect, search)
 * against a real temporary Git repository, real filesystem, and real Git.
 * Search uses the real ripgrep backend when available and is skipped
 * otherwise; the clipboard is always fake.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { RESPONSE_MARKER } from "../branding.js";
import { DiscoveryUseCase } from "../application/discovery.js";
import { RequestUseCase } from "../application/request.js";
import { SystemEnv } from "../platform/env.js";
import { SystemFs } from "../platform/fs.js";
import { SystemGit } from "../platform/git.js";
import { createSearchPort } from "../platform/search.js";
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

function rgAvailable(): boolean {
  try {
    execFileSync("rg", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("integration: project discovery and search", () => {
  let dir: string;
  let fs: RepoFs;
  let git: SystemGit;
  let clipboard: FakeClipboard;
  let terminal: FakeTerminal;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ctx-discovery-"));
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

  function discovery(): DiscoveryUseCase {
    return new DiscoveryUseCase(clipboard, terminal, git, fs);
  }

  it("walks a bounded tree over a real repository", async () => {
    seed("src/app.ts", "one\ntwo\n");
    seed("src/lib/util.ts", "util\n");
    seed("dist/bundle.js", "bundled\n");
    seed(".ctxignore", "dist/\n");

    const code = await discovery().tree(null, {
      copy: true,
      allowSensitive: false,
      protocol: false,
    });

    assert.equal(code, 0);
    const copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.startsWith(RESPONSE_MARKER));
    assert.ok(copied.includes("src/"));
    assert.ok(copied.includes("  app.ts"));
    assert.ok(copied.includes("    util.ts"));
    assert.ok(!copied.includes("bundle.js"), "ignored dist/ pruned");
  });

  it("globs and inspects a real repository", async () => {
    seed("src/app.ts", "app\n");
    seed("README.md", "# demo\n");
    seed("package.json", JSON.stringify({ name: "demo", version: "1.0.0" }));

    const globCode = await discovery().glob("**/*.ts", {
      copy: false,
      allowSensitive: false,
      protocol: false,
    });
    assert.equal(globCode, 0);
    assert.ok(terminal.infoLines.join("\n").includes("- src/app.ts"));

    const inspectCode = await discovery().inspect(null, {
      copy: false,
      allowSensitive: false,
      protocol: false,
    });
    assert.equal(inspectCode, 0);
    const out = terminal.infoLines.join("\n");
    assert.ok(out.includes("name: demo"));
    assert.ok(out.includes("- README.md"));
  });

  it("searches with the real ripgrep backend through the clipboard", async (t) => {
    if (!rgAvailable()) {
      t.skip("ripgrep is not installed on this host");
      return;
    }
    seed("src/app.ts", "alpha\nbeta\nTODO fix me\n");
    seed("src/other.ts", "nothing here\n");
    const search = createSearchPort(new SystemEnv());
    clipboard.content = "@ctx search TODO";

    const code = await new RequestUseCase(clipboard, terminal, git, fs, search).read({
      allowSensitive: false,
    });

    assert.equal(code, 0);
    const copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.includes("## Search \"TODO\" (ripgrep)"));
    assert.ok(copied.includes("- src/app.ts:3 | TODO fix me"));
  });

  it("uses a fake search backend for the non-rg request path", async () => {
    seed("src/app.ts", "alpha\n");
    const search = new FakeSearch();
    search.matches = [{ relPath: "src/app.ts", line: 1, content: "alpha" }];
    clipboard.content = "@ctx search alpha";

    const code = await new RequestUseCase(clipboard, terminal, git, fs, search).read({
      allowSensitive: false,
    });

    assert.equal(code, 0);
    assert.ok((clipboard.lastCopied() ?? "").includes("- src/app.ts:1 | alpha"));
  });

  it("tree and glob with --copy never disclose a directory symlink escaping the root", async () => {
    const outside = mkdtempSync(join(tmpdir(), "ctx-outside-"));
    try {
      seed("src/app.ts", "app\n");
      writeFileSync(join(outside, "hosts"), "127.0.0.1 localhost\n", "utf8");
      symlinkSync(outside, join(dir, "etc-link"));

      const treeCode = await discovery().tree(null, {
        copy: true,
        allowSensitive: false,
        protocol: false,
      });
      assert.equal(treeCode, 0);
      const treeCopied = clipboard.lastCopied() ?? "";
      assert.ok(!treeCopied.includes("etc-link"), "escaping symlink pruned from tree");
      assert.ok(!treeCopied.includes("hosts"), "external directory contents not disclosed");
      assert.ok(treeCopied.includes("app.ts"), "in-repo entries still copied");

      const globCode = await discovery().glob("**/*", {
        copy: true,
        allowSensitive: false,
        protocol: false,
      });
      assert.equal(globCode, 0);
      const globCopied = clipboard.lastCopied() ?? "";
      assert.ok(!globCopied.includes("etc-link"));
      assert.ok(!globCopied.includes("hosts"));
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("@ctx tree and @ctx glob requests skip directory symlinks escaping the root", async () => {
    const outside = mkdtempSync(join(tmpdir(), "ctx-outside-"));
    try {
      seed("src/app.ts", "app\n");
      writeFileSync(join(outside, "hosts"), "127.0.0.1 localhost\n", "utf8");
      symlinkSync(outside, join(dir, "etc-link"));

      clipboard.content = "@ctx tree";
      const treeCode = await new RequestUseCase(clipboard, terminal, git, fs, new FakeSearch()).read({
        allowSensitive: false,
      });
      assert.equal(treeCode, 0);
      const treeCopied = clipboard.lastCopied() ?? "";
      assert.ok(!treeCopied.includes("etc-link"));
      assert.ok(!treeCopied.includes("hosts"));
      assert.ok(treeCopied.includes("src/"));

      clipboard.content = "@ctx glob **/*";
      const globCode = await new RequestUseCase(clipboard, terminal, git, fs, new FakeSearch()).read({
        allowSensitive: false,
      });
      assert.equal(globCode, 0);
      const globCopied = clipboard.lastCopied() ?? "";
      assert.ok(!globCopied.includes("etc-link"));
      assert.ok(!globCopied.includes("hosts"));
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
