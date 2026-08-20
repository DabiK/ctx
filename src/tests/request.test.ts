/**
 * RequestUseCase tests: the clipboard round trip. A valid `@ctx` request in
 * the clipboard produces a stable response copied back; malformed requests
 * produce a structured refusal response and change nothing.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RESPONSE_MARKER } from "../branding.js";
import { RequestUseCase } from "../application/request.js";
import type { PlatformPorts } from "../application/ports.js";
import { FakeSearch, fakePorts } from "./fakes.js";

const ROOT = "/repo";

function seedRepo(fs: import("./fakes.js").FakeFs): void {
  fs.seed(`${ROOT}/src/app.ts`, "alpha\nbeta\ngamma\n");
  fs.seed(`${ROOT}/src/other.ts`, "other\n");
  fs.seed(`${ROOT}/dist/bundle.js`, "bundled\n");
  fs.seed(`${ROOT}/.ctxignore`, "dist/\n");
  fs.seed(`${ROOT}/.ctx.toml`, "line_numbers = true\n");
}

/** Build a RequestUseCase from a fake port bundle (with an optional fake search). */
function makeRequest(ports: PlatformPorts, search?: FakeSearch): RequestUseCase {
  return new RequestUseCase(
    ports.clipboard,
    ports.terminal,
    ports.git,
    ports.fs,
    search ?? new FakeSearch(),
  );
}

describe("RequestUseCase.read", () => {
  it("copies a stable response for a valid file request", async () => {
    const { ports, clipboard, fs } = fakePorts();
    seedRepo(fs);
    clipboard.content = "@ctx file src/app.ts:2-3";

    const code = await makeRequest(ports).read({ allowSensitive: false });

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

    const code = await makeRequest(ports).read({ allowSensitive: false });

    assert.equal(code, 0);
    const copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.includes("Read: 1 | Omitted: 1"));
    assert.ok(copied.includes("excluded by .ctxignore"));
  });

  it("copies a structured refusal for malformed requests", async () => {
    const { ports, clipboard } = fakePorts();
    clipboard.content = "@ctx explode a.ts";

    const code = await makeRequest(ports).read({ allowSensitive: false });

    assert.equal(code, 1);
    const copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.includes("## Request refused"));
    assert.ok(copied.includes("unsupported operation `explode`"));
    assert.ok(copied.includes("batch (a block of @ctx operations)"));
  });

  it("reports when the clipboard contains no @ctx request", async () => {
    const { ports, clipboard } = fakePorts();
    clipboard.content = "just a normal message";

    const code = await makeRequest(ports).read({ allowSensitive: false });

    assert.equal(code, 1);
    assert.ok((clipboard.lastCopied() ?? "").includes("no @ctx request found"));
  });

  it("refuses when the clipboard cannot be read", async () => {
    const { ports, clipboard, terminal } = fakePorts();
    clipboard.failReadWith = new Error("no backend");

    const code = await makeRequest(ports).read({ allowSensitive: false });

    assert.equal(code, 1);
    assert.equal(clipboard.lastCopied(), null);
    assert.ok(terminal.errorLines.some((l) => l.includes("Failed to read the clipboard")));
  });

  it("keeps sensitive content withheld in protocol mode", async () => {
    const { ports, clipboard, fs } = fakePorts();
    seedRepo(fs);
    fs.seed(`${ROOT}/.env`, "TOKEN=secret\n");
    clipboard.content = "@ctx file .env";

    const code = await makeRequest(ports).read({ allowSensitive: false });

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

    const code = await makeRequest(ports).read({ allowSensitive: true });

    assert.equal(code, 0);
    const copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.includes("TOKEN=secret"));
  });

  it("executes a tree request through the clipboard", async () => {
    const { ports, clipboard, fs } = fakePorts();
    seedRepo(fs);
    fs.seed(`${ROOT}/src/lib/util.ts`, "util\n");
    clipboard.content = "@ctx tree --depth 3";

    const code = await makeRequest(ports).read({ allowSensitive: false });

    assert.equal(code, 0);
    const copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.startsWith(RESPONSE_MARKER));
    assert.ok(copied.includes("## Tree (depth 3"));
    assert.ok(copied.includes("app.ts"));
    assert.ok(copied.includes("util.ts"));
  });

  it("executes a search request through the clipboard", async () => {
    const { ports, clipboard, fs, search } = fakePorts();
    seedRepo(fs);
    search.matches = [{ relPath: "src/app.ts", line: 1, content: "alpha" }];
    clipboard.content = "@ctx search alpha";

    const code = await makeRequest(ports, search).read({ allowSensitive: false });

    assert.equal(code, 0);
    const copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.includes("## Search \"alpha\" (fake)"));
    assert.ok(copied.includes("- src/app.ts:1 | alpha"));
  });

  it("combines read and discovery operations into one response", async () => {
    const { ports, clipboard, fs, search } = fakePorts();
    seedRepo(fs);
    search.matches = [{ relPath: "src/other.ts", line: 1, content: "other" }];
    clipboard.content = ["@ctx file src/app.ts:2-2", "@ctx search other"].join("\n");

    const code = await makeRequest(ports, search).read({ allowSensitive: false });

    assert.equal(code, 0);
    const copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.startsWith(RESPONSE_MARKER));
    assert.ok(copied.includes("## file src/app.ts:2-2"));
    assert.ok(copied.includes("2 | beta"));
    assert.ok(copied.includes("## Search \"other\" (fake)"));
    assert.ok(copied.includes("- src/other.ts:1 | other"));
    assert.equal(
      copied.split(RESPONSE_MARKER).length - 1,
      1,
      "one response marker for the combined response",
    );
  });

  it("exits non-zero when a combined request produces no content", async () => {
    const { ports, clipboard, fs, search } = fakePorts();
    seedRepo(fs);
    search.matches = [];
    clipboard.content = ["@ctx file missing.ts", "@ctx search nothing"].join("\n");

    const code = await makeRequest(ports, search).read({ allowSensitive: false });

    assert.equal(code, 1);
    const copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.includes("## file missing.ts"));
    assert.ok(copied.includes("not found"));
  });

  it("executes a @ctx batch in declared order with one stable response", async () => {
    const { ports, clipboard, fs, search } = fakePorts();
    seedRepo(fs);
    search.matches = [{ relPath: "src/other.ts", line: 1, content: "other" }];
    clipboard.content = [
      "@ctx batch",
      "@ctx file src/app.ts:2-2",
      "@ctx search other",
      "@ctx status",
    ].join("\n");

    const code = await makeRequest(ports, search).read({ allowSensitive: false });

    assert.equal(code, 0);
    const copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.startsWith(RESPONSE_MARKER));
    assert.ok(copied.includes("## Batch response"));
    assert.ok(copied.includes("Operations: 3 | bytes:"));
    assert.ok(copied.includes("tokens: ~"));
    assert.ok(copied.includes("limits: total ≤ 1048576 bytes | per-file ≤ 262144 bytes"));
    const fileIdx = copied.indexOf("## file src/app.ts:2-2");
    const searchIdx = copied.indexOf('## Search "other" (fake)');
    const statusIdx = copied.indexOf("## Status");
    assert.ok(fileIdx >= 0 && searchIdx > fileIdx && statusIdx > searchIdx, "declared order");
    assert.ok(copied.includes("2 | beta"));
    assert.equal(copied.split(RESPONSE_MARKER).length - 1, 1, "one response marker");
  });

  it("gives a @ctx batch of file reads the batch envelope", async () => {
    const { ports, clipboard, fs } = fakePorts();
    seedRepo(fs);
    clipboard.content = [
      "@ctx batch",
      "@ctx file src/app.ts:1-1",
      "@ctx file src/other.ts",
    ].join("\n");

    const code = await makeRequest(ports).read({ allowSensitive: false });

    assert.equal(code, 0);
    const copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.includes("## Batch response"));
    assert.ok(copied.includes("## file src/app.ts:1-1"));
    assert.ok(copied.includes("## file src/other.ts"));
    assert.ok(copied.includes("Read: 1 | Omitted: 0"));
  });

  it("fails closed when a batch would exceed the total budget", async () => {
    const { ports, clipboard, fs } = fakePorts();
    seedRepo(fs);
    fs.seed(`${ROOT}/.ctx.toml`, "max_batch_bytes = 40\n");
    clipboard.content = ["@ctx batch", "@ctx file src/app.ts", "@ctx file src/other.ts"].join("\n");

    const code = await makeRequest(ports).read({ allowSensitive: false });

    assert.equal(code, 1);
    const copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.includes("## Response too large — reduce scope"));
    assert.ok(copied.includes("max_batch_bytes = 40 bytes"));
    assert.ok(copied.includes("Most expensive requested sections:"));
    assert.ok(copied.includes("src/app.ts"), "the recovery names the costly section");
    assert.ok(!copied.includes("1 | alpha"), "oversized content is never copied");
    assert.ok(!copied.includes("1 | other"), "oversized content is never copied");
  });

  it("omits oversized files inside a batch with an explanation", async () => {
    const { ports, clipboard, fs } = fakePorts();
    seedRepo(fs);
    fs.seed(`${ROOT}/.ctx.toml`, "max_file_bytes = 8\n");
    clipboard.content = ["@ctx batch", "@ctx file src/app.ts", "@ctx file src/other.ts"].join("\n");

    const code = await makeRequest(ports).read({ allowSensitive: false });

    assert.equal(code, 1, "nothing readable exits non-zero");
    const copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.includes("## Batch response"));
    assert.ok(copied.includes("exceeds the per-file budget (max 8 bytes)"));
    assert.ok(!copied.includes("1 | alpha"));
    assert.ok(!copied.includes("1 | other"));
  });
});