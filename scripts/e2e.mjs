#!/usr/bin/env node
/**
 * End-to-end fixture workflow for the packaged `ctx` CLI.
 *
 * Runs the built `dist/cli.js` against a temporary Git repository with the
 * clipboard redirected to a file via `CTX_CLIPBOARD_FILE` (see
 * src/platform/clipboard.ts), so the whole scenario is deterministic on
 * headless CI. Covers the PRD #10 acceptance path:
 *
 *   - init/prompt: `ctx init` creates config + ignore files and copies the
 *     startup protocol (with root AGENTS.md); `ctx prompt --compact` copies a
 *     smaller prompt.
 *   - clipboard context round trip: an `@ctx file` (and a combined
 *     `@ctx status` + `@ctx file`) request is copied back as a
 *     `# CTX RESPONSE`.
 *   - search through the protocol.
 *   - a tagged multi-file patch: preview via `ctx read` (nothing changes),
 *     then `ctx apply`.
 *   - post-write verification: `@ctx status` + `@ctx diff` confirm the change.
 *   - a visible failure case: traversal is refused without reading content,
 *     and `ctx apply` without a proposal refuses.
 *   - on Windows the search fallback (findstr) is verified with ripgrep
 *     hidden from PATH; elsewhere a missing ripgrep yields the actionable
 *     failure (and a present ripgrep was already exercised above).
 *
 * The watcher's TUI-mediated verification is exercised deterministically by
 * the WatchUseCase unit suites (scripted TuiPort/fakes) and manually through
 * docs/smoke-opentui.md; this script proves the packaged read/write loop.
 *
 * Exit code is 0 only when every step passes.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(REPO_ROOT, "dist", "cli.js");

const PASSED = [];
let currentStep = "";

function step(name, fn) {
  currentStep = name;
  const started = Date.now();
  fn();
  PASSED.push(name);
  console.log(`[e2e] PASS ${name} (${Date.now() - started}ms)`);
}

function fail(message) {
  console.error(`[e2e] FAIL ${currentStep}: ${message}`);
  process.exit(1);
}

function check(condition, message) {
  if (!condition) {
    fail(message);
  }
}

/** Run the built ctx CLI; returns { status, stdout, stderr }. */
function runCtx(args, { cwd, env = {} } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    env: { ...process.env, CTX_CLIPBOARD_FILE: clipboardPath, ...env },
    encoding: "utf8",
  });
}

/** Run an arbitrary command; returns { status, stdout, stderr }. */
function run(command, args, { cwd, env = {} } = {}) {
  return spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

function git(args, cwd) {
  const res = run("git", ["-C", cwd, ...args]);
  if (res.status !== 0) {
    fail(`git ${args.join(" ")} failed: ${res.stderr}`);
  }
  return res.stdout;
}

const work = mkdtempSync(join(tmpdir(), "ctx-e2e-"));
const repo = join(work, "fixture");
const clipboardPath = join(work, "clipboard.txt");
mkdirSync(repo, { recursive: true });

function clip() {
  return existsSync(clipboardPath) ? readFileSync(clipboardPath, "utf8") : "";
}

function setClip(text) {
  writeFileSync(clipboardPath, text, "utf8");
}

function fixtureFile(relPath, content) {
  const abs = join(repo, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

try {
  // --- Fixture repository -------------------------------------------------
  // `git init -b main` needs git >= 2.28; fall back for older builds.
  const init = run("git", ["init", "-q", "-b", "main"], { cwd: repo });
  if (init.status !== 0) {
    run("git", ["init", "-q"], { cwd: repo });
    run("git", ["checkout", "-q", "-b", "main"], { cwd: repo });
  }
  git(["config", "user.email", "e2e@ctx.test"], repo);
  git(["config", "user.name", "ctx e2e"], repo);
  // LF fixtures keep `git apply` byte-stable on Windows.
  git(["config", "core.autocrlf", "false"], repo);

  fixtureFile("hello.txt", "hello world\n");
  fixtureFile("lib/math.ts", [
    "export const add = (a: number, b: number): number => a + b;",
    "// TODO: sum two numbers",
    "",
  ].join("\n"));
  fixtureFile("AGENTS.md", "# Fixture root instructions\n");
  git(["add", "-A"], repo);
  git(["commit", "-q", "-m", "initial"], repo);

  // --- 1. init: config files + startup protocol with root AGENTS.md ---------
  step("init creates config/ignore files and copies the protocol + AGENTS.md", () => {
    const res = runCtx(["init"], { cwd: repo });
    check(res.status === 0, `ctx init exited ${res.status}: ${res.stderr}`);
    check(existsSync(join(repo, ".ctx.toml")), ".ctx.toml was not created");
    check(existsSync(join(repo, ".ctxignore")), ".ctxignore was not created");
    const copied = clip();
    check(copied.includes("@ctx"), "startup protocol lacks the @ctx request marker");
    check(copied.includes("--- AGENTS.md ---"), "startup protocol lacks the AGENTS.md section");
    check(copied.includes("Fixture root instructions"), "root AGENTS.md content is missing from the protocol");
  });

  // --- 2. prompt --compact: a smaller valid prompt ---------------------------
  step("prompt --compact copies a smaller protocol prompt", () => {
    const full = clip();
    const res = runCtx(["prompt", "--compact"], { cwd: repo });
    check(res.status === 0, `ctx prompt --compact exited ${res.status}: ${res.stderr}`);
    const compact = clip();
    check(compact.length > 0, "compact prompt is empty");
    check(compact.length < full.length, `compact (${compact.length}B) is not smaller than the full prompt (${full.length}B)`);
    check(compact.includes("@ctx"), "compact prompt lacks the @ctx request marker");
  });

  // --- 3. clipboard context round trip ---------------------------------------
  step("clipboard round trip: @ctx file reads back a numbered response", () => {
    setClip("@ctx file hello.txt");
    const res = runCtx(["read"], { cwd: repo });
    check(res.status === 0, `ctx read exited ${res.status}: ${res.stderr}`);
    const copied = clip();
    check(copied.includes("# CTX RESPONSE"), "response marker missing");
    check(copied.includes("## Read summary"), "read summary section missing");
    check(copied.includes("1 | hello world"), "numbered file content missing");
  });

  step("clipboard round trip: combined status + file request", () => {
    setClip(["@ctx status", "@ctx file lib/math.ts"].join("\n"));
    const res = runCtx(["read"], { cwd: repo });
    check(res.status === 0, `ctx read exited ${res.status}: ${res.stderr}`);
    const copied = clip();
    check(copied.includes("# CTX RESPONSE"), "response marker missing");
    check(copied.includes("Branch: main"), "branch info missing from the status section");
    // `ctx init` just created the config files, so they show as untracked.
    check(copied.includes("Untracked: 2"), "untracked config files not reported");
    check(copied.includes(".ctx.toml"), ".ctx.toml missing from the untracked list");
    check(copied.includes("lib/math.ts"), "file section missing");
    check(copied.includes("1 | export const add"), "numbered file content missing");
  });

  // --- 4. search through the protocol (preferred backend) --------------------
  step("clipboard round trip: @ctx search returns matching lines", () => {
    setClip("@ctx search TODO");
    const res = runCtx(["read"], { cwd: repo });
    check(res.status === 0, `ctx read exited ${res.status}: ${res.stderr}`);
    const copied = clip();
    check(copied.includes("lib/math.ts:2 | // TODO: sum two numbers"), "search match missing from the response");
  });

  // --- 5. tagged multi-file patch: preview then apply -------------------------
  const patchProposal = () => {
    fixtureFile("hello.txt", "hello world\nhello world, updated\n");
    fixtureFile("lib/math.ts", [
      "export const add = (a: number, b: number): number => a + b;",
      "// DONE: sum two numbers",
      "",
    ].join("\n"));
    const patch = run("git", ["-C", repo, "diff"], { encoding: "utf8" });
    check(patch.status === 0 && patch.stdout.includes("diff --git"), "fixture patch generation failed");
    run("git", ["-C", repo, "checkout", "--", "."], { encoding: "utf8" });
    return ["@ctx patch", "```diff", patch.stdout.trimEnd(), "```"].join("\n");
  };

  step("patch preview via ctx read changes nothing", () => {
    const proposal = patchProposal();
    setClip(proposal);
    const res = runCtx(["read"], { cwd: repo });
    check(res.status === 0, `ctx read exited ${res.status}: ${res.stderr}`);
    const copied = clip();
    check(copied.includes("## Patch proposal — ready to apply"), "preview marker missing");
    check(copied.includes("- hello.txt (modified)"), "hello.txt target missing from the preview");
    check(copied.includes("- lib/math.ts (modified)"), "lib/math.ts target missing from the preview");
    check(copied.includes("Preflight: passed"), "preflight confirmation missing");
    check(readFileSync(join(repo, "hello.txt"), "utf8") === "hello world\n", "preview must not change hello.txt");
  });

  step("ctx apply applies the tagged multi-file patch", () => {
    const proposal = patchProposal();
    setClip(proposal);
    const res = runCtx(["apply"], { cwd: repo });
    check(res.status === 0, `ctx apply exited ${res.status}: ${res.stderr}`);
    const copied = clip();
    check(copied.includes("## Patch applied"), "applied marker missing");
    check(copied.includes("- hello.txt (modified)"), "hello.txt target missing from the applied response");
    check(copied.includes("- lib/math.ts (modified)"), "lib/math.ts target missing from the applied response");
    check(readFileSync(join(repo, "hello.txt"), "utf8") === "hello world\nhello world, updated\n", "hello.txt was not patched");
    check(readFileSync(join(repo, "lib/math.ts"), "utf8").includes("// DONE: sum two numbers"), "lib/math.ts was not patched");
  });

  // --- 6. post-write verification --------------------------------------------
  step("post-write verification: status + diff confirm the change", () => {
    setClip(["@ctx status", "@ctx diff"].join("\n"));
    const res = runCtx(["read"], { cwd: repo });
    check(res.status === 0, `ctx read exited ${res.status}: ${res.stderr}`);
    const copied = clip();
    check(copied.includes("Modified: 2"), "two modified files not reported");
    check(copied.includes("+hello world, updated"), "added line missing from the diff");
    check(copied.includes("-// TODO: sum two numbers"), "removed line missing from the diff");
  });

  // --- 7. visible failure cases -----------------------------------------------
  step("traversal request is refused without reading content", () => {
    setClip("@ctx file ../../etc/passwd");
    const res = runCtx(["read"], { cwd: repo });
    check(res.status !== 0, "traversal request must exit non-zero");
    const copied = clip();
    check(copied.includes("# CTX RESPONSE"), "refusal was not copied");
    check(/traversal|outside/i.test(copied), "refusal does not explain the traversal");
    // Fail closed: nothing from the target file may leak into the response.
    const target = process.platform === "win32" ? null : join(process.env.HOME ?? "", "..", "etc", "passwd");
    if (target !== null && existsSync(target)) {
      const firstLine = readFileSync(target, "utf8").split("\n", 1)[0];
      check(firstLine !== undefined && firstLine !== "", "could not read the traversal target");
      check(!copied.includes(firstLine), "target content leaked into the refusal");
    }
  });

  step("ctx apply without a proposal refuses with a structured diagnostic", () => {
    setClip("ordinary chat text without any @ctx proposal");
    const res = runCtx(["apply"], { cwd: repo });
    check(res.status !== 0, "apply without a proposal must exit non-zero");
    const copied = clip();
    check(copied.includes("# CTX RESPONSE"), "refusal not copied");
    check(copied.includes("## Request refused"), "structured refusal header missing");
    check(copied.includes("no @ctx request found"), "refusal does not explain the missing request");
  });

  // --- 8. search backend behaviour per platform --------------------------------
  if (process.platform === "win32") {
    step("search falls back to findstr when ripgrep is hidden from PATH", () => {
      const where = run("where", ["rg"], { encoding: "utf8" });
      const dirs = new Set((process.env.PATH ?? "").split(";").filter(Boolean));
      if (where.status === 0) {
        for (const line of where.stdout.split(/\r?\n/)) {
          const path = line.trim();
          if (path !== "") {
            dirs.delete(dirname(path));
          }
        }
      }
      const hiddenPath = [...dirs].join(";");

      const doctor = runCtx(["doctor"], { cwd: repo, env: { PATH: hiddenPath } });
      check(doctor.status === 0, `ctx doctor must still pass on win32 without rg (${doctor.stdout} ${doctor.stderr})`);
      check(doctor.stdout.includes("Windows-native search fallback"), "doctor does not report the findstr fallback");

      setClip("@ctx search export const add");
      const res = runCtx(["read"], { cwd: repo, env: { PATH: hiddenPath } });
      check(res.status === 0, `ctx search via findstr failed: ${res.stderr}`);
      check(clip().includes("lib/math.ts:1 | export const add"), "findstr fallback did not return the expected match");
    });
  } else {
    step("missing ripgrep yields an actionable failure (checked when rg is absent)", () => {
      const which = run("which", ["rg"], { encoding: "utf8" });
      if (which.status !== 0) {
        const res = runCtx(["search", "TODO"], { cwd: repo });
        check(res.status !== 0, "search without ripgrep must exit non-zero");
        check((res.stderr + res.stdout).includes("ripgrep is required"), "actionable ripgrep message missing");
      }
    });
  }

  console.log(`\n[e2e] All ${PASSED.length} steps passed on ${process.platform}.`);
} finally {
  rmSync(work, { recursive: true, force: true });
}