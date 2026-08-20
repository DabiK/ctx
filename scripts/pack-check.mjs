#!/usr/bin/env node
/**
 * Package check: prove the npm package exposes a working `ctx` executable.
 *
 * Packs the built CLI with `npm pack`, installs the tarball into a fresh
 * temporary consumer directory (a real install, not the repo checkout), and
 * runs the installed `ctx` bin. Used by CI and by `prepublishOnly`.
 *
 * Exit code is 0 only when the version, help, and the `ctx doctor` path all
 * work from the installed package.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL("..", import.meta.url)));
const NAME = "ctx-cli";
const EXPECTED_VERSION = "ctx 0.1.0";

const fail = (message) => {
  console.error(`[pack:check] FAIL: ${message}`);
  process.exit(1);
};

function npm(args, opts = {}) {
  const cmd = process.platform === "win32" ? "npm.cmd" : "npm";
  return spawnSync(cmd, args, {
    ...opts,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
}

function check(condition, message) {
  if (!condition) {
    fail(message);
  }
}

let tarball = null;
let consumer = null;
try {
  // 1. Pack the built CLI into a tarball (npm resolves `files` from package.json).
  const pack = npm(["pack", "--json"], { cwd: ROOT });
  check(pack.status === 0, `npm pack failed: ${pack.stderr}`);
  const files = JSON.parse(pack.stdout);
  const filename = Array.isArray(files) ? files[0]?.filename : undefined;
  check(typeof filename === "string", "npm pack --json returned no tarball filename");
  tarball = join(ROOT, filename);

  // 2. Install the tarball into a fresh consumer directory.
  consumer = mkdtempSync(join(tmpdir(), "ctx-consumer-"));
  const install = npm(["install", "--no-save", tarball], { cwd: consumer });
  check(install.status === 0, `npm install of the tarball failed: ${install.stderr}`);

  // 3. Run the installed `ctx` executable (the bin shim npm links).
  const binDir = join(consumer, "node_modules", ".bin");
  const bin = process.platform === "win32" ? join(binDir, "ctx.cmd") : join(binDir, "ctx");
  check(existsSync(bin), `installed package has no ctx bin shim at ${bin}`);

  const version = spawnSync(bin, ["--version"], {
    cwd: consumer,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  check(version.status === 0, `ctx --version failed: ${version.stderr}`);
  check(
    version.stdout.trim() === EXPECTED_VERSION,
    `ctx --version printed ${JSON.stringify(version.stdout.trim())}, expected ${EXPECTED_VERSION}`,
  );

  const help = spawnSync(bin, ["--help"], {
    cwd: consumer,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  check(help.status === 0, `ctx --help failed: ${help.stderr}`);
  check(help.stdout.includes("Usage: ctx"), "ctx --help does not show the ctx usage line");

  const doctor = spawnSync(bin, ["doctor"], {
    cwd: consumer,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  check(doctor.status !== 0, "ctx doctor outside a repository must exit non-zero");
  check(doctor.stdout.includes("Not inside a Git repository"), "doctor recovery message missing outside a repository");

  console.log(`[pack:check] PASS ${filename} installs and runs (${EXPECTED_VERSION}) on ${process.platform}.`);
} finally {
  if (tarball !== null && existsSync(tarball)) {
    rmSync(tarball, { force: true });
  }
  if (consumer !== null) {
    rmSync(consumer, { recursive: true, force: true });
  }
}