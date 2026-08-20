/**
 * SearchUseCase tests: content search honours `.ctxignore`, sensitive paths,
 * sensitive line content, allowed roots, and explicit result limits, with a
 * fake search backend. Limits are reported explicitly instead of truncating
 * silently.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SearchUseCase } from "../application/search.js";
import { fakePorts, type FakeFs, type FakeSearch } from "./fakes.js";

const ROOT = "/repo";

function seedRepo(fs: FakeFs): void {
  fs.seed(`${ROOT}/src/app.ts`, "alpha\nbeta\n");
  fs.seed(`${ROOT}/docs/guide.md`, "guide\n");
  fs.seed(`${ROOT}/dist/bundle.js`, "bundled\n");
  fs.seed(`${ROOT}/.ctxignore`, "dist/\n");
  fs.seed(`${ROOT}/.env`, "TOKEN=secret\n");
}

function makeSearch(): {
  useCase: SearchUseCase;
  fs: FakeFs;
  search: FakeSearch;
  terminal: import("./fakes.js").FakeTerminal;
  clipboard: import("./fakes.js").FakeClipboard;
} {
  const { ports, fs, search, terminal, clipboard } = fakePorts();
  const useCase = new SearchUseCase(ports.clipboard, ports.terminal, ports.git, ports.fs, search);
  return { useCase, fs, search, terminal, clipboard };
}

describe("SearchUseCase.search", () => {
  it("applies .ctxignore, sensitive-path, and sensitive-content rules", async () => {
    const { useCase, fs, search, terminal } = makeSearch();
    seedRepo(fs);
    search.matches = [
      { relPath: "src/app.ts", line: 1, content: "alpha" },
      { relPath: "dist/bundle.js", line: 1, content: "bundled" },
      { relPath: ".env", line: 1, content: "TOKEN=secret" },
      { relPath: "docs/guide.md", line: 1, content: "ghp_012345678901234567890123456789012345" },
    ];

    const code = await useCase.search("needle", { copy: false, allowSensitive: false, protocol: false });

    assert.equal(code, 0);
    const out = terminal.infoLines.join("\n");
    assert.ok(out.includes("- src/app.ts:1 | alpha"));
    assert.ok(!out.includes("bundle.js"), "ignored file filtered");
    assert.ok(!out.includes(".env"), "sensitive path filtered");
    assert.ok(!out.includes("ghp_"), "sensitive line content filtered");
    assert.ok(out.includes("Matches: 1"));
    assert.ok(out.includes("Excluded: 3"));
  });

  it("reports when the result limit is hit", async () => {
    const { useCase, fs, search, terminal } = makeSearch();
    seedRepo(fs);
    // Ten raw matches against an existing file, capped at the display limit.
    search.matches = Array.from({ length: 10 }, (_, i) => ({
      relPath: "src/app.ts",
      line: i + 1,
      content: "alpha",
    }));

    const code = await useCase.search("needle", {
      copy: false,
      allowSensitive: false,
      protocol: false,
      limit: 4,
    });

    assert.equal(code, 0);
    const out = terminal.infoLines.join("\n");
    assert.ok(out.includes("Matches: 4"));
    assert.ok(out.includes("limited: yes (max 4)"));
  });

  it("fetches with headroom so filtering does not starve the visible limit", async () => {
    const { useCase, fs, search } = makeSearch();
    seedRepo(fs);
    search.matches = [];

    await useCase.search("needle", { copy: false, allowSensitive: false, protocol: false, limit: 5 });

    assert.equal(search.lastLimit, 20, "fetches limit * 4");
  });

  it("honours the sensitive override for paths and content", async () => {
    const { useCase, fs, search, terminal } = makeSearch();
    seedRepo(fs);
    search.matches = [{ relPath: ".env", line: 1, content: "TOKEN=secret" }];

    const code = await useCase.search("TOKEN", { copy: false, allowSensitive: true, protocol: false });

    assert.equal(code, 0);
    assert.ok(terminal.infoLines.join("\n").includes("- .env:1 | TOKEN=secret"));
  });

  it("exits non-zero when a search yields no matches", async () => {
    const { useCase, fs, search, terminal } = makeSearch();
    seedRepo(fs);
    search.matches = [];

    const code = await useCase.search("needle", { copy: false, allowSensitive: false, protocol: false });

    assert.equal(code, 1);
    assert.ok(terminal.infoLines.join("\n").includes("Matches: 0"));
  });

  it("reports a backend failure with an actionable message", async () => {
    const { useCase, fs, search, terminal } = makeSearch();
    seedRepo(fs);
    search.failWith = new Error("rg: no such file");

    const code = await useCase.search("needle", { copy: false, allowSensitive: false, protocol: false });

    assert.equal(code, 1);
    assert.ok(terminal.errorLines.join("\n").includes("search backend failed"));
  });

  it("copies the stable response only with --copy", async () => {
    const { useCase, fs, search, clipboard } = makeSearch();
    seedRepo(fs);
    search.matches = [{ relPath: "src/app.ts", line: 2, content: "beta" }];

    await useCase.search("beta", { copy: true, allowSensitive: false, protocol: false });

    const copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.startsWith("# CTX RESPONSE"));
    assert.ok(copied.includes("## Search \"beta\" (fake)"));
    assert.ok(copied.includes("- src/app.ts:2 | beta"));
  });
});
