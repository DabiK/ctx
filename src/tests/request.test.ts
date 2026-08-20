/**
 * RequestUseCase tests: the clipboard round trip. A valid `@ctx` request in
 * the clipboard produces a stable response copied back; malformed requests
 * produce a structured refusal response and change nothing.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RESPONSE_MARKER } from "../branding.js";
import { RequestUseCase } from "../application/request.js";
import { fakePorts } from "./fakes.js";

const ROOT = "/repo";

function seedRepo(fs: import("./fakes.js").FakeFs): void {
  fs.seed(`${ROOT}/src/app.ts`, "alpha\nbeta\ngamma\n");
  fs.seed(`${ROOT}/src/other.ts`, "other\n");
  fs.seed(`${ROOT}/dist/bundle.js`, "bundled\n");
  fs.seed(`${ROOT}/.ctxignore`, "dist/\n");
  fs.seed(`${ROOT}/.ctx.toml`, "line_numbers = true\n");
}

describe("RequestUseCase.read", () => {
  it("copies a stable response for a valid file request", async () => {
    const { ports, clipboard, fs } = fakePorts();
    seedRepo(fs);
    clipboard.content = "@ctx file src/app.ts:2-3";

    const code = await new RequestUseCase(
      ports.clipboard,
      ports.terminal,
      ports.git,
      ports.fs,
    ).read({ allowSensitive: false });

    assert.equal(code, 0);
    const copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.startsWith(RESPONSE_MARKER));
    assert.ok(copied.includes("## Read summary"));
    assert.ok(copied.includes("Read: 1 | Omitted: 0"));
    assert.ok(copied.includes("## src/app.ts"));
    assert.ok(copied.includes("2 | beta"));
  });

  it("handles a files request and explains mixed omissions", async () => {
    const { ports, clipboard, fs } = fakePorts();
    seedRepo(fs);
    clipboard.content = "@ctx files src/app.ts dist/bundle.js";

    const code = await new RequestUseCase(
      ports.clipboard,
      ports.terminal,
      ports.git,
      ports.fs,
    ).read({ allowSensitive: false });

    assert.equal(code, 0);
    const copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.includes("Read: 1 | Omitted: 1"));
    assert.ok(copied.includes("excluded by .ctxignore"));
  });

  it("copies a structured refusal for malformed requests", async () => {
    const { ports, clipboard } = fakePorts();
    clipboard.content = "@ctx tree --depth 2";

    const code = await new RequestUseCase(
      ports.clipboard,
      ports.terminal,
      ports.git,
      ports.fs,
    ).read({ allowSensitive: false });

    assert.equal(code, 1);
    const copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.includes("## Request refused"));
    assert.ok(copied.includes("unsupported operation `tree`"));
    assert.ok(copied.includes("file <path>"));
  });

  it("reports when the clipboard contains no @ctx request", async () => {
    const { ports, clipboard } = fakePorts();
    clipboard.content = "just a normal message";

    const code = await new RequestUseCase(
      ports.clipboard,
      ports.terminal,
      ports.git,
      ports.fs,
    ).read({ allowSensitive: false });

    assert.equal(code, 1);
    assert.ok((clipboard.lastCopied() ?? "").includes("no @ctx request found"));
  });

  it("refuses when the clipboard cannot be read", async () => {
    const { ports, clipboard, terminal } = fakePorts();
    clipboard.failReadWith = new Error("no backend");

    const code = await new RequestUseCase(
      ports.clipboard,
      ports.terminal,
      ports.git,
      ports.fs,
    ).read({ allowSensitive: false });

    assert.equal(code, 1);
    assert.equal(clipboard.lastCopied(), null);
    assert.ok(terminal.errorLines.some((l) => l.includes("Failed to read the clipboard")));
  });

  it("keeps sensitive content withheld in protocol mode", async () => {
    const { ports, clipboard, fs } = fakePorts();
    seedRepo(fs);
    fs.seed(`${ROOT}/.env`, "TOKEN=secret\n");
    clipboard.content = "@ctx file .env";

    const code = await new RequestUseCase(
      ports.clipboard,
      ports.terminal,
      ports.git,
      ports.fs,
    ).read({ allowSensitive: false });

    assert.equal(code, 1);
    const copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.includes("sensitive path"));
    assert.ok(!copied.includes("TOKEN=secret"));
  });

  it("honours the human --allow-sensitive override on the request command", async () => {
    const { ports, clipboard, fs } = fakePorts();
    seedRepo(fs);
    fs.seed(`${ROOT}/.env`, "TOKEN=secret\n");
    clipboard.content = "@ctx file .env";

    const code = await new RequestUseCase(
      ports.clipboard,
      ports.terminal,
      ports.git,
      ports.fs,
    ).read({ allowSensitive: true });

    assert.equal(code, 0);
    const copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.includes("TOKEN=secret"));
  });
});