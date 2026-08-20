/**
 * Unit tests for the `ctx prompt` application use case and the prompt
 * builders. All tests use fake platform ports — never a real clipboard.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RESPONSE_MARKER } from "../branding.js";
import { PromptUseCase } from "../application/prompt.js";
import { buildCompactPrompt, buildPrompt } from "../prompt.js";
import { fakePorts } from "./fakes.js";

const AGENTS_CONTENT = "# Team conventions\n- Always run tests.\n";

function useCase(ports: ReturnType<typeof fakePorts>["ports"]): PromptUseCase {
  const { clipboard, terminal, git, fs } = ports;
  return new PromptUseCase(clipboard, terminal, git, fs);
}

describe("PromptUseCase.prompt", () => {
  it("regenerates and copies the prompt with AGENTS.md", async () => {
    const { ports, clipboard, fs } = fakePorts();
    fs.seed("/repo/AGENTS.md", AGENTS_CONTENT);

    const code = await useCase(ports).prompt({ compact: false });

    assert.equal(code, 0);
    const copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.includes(RESPONSE_MARKER));
    assert.ok(copied.includes(AGENTS_CONTENT));
  });

  it("--compact copies a smaller but still valid prompt", async () => {
    const { ports, clipboard } = fakePorts();

    const fullCode = await useCase(ports).prompt({ compact: false });
    const full = clipboard.lastCopied() ?? "";
    const compactCode = await useCase(ports).prompt({ compact: true });
    const compact = clipboard.lastCopied() ?? "";

    assert.equal(fullCode, 0);
    assert.equal(compactCode, 0);
    assert.ok(compact.length < full.length, "compact is smaller");
    assert.ok(compact.includes(RESPONSE_MARKER), "compact still teaches the protocol");
    assert.ok(compact.includes("@ctx"), "compact still teaches the request marker");
    assert.ok(!compact.includes(buildPrompt()), "compact is not the full prompt");
    assert.ok(compact.includes("smallest sufficient request"));
  });

  it("does not create any file in the project", async () => {
    const { ports, fs } = fakePorts();

    await useCase(ports).prompt({ compact: false });

    assert.equal(fs.files.size, 0, "no prompt file created");
  });

  it("fails outside a Git repository", async () => {
    const { ports, git } = fakePorts();
    git.rootToReport = null;

    const code = await useCase(ports).prompt({ compact: false });

    assert.equal(code, 1);
  });
});

describe("prompt builders", () => {
  it("compact is strictly smaller than full", () => {
    assert.ok(buildCompactPrompt().length < buildPrompt().length);
  });

  it("both teach request and response markers", () => {
    for (const p of [buildPrompt(), buildCompactPrompt()]) {
      assert.ok(p.includes("@ctx"));
      assert.ok(p.includes(RESPONSE_MARKER));
      assert.ok(p.includes("ctx read"));
      assert.ok(p.includes("ctx watch"));
    }
  });

  it("teaches the clipboard round trip without asking for init again", () => {
    for (const p of [buildPrompt(), buildCompactPrompt()]) {
      assert.ok(p.includes("standalone @ctx block"));
      assert.ok(p.toLowerCase().includes("read request"));
      assert.ok(p.includes("Do not ask"));
    }
  });
});
