/**
 * WriteUseCase tests: `@ctx patch` / `@ctx write` / `@ctx sequence` proposal
 * preview through `ctx read` and explicit application through `ctx apply`,
 * with fake platform ports. A proposal in the clipboard is validated against
 * the repository boundary and preflighted before any change; `ctx apply` is
 * the approval that actually writes.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RESPONSE_MARKER } from "../branding.js";
import type { PlatformPorts } from "../application/ports.js";
import { RequestUseCase } from "../application/request.js";
import { WriteUseCase } from "../application/write.js";
import { FakeSearch, fakePorts } from "./fakes.js";

const ROOT = "/repo";

const PATCH = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 111..222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1 +1 @@",
  "-alpha",
  "+ALPHA",
].join("\n");

function seedRepo(fs: import("./fakes.js").FakeFs): void {
  fs.seed(`${ROOT}/src/app.ts`, "alpha\n");
  fs.seed(`${ROOT}/src/other.ts`, "other\n");
  fs.seed(`${ROOT}/.env`, "SECRET=1\n");
  fs.seed(`${ROOT}/dist/bundle.js`, "bundled\n");
  fs.seed(`${ROOT}/.ctxignore`, "dist/\n");
  fs.seed(`${ROOT}/.ctx.toml`, "line_numbers = true\n");
}

function makeRequest(ports: PlatformPorts, search?: FakeSearch): RequestUseCase {
  return new RequestUseCase(
    ports.clipboard,
    ports.terminal,
    ports.git,
    ports.fs,
    search ?? new FakeSearch(),
  );
}

function makeWrite(ports: PlatformPorts, search?: FakeSearch): WriteUseCase {
  return new WriteUseCase(
    ports.clipboard,
    ports.terminal,
    ports.git,
    ports.fs,
    search ?? new FakeSearch(),
  );
}

function patchRequest(): string {
  return ["@ctx patch", PATCH].join("\n");
}

describe("WriteUseCase.preview (via ctx read)", () => {
  it("validates and preflights a patch without changing anything", async () => {
    const { ports, clipboard, terminal, git, fs } = fakePorts();
    seedRepo(fs);
    clipboard.content = patchRequest();
    const before = fs.readText(`${ROOT}/src/app.ts`);

    const code = await makeRequest(ports).read({ allowSensitive: false });

    assert.equal(code, 0);
    const copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.includes("## Patch proposal — ready to apply"));
    assert.ok(copied.includes("Preflight: passed (git apply --check)"));
    assert.ok(copied.includes("- src/app.ts (modified)"));
    assert.ok(copied.includes("running `ctx apply`"));
    assert.equal(git.lastCheckedPatch, PATCH + "\n", "preflight ran on the parsed diff");
    assert.equal(fs.readText(`${ROOT}/src/app.ts`), before, "no file was changed");
    assert.ok(terminal.infoLines.some((l) => l.includes("apply it unchanged")));
  });

  it("refuses a patch touching a sensitive path and copies the diagnostic", async () => {
    const { ports, clipboard, git, fs } = fakePorts();
    seedRepo(fs);
    const bad = [
      "diff --git a/.env b/.env",
      "index 111..222 100644",
      "--- a/.env",
      "+++ b/.env",
      "@@ -1 +1 @@",
      "-SECRET=1",
      "+SECRET=2",
    ].join("\n");
    clipboard.content = ["@ctx patch", bad].join("\n");

    const code = await makeRequest(ports).read({ allowSensitive: false });

    assert.equal(code, 1);
    const copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.includes("## Patch proposal — refused"));
    assert.ok(copied.includes(".env — sensitive path"));
    assert.ok(copied.includes("No files changed."));
    assert.equal(git.lastCheckedPatch, "", "preflight never ran");
    assert.equal(fs.readText(`${ROOT}/.env`), "SECRET=1\n", "no file was changed");
  });

  it("refuses a patch that would not apply cleanly (preflight failure)", async () => {
    const { ports, clipboard, git, fs } = fakePorts();
    seedRepo(fs);
    git.checkError = "error: patch failed: src/app.ts:1";
    clipboard.content = patchRequest();

    const code = await makeRequest(ports).read({ allowSensitive: false });

    assert.equal(code, 1);
    const copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.includes("Preflight failed (git apply --check)"));
    assert.ok(copied.includes("patch failed: src/app.ts:1"));
    assert.ok(copied.includes("No files changed."));
  });

  it("previews a full-file write and refuses when the path is sensitive", async () => {
    const { ports, clipboard, git, fs } = fakePorts();
    seedRepo(fs);
    clipboard.content = ["@ctx write src/new.ts", "```ts", "export const x = 1;", "```"].join("\n");

    const code = await makeRequest(ports).read({ allowSensitive: false });

    assert.equal(code, 0);
    const copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.includes("## Write proposal — ready to apply"));
    assert.ok(copied.includes("- src/new.ts (full write"));
    assert.equal(fs.files.has(`${ROOT}/src/new.ts`), false, "no file was created");
    assert.equal(git.lastAppliedPatch, "", "no git invocation for a full write");

    clipboard.content = ["@ctx write .env", "```", "SECRET=2", "```"].join("\n");
    const refused = await makeRequest(ports).read({ allowSensitive: false });
    assert.equal(refused, 1);
    const refusedCopied = clipboard.lastCopied() ?? "";
    assert.ok(refusedCopied.includes("## Write proposal — refused"));
    assert.ok(refusedCopied.includes(".env — sensitive path"));
  });

  it("previews a sequence with its verification reads without running them", async () => {
    const { ports, clipboard, fs } = fakePorts();
    seedRepo(fs);
    clipboard.content = [
      "@ctx sequence",
      "@ctx patch",
      PATCH,
      "@ctx status",
    ].join("\n");

    const code = await makeRequest(ports).read({ allowSensitive: false });

    assert.equal(code, 0);
    const copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.includes("## Sequence proposal — ready to apply"));
    assert.ok(copied.includes("Verification: 1 read operation(s)"));
    assert.equal(fs.readText(`${ROOT}/src/app.ts`), "alpha\n", "no file was changed");
  });
});

describe("WriteUseCase.apply (ctx apply)", () => {
  it("applies a valid patch through the git port", async () => {
    const { ports, clipboard, terminal, git, fs } = fakePorts();
    seedRepo(fs);
    clipboard.content = patchRequest();

    const code = await makeWrite(ports).apply({ allowSensitive: false });

    assert.equal(code, 0);
    assert.equal(git.lastCheckedPatch, PATCH + "\n", "re-preflighted before applying");
    assert.equal(git.lastAppliedPatch, PATCH + "\n", "the exact parsed diff was applied");
    const copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.includes("## Patch applied"));
    assert.ok(copied.includes("- src/app.ts (modified)"));
    assert.ok(terminal.infoLines.some((l) => l.includes("patch applied")));
  });

  it("refuses a patch whose application fails and changes nothing", async () => {
    const { ports, clipboard, git, fs } = fakePorts();
    seedRepo(fs);
    git.applyError = "error: patch failed: src/app.ts:1";
    clipboard.content = patchRequest();

    const code = await makeWrite(ports).apply({ allowSensitive: false });

    assert.equal(code, 1);
    const copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.includes("## Patch proposal — refused"));
    assert.ok(copied.includes("Preflight passed, but the application failed"));
    assert.ok(copied.includes("No files changed."));
  });

  it("creates a full-file write with missing parent directories", async () => {
    const { ports, clipboard, fs } = fakePorts();
    seedRepo(fs);
    clipboard.content = [
      "@ctx write src/deep/new.ts",
      "```ts",
      "export const deep = true;",
      "```",
    ].join("\n");

    const code = await makeWrite(ports).apply({ allowSensitive: false });

    assert.equal(code, 0);
    assert.equal(fs.readText(`${ROOT}/src/deep/new.ts`), "export const deep = true;");
    const copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.includes("## Write applied"));
    assert.ok(copied.includes("- src/deep/new.ts (full write"));
  });

  it("refuses a write to an ignored path (dist/ is in .ctxignore)", async () => {
    const { ports, clipboard, fs } = fakePorts();
    seedRepo(fs);
    clipboard.content = ["@ctx write dist/out.js", "```", "export {}", "```"].join("\n");

    const code = await makeWrite(ports).apply({ allowSensitive: false });

    assert.equal(code, 1);
    const copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.includes("## Write proposal — refused"));
    assert.ok(copied.includes("excluded by .ctxignore"));
    assert.ok(copied.includes("No files changed."));
    assert.equal(fs.files.has(`${ROOT}/dist/out.js`), false);
  });

  it("refuses a write whose body contains sensitive content unless overridden", async () => {
    const { ports, clipboard, fs } = fakePorts();
    seedRepo(fs);
    clipboard.content = [
      "@ctx write creds.txt",
      "```",
      "ghp_012345678901234567890123456789012345",
      "```",
    ].join("\n");

    const refused = await makeWrite(ports).apply({ allowSensitive: false });
    assert.equal(refused, 1);
    const copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.includes("obvious sensitive content"));
    assert.equal(fs.files.has(`${ROOT}/creds.txt`), false);

    clipboard.content = [
      "@ctx write creds.txt",
      "```",
      "ghp_012345678901234567890123456789012345",
      "```",
    ].join("\n");
    const allowed = await makeWrite(ports).apply({ allowSensitive: true });
    assert.equal(allowed, 0);
    assert.ok(fs.files.has(`${ROOT}/creds.txt`));
  });

  it("refuses to write the permission-boundary files", async () => {
    const { ports, clipboard, fs } = fakePorts();
    seedRepo(fs);
    clipboard.content = ["@ctx write .ctxignore", "```", "# hi", "```"].join("\n");

    const code = await makeWrite(ports).apply({ allowSensitive: false });

    assert.equal(code, 1);
    const copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.includes("permission boundary"));
    assert.equal(fs.readText(`${ROOT}/.ctxignore`), "dist/\n", "boundary file unchanged");
  });

  it("refuses to write a path that resolves outside the repository root", async () => {
    const { ports, clipboard, fs } = fakePorts();
    seedRepo(fs);
    fs.seedSymlink(`${ROOT}/escape-dir`, "/outside");
    fs.seedDir("/outside");
    clipboard.content = ["@ctx write escape-dir/evil.ts", "```", "x", "```"].join("\n");

    const code = await makeWrite(ports).apply({ allowSensitive: false });

    assert.equal(code, 1);
    const copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.includes("outside the repository root"));
    assert.ok(copied.includes("No files changed."));
  });

  it("refuses when the clipboard holds no write proposal", async () => {
    const { ports, clipboard } = fakePorts();
    clipboard.content = "@ctx status";

    const code = await makeWrite(ports).apply({ allowSensitive: false });

    assert.equal(code, 1);
    const copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.includes("no write proposal found"));
  });
});

describe("WriteUseCase.apply — sequences", () => {
  it("runs verification reads only after the write succeeds", async () => {
    const { ports, clipboard, git, fs } = fakePorts();
    seedRepo(fs);
    // A full-file write actually mutates the fake fs, so the verification
    // read can prove it ran after the write (a fake patch cannot mutate fs).
    clipboard.content = [
      "@ctx sequence",
      "@ctx write src/new.ts",
      "```ts",
      "export const written = true;",
      "```",
      "@ctx file src/new.ts",
      "@ctx status",
    ].join("\n");

    const code = await makeWrite(ports).apply({ allowSensitive: false });

    assert.equal(code, 0);
    const copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.includes("## Sequence — write applied"));
    assert.ok(copied.includes("## Verification: file src/new.ts"));
    assert.ok(copied.includes("export const written = true;"), "verification read shows the written content");
    assert.ok(copied.includes("## Verification: Status"));
    assert.equal(fs.readText(`${ROOT}/src/new.ts`), "export const written = true;");
  });

  it("runs patch-sequence verification reads in declared order", async () => {
    const { ports, clipboard, git, fs } = fakePorts();
    seedRepo(fs);
    clipboard.content = [
      "@ctx sequence",
      "@ctx patch",
      PATCH,
      "@ctx status",
      "@ctx file src/app.ts",
    ].join("\n");

    const code = await makeWrite(ports).apply({ allowSensitive: false });

    assert.equal(code, 0);
    const copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.includes("## Sequence — write applied"));
    const statusIdx = copied.indexOf("## Verification: Status");
    const fileIdx = copied.indexOf("## Verification: file src/app.ts");
    assert.ok(statusIdx >= 0 && fileIdx > statusIdx, "verification sections run in declared order");
    assert.equal(git.lastAppliedPatch, PATCH + "\n");
  });

  it("skips verification reads and reports why when the write is refused", async () => {
    const { ports, clipboard, git, fs } = fakePorts();
    seedRepo(fs);
    clipboard.content = [
      "@ctx sequence",
      "@ctx write .env",
      "```",
      "SECRET=2",
      "```",
      "@ctx status",
      "@ctx diff",
    ].join("\n");

    const code = await makeWrite(ports).apply({ allowSensitive: false });

    assert.equal(code, 1);
    const copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.includes("## Sequence proposal — refused"));
    assert.ok(copied.includes(".env — sensitive path"));
    assert.ok(copied.includes("Verification reads were skipped — the write did not succeed."));
    assert.ok(!copied.includes("## Verification"), "no verification ran");
    assert.equal(git.lastCheckedPatch, "");
    assert.equal(git.lastAppliedPatch, "");
    assert.equal(fs.readText(`${ROOT}/.env`), "SECRET=1\n", "no file was changed");
  });

  it("skips verification reads when the patch application fails after preflight", async () => {
    const { ports, clipboard, git, fs } = fakePorts();
    seedRepo(fs);
    git.applyError = "error: patch failed: src/app.ts:1";
    clipboard.content = [
      "@ctx sequence",
      "@ctx patch",
      PATCH,
      "@ctx status",
    ].join("\n");

    const code = await makeWrite(ports).apply({ allowSensitive: false });

    assert.equal(code, 1);
    const copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.includes("## Sequence proposal — refused"));
    assert.ok(copied.includes("Preflight passed, but the application failed"));
    assert.ok(copied.includes("Verification reads were skipped — the write did not succeed."));
    assert.ok(!copied.includes("## Verification"), "no verification ran");
    assert.equal(git.lastCheckedPatch, PATCH + "\n", "preflight ran before the apply failure");
    assert.equal(git.lastAppliedPatch, PATCH + "\n");
  });
});