/**
 * `CTX_CLIPBOARD_FILE` redirect tests for the real clipboard adapter.
 *
 * The redirect is an infrastructure-only test/CI hook: when the environment
 * variable is set, copy/read go to a plain file so end-to-end runs are
 * deterministic on headless CI. These tests prove the hook on an unsupported
 * platform stub — they never touch the real system clipboard.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  SystemClipboard,
  clipboardFileOverride,
} from "../platform/clipboard.js";
import { FakeEnv } from "./fakes.js";

/** Env stub on an unsupported platform: any clipboard call that reaches the
 * real backend must reject, proving the redirect short-circuits it. */
function unsupportedEnv(): FakeEnv {
  const env = new FakeEnv();
  env.platform = "linux";
  env.available = new Set();
  return env;
}

describe("clipboardFileOverride", () => {
  after(() => {
    delete process.env.CTX_CLIPBOARD_FILE;
  });

  it("returns null when the variable is unset", () => {
    delete process.env.CTX_CLIPBOARD_FILE;
    assert.equal(clipboardFileOverride(), null);
  });

  it("returns null for an empty value", () => {
    process.env.CTX_CLIPBOARD_FILE = "";
    assert.equal(clipboardFileOverride(), null);
  });

  it("returns the configured path when set", () => {
    process.env.CTX_CLIPBOARD_FILE = "/tmp/ctx-clip.txt";
    assert.equal(clipboardFileOverride(), "/tmp/ctx-clip.txt");
  });
});

describe("SystemClipboard with CTX_CLIPBOARD_FILE", () => {
  let dir: string;
  let file: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "ctx-clipboard-"));
    file = join(dir, "clipboard.txt");
    process.env.CTX_CLIPBOARD_FILE = file;
  });

  after(() => {
    delete process.env.CTX_CLIPBOARD_FILE;
    rmSync(dir, { recursive: true, force: true });
  });

  it("copy writes the file even on an unsupported platform", async () => {
    const clipboard = new SystemClipboard(unsupportedEnv());
    await clipboard.copy("line one\nline two\n");
    assert.equal(readFileSync(file, "utf8"), "line one\nline two\n");
  });

  it("read returns the file content verbatim", async () => {
    const clipboard = new SystemClipboard(unsupportedEnv());
    assert.equal(await clipboard.read(), "line one\nline two\n");
  });

  it("read returns an empty string for a missing file (empty clipboard)", async () => {
    const clipboard = new SystemClipboard(unsupportedEnv());
    const missing = join(dir, "missing.txt");
    process.env.CTX_CLIPBOARD_FILE = missing;
    try {
      assert.equal(await clipboard.read(), "");
    } finally {
      process.env.CTX_CLIPBOARD_FILE = file;
    }
  });

  it("copy creates missing parent directories", async () => {
    const clipboard = new SystemClipboard(unsupportedEnv());
    const nested = join(dir, "sub", "clip.txt");
    process.env.CTX_CLIPBOARD_FILE = nested;
    try {
      await clipboard.copy("nested");
      assert.equal(readFileSync(nested, "utf8"), "nested");
    } finally {
      process.env.CTX_CLIPBOARD_FILE = file;
    }
  });

  it("read without the redirect on an unsupported platform rejects", async () => {
    delete process.env.CTX_CLIPBOARD_FILE;
    const clipboard = new SystemClipboard(unsupportedEnv());
    await assert.rejects(() => clipboard.read(), /not supported/);
    // A pre-existing file must never be read without the redirect.
    writeFileSync(file, "secrets\n");
    delete process.env.CTX_CLIPBOARD_FILE;
    await assert.rejects(() => clipboard.read(), /not supported/);
  });
});