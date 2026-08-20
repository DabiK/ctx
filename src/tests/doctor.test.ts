/**
 * Unit tests for the `ctx doctor` application use case.
 * All tests use fake platform ports — never a real clipboard.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CONFIG_FILE_NAME } from "../branding.js";
import { DoctorUseCase } from "../application/doctor.js";
import { fakePorts } from "./fakes.js";

function useCase(ports: ReturnType<typeof fakePorts>["ports"]): DoctorUseCase {
  const { terminal, git, fs, env } = ports;
  return new DoctorUseCase(terminal, git, fs, env);
}

describe("DoctorUseCase.doctor", () => {
  it("reports all checks OK in a ready environment", async () => {
    const { ports, terminal, fs } = fakePorts();
    fs.seed(`/repo/${CONFIG_FILE_NAME}`, "x = 1\n");

    const code = await useCase(ports).doctor();

    assert.equal(code, 0);
    const out = terminal.infoLines.join("\n");
    assert.ok(out.includes("Git repository found"), "reports git");
    assert.ok(out.includes(CONFIG_FILE_NAME), "reports configuration");
    assert.ok(out.includes("pbcopy"), "reports clipboard backend");
    assert.ok(out.includes("ripgrep"), "reports search backend");
    assert.ok(out.includes("all checks passed"));
  });

  it("fails actionably outside a Git repository", async () => {
    const { ports, terminal, git } = fakePorts();
    git.rootToReport = null;

    const code = await useCase(ports).doctor();

    assert.equal(code, 1);
    assert.ok(terminal.infoLines.some((l) => l.includes("Not inside a Git repository")));
    assert.ok(terminal.infoLines.some((l) => l.includes("git init")));
  });

  it("fails when the clipboard backend is missing", async () => {
    const { ports, terminal, env } = fakePorts();
    env.available.delete("pbcopy");

    const code = await useCase(ports).doctor();

    assert.equal(code, 1);
    assert.ok(terminal.infoLines.some((l) => l.includes("Clipboard backend not available")));
  });

  it("fails when ripgrep is missing on macOS", async () => {
    const { ports, terminal, env } = fakePorts();
    env.available.delete("rg");

    const code = await useCase(ports).doctor();

    assert.equal(code, 1);
    assert.ok(
      terminal.infoLines.some((l) => l.includes("ripgrep not found") && l.includes("Install ripgrep")),
      "actionable install hint",
    );
  });

  it("passes with the Windows-native fallback when ripgrep is missing on Windows", async () => {
    const { ports, env } = fakePorts();
    env.platform = "win32";
    env.available = new Set(["powershell.exe"]);

    const code = await useCase(ports).doctor();

    assert.equal(code, 0);
  });

  it("warns (but does not fail) when configuration is missing", async () => {
    const { ports, terminal } = fakePorts();

    const code = await useCase(ports).doctor();

    assert.equal(code, 0);
    assert.ok(
      terminal.infoLines.some((l) => l.includes("not present") && l.includes("ctx init")),
      "actionable config hint",
    );
  });
});