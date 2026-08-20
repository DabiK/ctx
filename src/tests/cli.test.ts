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
  });

  it("treats help as a command and supports --help", () => {
    const h = parseArgs(["help"]);
    assert.ok(!("error" in h));
    assert.equal(h.parsed.help, true);
    const d = parseArgs(["doctor", "--help"]);
    assert.ok(!("error" in d));
    assert.equal(d.parsed.help, true);
  });
});

describe("runCli", () => {
  it("prints global usage with no arguments", async () => {
    const { ports, terminal } = fakePorts();
    const code = await runCli([], ports);
    assert.equal(code, 0);
    assert.ok(terminal.infoLines.join("\n").includes("Usage:"));
  });

  it("provides help for init, prompt, doctor, file, files, and read", async () => {
    for (const cmd of ["init", "prompt", "doctor", "file", "files", "read"]) {
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
});
