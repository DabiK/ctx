#!/usr/bin/env node
/**
 * ctx CLI entry point — the inbound adapter.
 *
 * Parses argv without external dependencies and dispatches each command to
 * its own application use case (init, prompt, doctor). `runCli` takes the
 * platform ports so tests can drive the full CLI surface with fakes.
 */

import { EXECUTABLE_NAME, PRODUCT_NAME, VERSION } from "./branding.js";
import type { PlatformPorts } from "./application/ports.js";
import { DoctorUseCase } from "./application/doctor.js";
import { InitUseCase } from "./application/init.js";
import { PromptUseCase } from "./application/prompt.js";
import { SystemClipboard } from "./platform/clipboard.js";
import { SystemEnv } from "./platform/env.js";
import { SystemFs } from "./platform/fs.js";
import { SystemGit } from "./platform/git.js";
import { SystemTerminal } from "./platform/terminal.js";

const EXIT_OK = 0;
const EXIT_FAILURE = 1;
const EXIT_USAGE = 2;

type Command = "init" | "prompt" | "doctor";

interface ParsedArgs {
  command: Command | null;
  help: boolean;
  version: boolean;
  force: boolean;
  compact: boolean;
}

function usage(): string {
  return [
    `${PRODUCT_NAME} ${VERSION} — local repository context runtime with the clipboard as transport.`,
    ``,
    `Usage: ${EXECUTABLE_NAME} <command> [options]`,
    ``,
    `Commands:`,
    `  init      Create missing project configuration and context-ignore files,`,
    `            then copy the protocol prompt (plus root AGENTS.md) to the clipboard.`,
    `  prompt    Regenerate and copy the protocol prompt (--compact for a shorter one).`,
    `  doctor    Report Git, clipboard, configuration, and search readiness.`,
    `  help      Show this help.`,
    ``,
    `Options:`,
    `  -h, --help     Show help for a command or the whole CLI.`,
    `  -v, --version  Print the version.`,
    ``,
    `Run \`${EXECUTABLE_NAME} <command> --help\` for command-specific help.`,
  ].join("\n");
}

function commandHelp(command: Command): string {
  switch (command) {
    case "init":
      return [
        `Usage: ${EXECUTABLE_NAME} init [--force]`,
        ``,
        `Create ${PRODUCT_NAME} project configuration (.ctx.toml) and context-ignore`,
        `(.ctxignore) files in the repository root. Existing files are never`,
        `overwritten unless --force is given. Then copy the generated LLM protocol`,
        `prompt plus the root AGENTS.md (or its reported absence) to the clipboard.`,
        ``,
        `Options:`,
        `  --force  Overwrite existing configuration and ignore files.`,
      ].join("\n");
    case "prompt":
      return [
        `Usage: ${EXECUTABLE_NAME} prompt [--compact]`,
        ``,
        `Regenerate the LLM protocol prompt and copy it to the clipboard (the same`,
        `content ${EXECUTABLE_NAME} init copies, including root AGENTS.md). Never creates`,
        `a prompt file in the project.`,
        ``,
        `Options:`,
        `  --compact  Copy the smaller compact protocol prompt.`,
      ].join("\n");
    case "doctor":
      return [
        `Usage: ${EXECUTABLE_NAME} doctor`,
        ``,
        `Report readiness of the Git repository, project configuration, clipboard`,
        `backend, and preferred search backend (ripgrep), with actionable failure`,
        `messages. Exits non-zero when an expected prerequisite is missing.`,
      ].join("\n");
  }
}

/**
 * Parse argv (excluding the node and script entries). Unknown commands or
 * options produce `null`; the caller prints usage and returns EXIT_USAGE.
 */
export function parseArgs(argv: string[]): { parsed: ParsedArgs } | { error: string } {
  const parsed: ParsedArgs = { command: null, help: false, version: false, force: false, compact: false };
  const positional: string[] = [];

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg === "--version" || arg === "-v") {
      parsed.version = true;
    } else if (arg === "--force") {
      parsed.force = true;
    } else if (arg === "--compact") {
      parsed.compact = true;
    } else if (arg.startsWith("-")) {
      return { error: `Unknown option: ${arg}` };
    } else {
      positional.push(arg);
    }
  }

  if (positional.length === 0) {
    return { parsed };
  }
  const command = positional[0];
  if (command !== "init" && command !== "prompt" && command !== "doctor" && command !== "help") {
    return { error: `Unknown command: ${command}` };
  }
  if (positional.length > 1) {
    return { error: `Unexpected argument: ${positional[1]}` };
  }
  if (command === "help") {
    parsed.help = true;
    return { parsed };
  }
  parsed.command = command;
  return { parsed };
}

/** Full CLI execution; returns the process exit code. */
export async function runCli(argv: string[], ports: PlatformPorts): Promise<number> {
  const { terminal } = ports;

  const result = parseArgs(argv);
  if ("error" in result) {
    terminal.error(result.error);
    terminal.error(usage());
    return EXIT_USAGE;
  }
  const { parsed } = result;

  if (parsed.version) {
    terminal.info(`${PRODUCT_NAME} ${VERSION}`);
    return EXIT_OK;
  }
  if (parsed.help) {
    terminal.info(parsed.command !== null ? commandHelp(parsed.command) : usage());
    return EXIT_OK;
  }
  if (parsed.command === null) {
    terminal.info(usage());
    return EXIT_OK;
  }

  const { clipboard, git, fs } = ports;
  switch (parsed.command) {
    case "init":
      return new InitUseCase(clipboard, terminal, git, fs).init({ force: parsed.force });
    case "prompt":
      return new PromptUseCase(clipboard, terminal, git, fs).prompt({ compact: parsed.compact });
    case "doctor":
      return new DoctorUseCase(terminal, git, fs, ports.env).doctor();
  }
}

/** Wire the real platform ports and run. */
export async function main(argv: string[]): Promise<number> {
  const env = new SystemEnv();
  const ports: PlatformPorts = {
    clipboard: new SystemClipboard(env),
    terminal: new SystemTerminal(),
    git: new SystemGit(),
    fs: new SystemFs(),
    env,
  };
  return runCli(argv, ports);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("cli.js")) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      process.stderr.write(`${PRODUCT_NAME}: ${detail}\n`);
      process.exitCode = EXIT_FAILURE;
    });
}
