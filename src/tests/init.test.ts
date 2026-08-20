/**
 * Unit tests for the `ctx init` application use case.
 * All tests use fake platform ports — never a real clipboard.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CONFIG_FILE_NAME,
  IGNORE_FILE_NAME,
  RESPONSE_MARKER,
} from "../branding.js";
import { InitUseCase } from "../application/init.js";
import { fakePorts } from "./fakes.js";

const AGENTS_CONTENT = "# Team conventions\n- Always run tests.\n";

function useCase(ports: ReturnType<typeof fakePorts>["ports"]): InitUseCase {
  const { clipboard, terminal, git, fs } = ports;
  return new InitUseCase(clipboard, terminal, git, fs);
}

describe("InitUseCase.init", () => {
  it("creates missing config and ignore files and copies the prompt with AGENTS.md", async () => {
    const { ports, clipboard, fs } = fakePorts();
    fs.seed("/repo/AGENTS.md", AGENTS_CONTENT);

    const code = await useCase(ports).init({ force: false });

    assert.equal(code, 0);
    assert.ok(fs.exists(`/repo/${CONFIG_FILE_NAME}`), "config file created");
    assert.ok(fs.exists(`/repo/${IGNORE_FILE_NAME}`), "ignore file created");
    const copied = clipboard.lastCopied();
    assert.ok(copied !== null && copied.includes(RESPONSE_MARKER), "copies a protocol prompt");
    assert.ok(copied?.includes(AGENTS_CONTENT), "includes root AGENTS.md verbatim");
    assert.ok(copied?.includes("AGENTS.md"), "mentions the AGENTS.md section");
  });

  it("never overwrites existing files without --force", async () => {
    const { ports, fs } = fakePorts();
    fs.seed(`/repo/${CONFIG_FILE_NAME}`, "# my custom config\n");

    const code = await useCase(ports).init({ force: false });

    assert.equal(code, 0);
    assert.equal(fs.readText(`/repo/${CONFIG_FILE_NAME}`), "# my custom config\n");
  });

  it("overwrites existing files with --force", async () => {
    const { ports, fs } = fakePorts();
    fs.seed(`/repo/${CONFIG_FILE_NAME}`, "# my custom config\n");

    const code = await useCase(ports).init({ force: true });

    assert.equal(code, 0);
    const content = fs.readText(`/repo/${CONFIG_FILE_NAME}`);
    assert.ok(content?.includes("ctx project configuration"), "template written");
    assert.ok(!content?.includes("# my custom config"), "old content replaced");
  });

  it("reports AGENTS.md absence in the copied prompt", async () => {
    const { ports, clipboard } = fakePorts();

    const code = await useCase(ports).init({ force: false });

    assert.equal(code, 0);
    const copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.includes("No AGENTS.md file is present"), "reports absence");
  });

  it("fails with an actionable message outside a Git repository and creates nothing", async () => {
    const { ports, terminal, git, fs } = fakePorts();
    git.rootToReport = null;

    const code = await useCase(ports).init({ force: false });

    assert.equal(code, 1);
    assert.ok(terminal.errorLines.some((l) => l.includes("Git repository")));
    assert.ok(!fs.exists(`/repo/${CONFIG_FILE_NAME}`), "no config created");
    assert.ok(!fs.exists(`/repo/${IGNORE_FILE_NAME}`), "no ignore created");
  });

  it("does not create any prompt file in the project", async () => {
    const { ports, fs } = fakePorts();

    await useCase(ports).init({ force: false });

    const projectFiles = [...fs.files.keys()].map((p) => p.split("/").pop());
    assert.deepEqual(projectFiles.sort(), [CONFIG_FILE_NAME, IGNORE_FILE_NAME].sort());
  });

  it("reports and rethrows when the clipboard copy fails", async () => {
    const { ports, clipboard, terminal } = fakePorts();
    clipboard.failWith = new Error("pbcopy not found");

    await assert.rejects(() => useCase(ports).init({ force: false }), /pbcopy not found/);
    assert.ok(terminal.errorLines.some((l) => l.includes("Failed to copy to the clipboard")));
  });
});