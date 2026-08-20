/**
 * CLI tests: argument parsing, help output, and dispatch through runCli with
 * fake ports.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CONFIG_FILE_NAME, IGNORE_FILE_NAME, RESPONSE_MARKER } from "../branding.js";
import { parseArgs, runCli } from "../cli.js";
import { fakePorts } from "./fakes.js";

describe("parseArgs", () => {
  it("accepts a bare command", () => {
    const r = parseArgs(["init"]);
    assert.ok(!("error" in r));
    assert.deepEqual(r.parsed, {
      command: "init",
      help: false,
      version: false,
      force: false,
      compact: false,
      copy: false,
      allowSensitive: false,
      staged: false,
      depth: null,
      limit: null,
      args: [],
    });
  });

  it("accepts command options", () => {
    const r = parseArgs(["init", "--force"]);
    assert.ok(!("error" in r));
    assert.equal(r.parsed.command, "init");
    assert.equal(r.parsed.force, true);

    const p = parseArgs(["prompt", "--compact"]);
    assert.ok(!("error" in p));
    assert.equal(p.parsed.command, "prompt");
    assert.equal(p.parsed.compact, true);
  });

  it("parses file/files commands with paths and read options", () => {
    const f = parseArgs(["file", "src/foo.ts:10-20", "--copy", "--allow-sensitive"]);
    assert.ok(!("error" in f));
    assert.equal(f.parsed.command, "file");
    assert.deepEqual(f.parsed.args, ["src/foo.ts:10-20"]);
    assert.equal(f.parsed.copy, true);
    assert.equal(f.parsed.allowSensitive, true);

    const fs2 = parseArgs(["files", "a.ts", "b.ts", "-c"]);
    assert.ok(!("error" in fs2));
    assert.equal(fs2.parsed.command, "files");
    assert.deepEqual(fs2.parsed.args, ["a.ts", "b.ts"]);
    assert.equal(fs2.parsed.copy, true);

    const r = parseArgs(["read"]);
    assert.ok(!("error" in r));
    assert.equal(r.parsed.command, "read");
  });

  it("rejects unknown commands, options, and wrong path counts", () => {
    assert.ok("error" in parseArgs(["explode"]));
    assert.ok("error" in parseArgs(["init", "--nope"]));
    assert.ok("error" in parseArgs(["init", "extra"]));
    assert.ok("error" in parseArgs(["file"]));
    assert.ok("error" in parseArgs(["file", "a.ts", "b.ts"]));
    assert.ok("error" in parseArgs(["files"]));
    assert.ok("error" in parseArgs(["read", "extra"]));
    assert.ok("error" in parseArgs(["glob"]));
    assert.ok("error" in parseArgs(["glob", "a", "b"]));
    assert.ok("error" in parseArgs(["inspect", "a", "b"]));
    assert.ok("error" in parseArgs(["search"]));
    assert.ok("error" in parseArgs(["tree", "extra"]));
  });

  it("parses discovery commands and --depth/--limit options", () => {
    const t = parseArgs(["tree", "--depth", "5", "--copy"]);
    assert.ok(!("error" in t));
    assert.equal(t.parsed.command, "tree");
    assert.equal(t.parsed.depth, 5);
    assert.equal(t.parsed.copy, true);

    const g = parseArgs(["glob", "src/*.ts", "--limit", "20"]);
    assert.ok(!("error" in g));
    assert.equal(g.parsed.command, "glob");
    assert.equal(g.parsed.limit, 20);
    assert.deepEqual(g.parsed.args, ["src/*.ts"]);

    const i = parseArgs(["inspect", "docs"]);
    assert.ok(!("error" in i));
    assert.equal(i.parsed.command, "inspect");
    assert.deepEqual(i.parsed.args, ["docs"]);

    const s = parseArgs(["search", "TODO", "fix"]);
    assert.ok(!("error" in s));
    assert.equal(s.parsed.command, "search");
    assert.deepEqual(s.parsed.args, ["TODO", "fix"]);

    assert.ok("error" in parseArgs(["tree", "--depth", "0"]));
    assert.ok("error" in parseArgs(["tree", "--depth", "11"]));
    assert.ok("error" in parseArgs(["glob", "--limit", "2000"]));
    assert.ok("error" in parseArgs(["tree", "--limit"]));
  });

  it("treats help as a command and supports --help", () => {
    const h = parseArgs(["help"]);
    assert.ok(!("error" in h));
    assert.equal(h.parsed.help, true);
    const d = parseArgs(["doctor", "--help"]);
    assert.ok(!("error" in d));
    assert.equal(d.parsed.help, true);
  });

  it("parses the Git context commands and their options", () => {
    const status = parseArgs(["status", "--copy"]);
    assert.ok(!("error" in status));
    assert.equal(status.parsed.command, "status");
    assert.equal(status.parsed.copy, true);

    const changed = parseArgs(["changed", "src/lib"]);
    assert.ok(!("error" in changed));
    assert.equal(changed.parsed.command, "changed");
    assert.deepEqual(changed.parsed.args, ["src/lib"]);

    const diff = parseArgs(["diff", "--staged", "src/app.ts", "--copy"]);
    assert.ok(!("error" in diff));
    assert.equal(diff.parsed.command, "diff");
    assert.equal(diff.parsed.staged, true);
    assert.deepEqual(diff.parsed.args, ["src/app.ts"]);

    const log = parseArgs(["log", "--limit", "7"]);
    assert.ok(!("error" in log));
    assert.equal(log.parsed.command, "log");
    assert.equal(log.parsed.limit, 7);

    const show = parseArgs(["show", "HEAD~2", "src/app.ts"]);
    assert.ok(!("error" in show));
    assert.equal(show.parsed.command, "show");
    assert.deepEqual(show.parsed.args, ["HEAD~2", "src/app.ts"]);

    assert.ok("error" in parseArgs(["status", "extra"]));
    assert.ok("error" in parseArgs(["changed", "a", "b"]));
    assert.ok("error" in parseArgs(["diff", "a", "b"]));
    assert.ok("error" in parseArgs(["log", "--limit", "0"]));
    assert.ok("error" in parseArgs(["log", "a", "b"]));
    assert.ok("error" in parseArgs(["show"]));
    assert.ok("error" in parseArgs(["show", "HEAD"]));
    assert.ok("error" in parseArgs(["show", "HEAD", "a", "b"]));
    assert.ok("error" in parseArgs(["show", "$(rm -rf /)", "src/app.ts"]));
    assert.ok("error" in parseArgs(["show", "HEAD", "/etc/passwd"]));
  });
});

describe("runCli", () => {
  it("prints global usage with no arguments", async () => {
    const { ports, terminal } = fakePorts();
    const code = await runCli([], ports);
    assert.equal(code, 0);
    assert.ok(terminal.infoLines.join("\n").includes("Usage:"));
  });

  it("provides help for init, prompt, doctor, file, files, read, tree, glob, inspect, search, status, changed, diff, log, and show", async () => {
    for (const cmd of [
      "init",
      "prompt",
      "doctor",
      "file",
      "files",
      "read",
      "tree",
      "glob",
      "inspect",
      "search",
      "status",
      "changed",
      "diff",
      "log",
      "show",
    ]) {
      const { ports, terminal } = fakePorts();
      const code = await runCli([cmd, "--help"], ports);
      assert.equal(code, 0);
      assert.ok(
        terminal.infoLines.join("\n").includes(`Usage:`),
        `help for ${cmd}`,
      );
    }
  });

  it("prints the version", async () => {
    const { ports, terminal } = fakePorts();
    const code = await runCli(["--version"], ports);
    assert.equal(code, 0);
    assert.ok((terminal.infoLines[0] ?? "").includes("0.1.0"));
  });

  it("returns usage error code for unknown commands", async () => {
    const { ports, terminal } = fakePorts();
    const code = await runCli(["frobnicate"], ports);
    assert.equal(code, 2);
    assert.ok(terminal.errorLines.some((l) => l.includes("Unknown command")));
  });

  it("runs init end-to-end through the CLI with fake ports", async () => {
    const { ports, clipboard, fs } = fakePorts();
    fs.seed("/repo/AGENTS.md", "# Project notes\n");

    const code = await runCli(["init"], ports);

    assert.equal(code, 0);
    assert.ok(fs.exists(`/repo/${CONFIG_FILE_NAME}`));
    assert.ok(fs.exists(`/repo/${IGNORE_FILE_NAME}`));
    assert.ok((clipboard.lastCopied() ?? "").includes(RESPONSE_MARKER));
  });

  it("runs prompt --compact through the CLI", async () => {
    const { ports, clipboard } = fakePorts();

    const code = await runCli(["prompt", "--compact"], ports);

    assert.equal(code, 0);
    assert.ok((clipboard.lastCopied() ?? "").includes(RESPONSE_MARKER));
  });

  it("runs doctor through the CLI and reports readiness", async () => {
    const { ports, terminal } = fakePorts();

    const code = await runCli(["doctor"], ports);

    assert.equal(code, 0);
    assert.ok(terminal.infoLines.join("\n").includes("all checks passed"));
  });

  it("runs file through the CLI: prints content, copies only with --copy", async () => {
    const { ports, terminal, clipboard, fs } = fakePorts();
    fs.seed("/repo/src/app.ts", "line one\nline two\nline three\n");

    const code = await runCli(["file", "src/app.ts:2-3"], ports);

    assert.equal(code, 0);
    assert.ok(terminal.infoLines.join("\n").includes("line two"));
    assert.ok(terminal.infoLines.join("\n").includes("read 2-3 of 3 lines"));
    assert.equal(clipboard.lastCopied(), null, "no copy without --copy");

    const code2 = await runCli(["file", "src/app.ts", "--copy"], ports);
    assert.equal(code2, 0);
    assert.ok((clipboard.lastCopied() ?? "").includes(RESPONSE_MARKER));
  });

  it("runs files through the CLI and refuses when nothing is readable", async () => {
    const { ports, terminal } = fakePorts();

    const code = await runCli(["files", "missing.ts"], ports);

    assert.equal(code, 1);
    assert.ok(terminal.errorLines.join("\n").includes("missing.ts"));
  });

  it("runs read through the CLI: clipboard request to copied response", async () => {
    const { ports, clipboard, fs } = fakePorts();
    fs.seed("/repo/src/app.ts", "hello ctx\n");
    clipboard.content = "@ctx file src/app.ts";

    const code = await runCli(["read"], ports);

    assert.equal(code, 0);
    assert.ok((clipboard.lastCopied() ?? "").includes(RESPONSE_MARKER));
    assert.ok((clipboard.lastCopied() ?? "").includes("hello ctx"));
  });

  it("runs tree, glob, and inspect through the CLI", async () => {
    const { ports, terminal, clipboard, fs } = fakePorts();
    fs.seed("/repo/src/app.ts", "app\n");
    fs.seed("/repo/docs/guide.md", "guide\n");
    fs.seed("/repo/package.json", JSON.stringify({ name: "demo", version: "1.0.0" }));

    const treeCode = await runCli(["tree", "--depth", "2"], ports);
    assert.equal(treeCode, 0);
    assert.ok(terminal.infoLines.join("\n").includes("src/"));
    assert.ok(terminal.infoLines.join("\n").includes("app.ts"));
    assert.equal(clipboard.lastCopied(), null, "no copy without --copy");

    const globCode = await runCli(["glob", "**/*.md"], ports);
    assert.equal(globCode, 0);
    assert.ok(terminal.infoLines.join("\n").includes("- docs/guide.md"));

    const inspectCode = await runCli(["inspect"], ports);
    assert.equal(inspectCode, 0);
    assert.ok(terminal.infoLines.join("\n").includes("name: demo"));

    await runCli(["tree", "--copy"], ports);
    assert.ok((clipboard.lastCopied() ?? "").includes(RESPONSE_MARKER));
  });

  it("runs search through the CLI with a fake search backend", async () => {
    const { ports, terminal, clipboard, fs, search } = fakePorts();
    fs.seed("/repo/src/app.ts", "alpha\n");
    search.matches = [{ relPath: "src/app.ts", line: 1, content: "alpha" }];

    const code = await runCli(["search", "alpha", "--copy"], ports);

    assert.equal(code, 0);
    assert.ok(terminal.infoLines.join("\n").includes("- src/app.ts:1 | alpha"));
    assert.ok((clipboard.lastCopied() ?? "").includes(RESPONSE_MARKER));
  });

  it("runs a combined discovery request through the CLI read command", async () => {
    const { ports, clipboard, fs, search } = fakePorts();
    fs.seed("/repo/src/app.ts", "alpha\n");
    search.matches = [{ relPath: "src/app.ts", line: 1, content: "alpha" }];
    clipboard.content = ["@ctx tree --depth 1", "@ctx search alpha"].join("\n");

    const code = await runCli(["read"], ports);

    assert.equal(code, 0);
    const copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.includes("## Tree (depth 1"));
    assert.ok(copied.includes("## Search \"alpha\" (fake)"));
  });

  it("runs a @ctx batch request through the CLI read command", async () => {
    const { ports, clipboard, fs, search } = fakePorts();
    fs.seed("/repo/src/app.ts", "alpha\n");
    search.matches = [{ relPath: "src/app.ts", line: 1, content: "alpha" }];
    clipboard.content = [
      "@ctx batch",
      "@ctx file src/app.ts:1-1",
      "@ctx search alpha",
    ].join("\n");

    const code = await runCli(["read"], ports);

    assert.equal(code, 0);
    const copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.includes("## Batch response"));
    assert.ok(copied.includes("## file src/app.ts:1-1"));
    assert.ok(copied.includes("## Search \"alpha\" (fake)"));
  });

  it("runs status and changed through the CLI with fake Git data", async () => {
    const { ports, terminal, clipboard, git, fs } = fakePorts();
    git.statusFiles = [
      { relPath: "src/app.ts", state: "staged" },
      { relPath: "notes.md", state: "untracked" },
    ];
    fs.seed("/repo/src/app.ts", "app\n");

    const statusCode = await runCli(["status"], ports);
    assert.equal(statusCode, 0);
    assert.ok(terminal.infoLines.join("\n").includes("Branch: main"));
    assert.equal(clipboard.lastCopied(), null, "no copy without --copy");

    const changedCode = await runCli(["changed", "src", "--copy"], ports);
    assert.equal(changedCode, 0);
    assert.ok(terminal.infoLines.join("\n").includes("- src/app.ts (staged)"));
    assert.ok((clipboard.lastCopied() ?? "").includes(RESPONSE_MARKER));
  });

  it("runs diff, log, and show through the CLI with fake Git data", async () => {
    const { ports, terminal, git, fs } = fakePorts();
    fs.seed("/repo/src/app.ts", "app\n");
    git.diffText = "+new\n-old\n";
    git.diffFiles = 1;
    git.diffInsertions = 1;
    git.diffDeletions = 1;
    git.logEntries = [{ shortHash: "8f3a9b1", date: "2026-08-20", subject: "Add git context" }];
    git.showContents.set("HEAD:src/app.ts", "content at HEAD\n");

    const diffCode = await runCli(["diff", "--staged", "src/app.ts"], ports);
    assert.equal(diffCode, 0);
    assert.equal(git.lastDiffStaged, true);
    assert.ok(terminal.infoLines.join("\n").includes("+new"));

    const logCode = await runCli(["log", "--limit", "3"], ports);
    assert.equal(logCode, 0);
    assert.equal(git.lastLogLimit, 3);
    assert.ok(terminal.infoLines.join("\n").includes("8f3a9b1 2026-08-20 Add git context"));

    const showCode = await runCli(["show", "HEAD", "src/app.ts"], ports);
    assert.equal(showCode, 0);
    assert.ok(terminal.infoLines.join("\n").includes("content at HEAD"));
  });

  it("runs a combined Git context request through the CLI read command", async () => {
    const { ports, clipboard, git, fs } = fakePorts();
    fs.seed("/repo/src/app.ts", "app\n");
    git.statusFiles = [{ relPath: "src/app.ts", state: "staged" }];
    git.diffFiles = 1;
    git.diffText = "+alpha\n";
    clipboard.content = ["@ctx status", "@ctx diff --staged src/app.ts"].join("\n");

    const code = await runCli(["read"], ports);

    assert.equal(code, 0);
    const copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.includes("## Status"));
    assert.ok(copied.includes("- src/app.ts"));
    assert.ok(copied.includes("## Diff src/app.ts (staged)"));
  });
});
