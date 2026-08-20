/**
 * Security/boundary tests: the repository permission boundary must refuse
 * traversal, absolute paths, symlink escapes, ignored, and sensitive paths
 * without reading any content.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseProjectConfig } from "../config.js";
import { PathGuard } from "../application/boundary.js";
import { FakeFs } from "./fakes.js";

const ROOT = "/repo";

function setup(): { fs: FakeFs; guard: (opts?: { allowSensitive?: boolean; configText?: string | null }) => PathGuard } {
  const fs = new FakeFs();
  fs.seed(`${ROOT}/src/app.ts`, "line one\nline two\n");
  fs.seed(`${ROOT}/src/other.ts`, "other\n");
  fs.seed(`${ROOT}/.env`, "SECRET=1\n");
  fs.seed(`${ROOT}/creds.json`, '{"password":"x"}\n');
  fs.seed(`${ROOT}/dist/bundle.js`, "bundled\n");
  fs.seed(`${ROOT}/.ctxignore`, "dist/\n");
  fs.seedDir(`${ROOT}/docs`);
  fs.seedSymlink(`${ROOT}/escape.ts`, "/outside/secret.ts");
  fs.seed("/outside/secret.ts", "outside content\n");
  fs.seed(`${ROOT}/inside-link.ts`, "");

  return {
    fs,
    guard: ({ allowSensitive = false, configText = null } = {}) =>
      new PathGuard(ROOT, parseProjectConfig(configText), allowSensitive, fs),
  };
}

describe("PathGuard", () => {
  it("accepts a repository-relative file", () => {
    const { guard } = setup();
    const result = guard().guard("src/app.ts");
    assert.deepEqual(result, { ok: true, kind: "ok", absPath: `${ROOT}/src/app.ts`, relPath: "src/app.ts" });
  });

  it("normalizes . segments and duplicate separators", () => {
    const { guard } = setup();
    const result = guard().guard("./src//app.ts");
    assert.deepEqual(result, { ok: true, kind: "ok", absPath: `${ROOT}/src/app.ts`, relPath: "src/app.ts" });
  });

  it("refuses traversal without reading content", () => {
    const { guard, fs } = setup();
    const result = guard().guard("../outside.ts");
    assert.ok(!result.ok);
    if (!result.ok) {
      assert.ok(result.reason.includes("traversal"));
    }
    assert.equal(fs.files.has("/outside.ts"), false);
  });

  it("refuses absolute paths", () => {
    const { guard } = setup();
    const result = guard().guard("/etc/passwd");
    assert.ok(!result.ok);
    if (!result.ok) {
      assert.ok(result.reason.includes("absolute paths"));
    }
  });

  it("refuses paths resolving outside allowed roots (symlink escape)", () => {
    const { guard } = setup();
    const result = guard().guard("escape.ts");
    assert.ok(!result.ok);
    if (!result.ok) {
      assert.ok(result.reason.includes("outside the allowed roots"));
    }
  });

  it("allows symlinks that stay inside the root", () => {
    const { guard, fs } = setup();
    fs.seedSymlink(`${ROOT}/inside-link.ts`, `${ROOT}/src/app.ts`);
    const result = guard().guard("inside-link.ts");
    assert.deepEqual(result, {
      ok: true,
      kind: "ok",
      absPath: `${ROOT}/src/app.ts`,
      relPath: "inside-link.ts",
    });
  });

  it("honours configured allowed_roots for external symlink targets", () => {
    const { guard } = setup();
    const configText = 'allowed_roots = ["/outside"]\n';
    // Without the config entry the symlink is refused…
    assert.ok(!guard().guard("escape.ts").ok);
    // …and with it, the resolved target is allowed.
    const result = guard({ configText }).guard("escape.ts");
    assert.deepEqual(result, { ok: true, kind: "ok", absPath: "/outside/secret.ts", relPath: "escape.ts" });
  });

  it("refuses missing files and directories", () => {
    const { guard } = setup();
    assert.ok(!guard().guard("nope.ts").ok);
    const dir = guard().guard("docs");
    assert.ok(!dir.ok);
    if (!dir.ok) {
      assert.ok(dir.reason.includes("directory"));
    }
  });

  it("refuses .ctxignore exclusions with the matching pattern", () => {
    const { guard } = setup();
    const result = guard().guard("dist/bundle.js");
    assert.ok(!result.ok);
    if (!result.ok) {
      assert.ok(result.reason.includes(".ctxignore"));
      assert.ok(result.reason.includes("dist/"));
    }
  });

  it("refuses sensitive paths from built-in defaults", () => {
    const { guard } = setup();
    const result = guard().guard(".env");
    assert.ok(!result.ok);
    if (!result.ok) {
      assert.ok(result.reason.includes("sensitive path"));
    }
  });

  it("refuses configured sensitive paths and honours the override", () => {
    const { guard } = setup();
    const configText = 'sensitive_paths = ["creds.json"]\n';
    const refused = guard({ configText }).guard("creds.json");
    assert.ok(!refused.ok);
    if (!refused.ok) {
      assert.ok(refused.reason.includes("sensitive path"));
    }
    const allowed = guard({ configText, allowSensitive: true }).guard("creds.json");
    assert.ok(allowed.ok);
  });

  it("still applies .ctxignore when the sensitive override is given", () => {
    const { guard } = setup();
    const result = guard({ allowSensitive: true }).guard("dist/bundle.js");
    assert.ok(!result.ok);
    if (!result.ok) {
      assert.ok(result.reason.includes(".ctxignore"));
    }
  });

  it("treats unknown config text as defaults", () => {
    const { guard } = setup();
    assert.ok(guard({ configText: "garbage ===" }).guard("src/app.ts").ok);
  });

  it("guardWrite accepts a new file under an existing directory", () => {
    const { guard } = setup();
    const result = guard().guardWrite("src/new.ts");
    assert.deepEqual(result, { ok: true, kind: "ok", absPath: `${ROOT}/src/new.ts`, relPath: "src/new.ts" });
  });

  it("guardWrite accepts replacing an existing file", () => {
    const { guard } = setup();
    assert.ok(guard().guardWrite("src/app.ts").ok);
  });

  it("guardWrite refuses traversal, absolute paths, and empty paths", () => {
    const { guard } = setup();
    assert.ok(!guard().guardWrite("../x.ts").ok);
    assert.ok(!guard().guardWrite("/etc/x").ok);
    assert.ok(!guard().guardWrite("").ok);
  });

  it("guardWrite refuses sensitive and ignored targets", () => {
    const { guard } = setup();
    const sensitive = guard().guardWrite(".env");
    assert.ok(!sensitive.ok);
    if (!sensitive.ok) {
      assert.ok(sensitive.reason.includes("sensitive path"));
    }
    const ignored = guard().guardWrite("dist/bundle.js");
    assert.ok(!ignored.ok);
    if (!ignored.ok) {
      assert.ok(ignored.reason.includes(".ctxignore"));
    }
  });

  it("guardWrite refuses the permission-boundary files", () => {
    const { guard } = setup();
    for (const name of [".ctx.toml", ".ctxignore"]) {
      const result = guard().guardWrite(name);
      assert.ok(!result.ok);
      if (!result.ok) {
        assert.ok(result.reason.includes("permission boundary"));
      }
    }
  });

  it("guardWrite refuses an existing directory target", () => {
    const { guard } = setup();
    const result = guard().guardWrite("docs");
    assert.ok(!result.ok);
    if (!result.ok) {
      assert.ok(result.reason.includes("directory"));
    }
  });

  it("guardWrite refuses a target resolving outside the root via symlink", () => {
    const { fs, guard } = setup();
    fs.seedSymlink(`${ROOT}/escape-dir`, "/outside");
    const file = guard().guardWrite("escape-dir/secret.ts");
    assert.ok(!file.ok);
    if (!file.ok) {
      assert.ok(file.reason.includes("outside the repository root"));
    }
    const direct = guard().guardWrite("escape.ts");
    assert.ok(!direct.ok);
    if (!direct.ok) {
      assert.ok(direct.reason.includes("outside the repository root"));
    }
  });

  it("guardWrite allows a new file through an in-root symlinked directory", () => {
    const { fs, guard } = setup();
    fs.seedSymlink(`${ROOT}/docs-link`, `${ROOT}/docs`);
    const result = guard().guardWrite("docs-link/new.md");
    assert.ok(result.ok);
  });
});