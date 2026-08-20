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

  it("rejects unknown commands and options", () => {
    assert.ok("error" in parseArgs(["explode"]));
    assert.ok("error" in parseArgs(["init", "--nope"]));
    assert.ok("error" in parseArgs(["init", "extra"]));
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

  it("provides help for init, prompt, and doctor", async () => {
    for (const cmd of ["init", "prompt", "doctor"]) {
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
});
