/**
 * ReadUseCase tests: direct `ctx file` / `ctx files` behavior with fake
 * platform ports. Terminal output is concise; copies happen only with
 * `--copy`; refusals are explained and never silently dropped.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RESPONSE_MARKER } from "../branding.js";
import { ReadUseCase } from "../application/read.js";
import { fakePorts } from "./fakes.js";

const ROOT = "/repo";

function seedRepo(fs: import("./fakes.js").FakeFs): void {
  fs.seed(`${ROOT}/src/app.ts`, "alpha\nbeta\ngamma\ndelta\n");
  fs.seed(`${ROOT}/src/other.ts`, "only\n");
  fs.seed(`${ROOT}/dist/bundle.js`, "ignored\n");
  fs.seed(`${ROOT}/.env`, "TOKEN=secret\n");
  fs.seed(`${ROOT}/.ctxignore`, "dist/\n");
  fs.seed(
    `${ROOT}/.ctx.toml`,
    "line_numbers = true\nsensitive_paths = [\"creds.json\"]\n",
  );
  fs.seed(`${ROOT}/creds.json`, '{"password":"x"}\n');
}

describe("ReadUseCase.file", () => {
  it("prints content to the terminal and does not copy by default", async () => {
    const { ports, terminal, clipboard, fs } = fakePorts();
    seedRepo(fs);

    const code = await new ReadUseCase(ports.clipboard, ports.terminal, ports.git, ports.fs).file(
      "src/app.ts",
      { copy: false, allowSensitive: false, protocol: false },
    );

    assert.equal(code, 0);
    const out = terminal.infoLines.join("\n");
    assert.ok(out.includes("read 1-4 of 4 lines"));
    assert.ok(out.includes("1 | alpha"));
    assert.ok(out.includes("4 | delta"));
    assert.equal(clipboard.lastCopied(), null);
  });

  it("copies the stable protocol response only with --copy", async () => {
    const { ports, terminal, clipboard, fs } = fakePorts();
    seedRepo(fs);

    const code = await new ReadUseCase(ports.clipboard, ports.terminal, ports.git, ports.fs).file(
      "src/app.ts:2-3",
      { copy: true, allowSensitive: false, protocol: false },
    );

    assert.equal(code, 0);
    const copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.startsWith(RESPONSE_MARKER));
    assert.ok(copied.includes("## src/app.ts"));
    assert.ok(copied.includes("Lines 2-3 of 4"));
    assert.ok(copied.includes("2 | beta"));
    assert.ok(copied.includes("tokens: ~"));
    assert.ok(terminal.infoLines.some((l) => l.includes("copied to the clipboard")));
  });

  it("clamps ranges beyond the file length and reports it", async () => {
    const { ports, clipboard, fs } = fakePorts();
    seedRepo(fs);

    const code = await new ReadUseCase(ports.clipboard, ports.terminal, ports.git, ports.fs).file(
      "src/app.ts:3-99",
      { copy: true, allowSensitive: false, protocol: false },
    );

    assert.equal(code, 0);
    const copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.includes("Lines 3-4 of 4 |"));
    assert.ok(copied.includes("(clamped to file length)"));
  });

  it("refuses a range starting beyond the file end", async () => {
    const { ports, terminal, fs } = fakePorts();
    seedRepo(fs);

    const code = await new ReadUseCase(ports.clipboard, ports.terminal, ports.git, ports.fs).file(
      "src/app.ts:99-100",
      { copy: false, allowSensitive: false, protocol: false },
    );

    assert.equal(code, 1);
    assert.ok(terminal.errorLines.some((l) => l.includes("beyond the end of the file")));
  });

  it("honours line_numbers = false from the config", async () => {
    const { ports, clipboard, fs } = fakePorts();
    seedRepo(fs);
    fs.seed(`${ROOT}/.ctx.toml`, "line_numbers = false\n");

    const code = await new ReadUseCase(ports.clipboard, ports.terminal, ports.git, ports.fs).file(
      "src/other.ts",
      { copy: true, allowSensitive: false, protocol: false },
    );

    assert.equal(code, 0);
    const copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.includes("only"));
    assert.ok(!copied.includes("1 | only"));
  });

  it("explains omitted items and fails when nothing is read", async () => {
    const { ports, terminal, clipboard, fs } = fakePorts();
    seedRepo(fs);

    const code = await new ReadUseCase(ports.clipboard, ports.terminal, ports.git, ports.fs).files(
      ["missing.ts", "dist/bundle.js", ".env", "src/app.ts"],
      { copy: true, allowSensitive: false, protocol: false },
    );

    assert.equal(code, 0, "one file read keeps the run successful");
    const copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.includes("## Omitted"));
    assert.ok(copied.includes("missing.ts — not found in the repository"));
    assert.ok(copied.includes("excluded by .ctxignore pattern `dist/`"));
    assert.ok(copied.includes(".env — sensitive path"));

    const allRefused = await new ReadUseCase(
      ports.clipboard,
      ports.terminal,
      ports.git,
      ports.fs,
    ).files(["missing.ts", "dist/bundle.js"], {
      copy: false,
      allowSensitive: false,
      protocol: false,
    });
    assert.equal(allRefused, 1);
  });

  it("omits files with sensitive content unless overridden", async () => {
    const { ports, clipboard, fs } = fakePorts();
    seedRepo(fs);
    fs.seed(`${ROOT}/src/aws-sample.ts`, 'const key = "AKIA1234567890ABCDEF";\n');

    const useCase = new ReadUseCase(ports.clipboard, ports.terminal, ports.git, ports.fs);

    const refused = await useCase.file("src/aws-sample.ts", {
      copy: true,
      allowSensitive: false,
      protocol: false,
    });
    assert.equal(refused, 1);
    const copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.includes("contains sensitive content"));
    assert.ok(!copied.includes("AKIA"));

    const allowed = await useCase.file("src/aws-sample.ts", {
      copy: true,
      allowSensitive: true,
      protocol: false,
    });
    assert.equal(allowed, 0);
    assert.ok((clipboard.lastCopied() ?? "").includes("AKIA"));
  });

  it("omits a file whose selected content exceeds the per-file budget (no silent truncation)", async () => {
    const { ports, clipboard, fs } = fakePorts();
    seedRepo(fs);
    fs.seed(`${ROOT}/.ctx.toml`, "max_file_bytes = 9\n");

    const code = await new ReadUseCase(ports.clipboard, ports.terminal, ports.git, ports.fs).file(
      "src/app.ts",
      { copy: true, allowSensitive: false, protocol: false },
    );

    assert.equal(code, 1);
    const copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.includes("exceeds the per-file budget (max 9 bytes)"));
    assert.ok(!copied.includes("1 | alpha"), "no partial content is copied");

    // A smaller requested range stays within the budget and is read fully.
    const small = await new ReadUseCase(
      ports.clipboard,
      ports.terminal,
      ports.git,
      ports.fs,
    ).file("src/app.ts:1-1", {
      copy: true,
      allowSensitive: false,
      protocol: false,
    });
    assert.equal(small, 0);
    assert.ok((clipboard.lastCopied() ?? "").includes("1 | alpha"));
  });

  it("fails closed when a copied files response exceeds the total budget", async () => {
    const { ports, clipboard, fs } = fakePorts();
    seedRepo(fs);
    fs.seed(`${ROOT}/.ctx.toml`, "max_batch_bytes = 40\n");

    const code = await new ReadUseCase(ports.clipboard, ports.terminal, ports.git, ports.fs).files(
      ["src/app.ts", "src/other.ts"],
      { copy: true, allowSensitive: false, protocol: false },
    );

    assert.equal(code, 1);
    const copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.includes("## Response too large — reduce scope"));
    assert.ok(copied.includes("max_batch_bytes = 40 bytes"));
    assert.ok(copied.includes("src/app.ts"), "the recovery names the costly file");
    assert.ok(!copied.includes("alpha"), "oversized content is never copied");
  });
});