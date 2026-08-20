/**
 * DiscoveryUseCase tests: bounded tree, glob, and inspect against a fake
 * in-memory filesystem. Verifies depth/result limits are enforced and
 * reported, `.ctxignore` and sensitive paths are pruned, and inspect returns
 * bounded principal files plus module metadata.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DiscoveryUseCase } from "../application/discovery.js";
import { fakePorts, type FakeFs } from "./fakes.js";

const ROOT = "/repo";

function seedRepo(fs: FakeFs): void {
  fs.seed(`${ROOT}/src/app.ts`, "app content\n");
  fs.seed(`${ROOT}/src/lib/util.ts`, "util content\n");
  fs.seed(`${ROOT}/docs/guide.md`, "guide\n");
  fs.seed(`${ROOT}/dist/bundle.js`, "bundled\n");
  fs.seed(`${ROOT}/secrets/token.txt`, "tok\n");
  fs.seed(`${ROOT}/.ctxignore`, "dist/\n");
  fs.seed(
    `${ROOT}/package.json`,
    JSON.stringify({ name: "demo", version: "1.2.3", scripts: { build: "tsc", test: "vitest" } }),
  );
  fs.seed(`${ROOT}/README.md`, "line one\nline two\n");
}

function makeDiscovery(): {
  discovery: DiscoveryUseCase;
  fs: FakeFs;
  terminal: import("./fakes.js").FakeTerminal;
  clipboard: import("./fakes.js").FakeClipboard;
} {
  const { ports, fs, terminal, clipboard } = fakePorts();
  const discovery = new DiscoveryUseCase(ports.clipboard, ports.terminal, ports.git, ports.fs);
  return { discovery, fs, terminal, clipboard };
}

describe("DiscoveryUseCase.tree", () => {
  it("renders a bounded nested tree from the repository root", async () => {
    const { discovery, fs, terminal } = makeDiscovery();
    seedRepo(fs);

    const code = await discovery.tree(null, { copy: false, allowSensitive: false, protocol: false });

    assert.equal(code, 0);
    const out = terminal.infoLines.join("\n");
    assert.ok(out.includes("src/"));
    assert.ok(out.includes("  app.ts"));
    assert.ok(out.includes("  lib/"));
    assert.ok(out.includes("    util.ts"));
    assert.ok(out.includes("docs/"));
  });

  it("prunes .ctxignore and sensitive entries and counts them as excluded", async () => {
    const { discovery, fs, terminal } = makeDiscovery();
    seedRepo(fs);

    const code = await discovery.tree(null, { copy: false, allowSensitive: false, protocol: false });

    assert.equal(code, 0);
    const out = terminal.infoLines.join("\n");
    assert.ok(!out.includes("bundle.js"), "ignored dist/ pruned");
    assert.ok(!out.includes("token.txt"), "sensitive secrets/ pruned");
    assert.ok(out.includes("Excluded: 2"));
  });

  it("honours the depth override", async () => {
    const { discovery, fs, terminal } = makeDiscovery();
    seedRepo(fs);

    const code = await discovery.tree(1, { copy: false, allowSensitive: false, protocol: false });

    assert.equal(code, 0);
    const out = terminal.infoLines.join("\n");
    assert.ok(out.includes("src/"));
    assert.ok(!out.includes("app.ts"), "files at depth 2 hidden at depth 1");
  });

  it("reports when the entry limit is hit", async () => {
    const { discovery, fs } = makeDiscovery();
    seedRepo(fs);
    fs.seed(`${ROOT}/.ctx.toml`, "max_results = 2\n");

    const exec = await discovery.collectTree(null, false);
    assert.ok(exec !== null);
    if (exec !== null) {
      assert.ok(exec.part.lines.join("\n").includes("limited: yes (max 2)"));
      assert.ok(exec.part.lines.join("\n").includes("Entries: 2"));
    }
  });

  it("reveals sensitive paths only with the explicit override", async () => {
    const { discovery, fs, terminal } = makeDiscovery();
    seedRepo(fs);

    const code = await discovery.tree(null, { copy: false, allowSensitive: true, protocol: false });

    assert.equal(code, 0);
    assert.ok(terminal.infoLines.join("\n").includes("secrets/"));
  });

  it("copies the stable response only with --copy", async () => {
    const { discovery, fs, clipboard } = makeDiscovery();
    seedRepo(fs);

    await discovery.tree(null, { copy: true, allowSensitive: false, protocol: false });

    const copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.startsWith("# CTX RESPONSE"));
    assert.ok(copied.includes("## Tree (depth 3"));
    assert.ok(copied.includes("app.ts"));
  });
});

describe("DiscoveryUseCase.glob", () => {
  it("matches gitignore-style patterns at any depth", async () => {
    const { discovery, fs, terminal } = makeDiscovery();
    seedRepo(fs);

    const code = await discovery.glob("*.ts", { copy: false, allowSensitive: false, protocol: false });

    assert.equal(code, 0);
    const out = terminal.infoLines.join("\n");
    assert.ok(out.includes("- src/app.ts"));
    assert.ok(out.includes("- src/lib/util.ts"));
  });

  it("matches slash-anchored recursive patterns", async () => {
    const { discovery, fs, terminal } = makeDiscovery();
    seedRepo(fs);

    const code = await discovery.glob("src/**/*.ts", {
      copy: false,
      allowSensitive: false,
      protocol: false,
    });

    assert.equal(code, 0);
    const out = terminal.infoLines.join("\n");
    assert.ok(out.includes("- src/app.ts"));
    assert.ok(out.includes("- src/lib/util.ts"));
    assert.ok(!out.includes("docs/guide.md"));
  });

  it("prunes ignored and sensitive matches and reports the count", async () => {
    const { discovery, fs, terminal } = makeDiscovery();
    seedRepo(fs);

    const code = await discovery.glob("**/*", { copy: false, allowSensitive: false, protocol: false });

    assert.equal(code, 0);
    const out = terminal.infoLines.join("\n");
    assert.ok(!out.includes("bundle.js"));
    assert.ok(!out.includes("token.txt"));
    assert.ok(out.includes("Excluded: 2"));
  });

  it("applies the CLI limit override", async () => {
    const { discovery, fs, terminal } = makeDiscovery();
    seedRepo(fs);

    const code = await discovery.glob("*.ts", {
      copy: false,
      allowSensitive: false,
      protocol: false,
      limit: 1,
    });

    assert.equal(code, 0);
    const out = terminal.infoLines.join("\n");
    assert.ok(out.includes("Matches: 1"));
    assert.ok(out.includes("limited: yes (max 1)"));
  });
});

describe("DiscoveryUseCase.inspect", () => {
  it("returns a bounded tree plus principal files and package metadata", async () => {
    const { discovery, fs, terminal } = makeDiscovery();
    seedRepo(fs);

    const code = await discovery.inspect(null, { copy: false, allowSensitive: false, protocol: false });

    assert.equal(code, 0);
    const out = terminal.infoLines.join("\n");
    assert.ok(out.includes("src/"));
    assert.ok(out.includes("Principal files ("));
    assert.ok(out.includes("- package.json"));
    assert.ok(out.includes("name: demo"));
    assert.ok(out.includes("version: 1.2.3"));
    assert.ok(out.includes("scripts: build, test"));
    assert.ok(out.includes("- README.md"));
    assert.ok(out.includes("line one"));
  });

  it("scopes the tree to a validated directory path", async () => {
    const { discovery, fs, terminal } = makeDiscovery();
    seedRepo(fs);

    const code = await discovery.inspect("docs", { copy: false, allowSensitive: false, protocol: false });

    assert.equal(code, 0);
    const out = terminal.infoLines.join("\n");
    assert.ok(out.includes("guide.md"));
    assert.ok(!out.includes("app.ts"), "tree scoped to docs/");
  });

  it("refuses an invalid or sensitive inspect scope with an explanation", async () => {
    const { discovery, fs, terminal } = makeDiscovery();
    seedRepo(fs);

    const code = await discovery.inspect("secrets", { copy: false, allowSensitive: false, protocol: false });

    assert.equal(code, 1);
    const out = terminal.infoLines.join("\n");
    assert.ok(out.includes("Scope refused"));
    assert.ok(out.includes("sensitive path"));
  });

  it("omits principal files that are sensitive or ignored", async () => {
    const { discovery, fs, terminal } = makeDiscovery();
    seedRepo(fs);
    fs.seed(`${ROOT}/.ctx.toml`, 'sensitive_paths = ["package.json"]\n');

    const code = await discovery.inspect(null, { copy: false, allowSensitive: false, protocol: false });

    assert.equal(code, 0);
    const out = terminal.infoLines.join("\n");
    assert.ok(out.includes("Omitted principal files:"));
    assert.ok(out.includes("- package.json — sensitive path"));
  });

  it("truncates long principal file content with a notice", async () => {
    const { discovery, fs, terminal } = makeDiscovery();
    seedRepo(fs);
    fs.seed(`${ROOT}/README.md`, Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n") + "\n");

    const code = await discovery.inspect(null, { copy: false, allowSensitive: false, protocol: false });

    assert.equal(code, 0);
    const out = terminal.infoLines.join("\n");
    assert.ok(out.includes("… (content truncated to the first lines)"));
  });
});
