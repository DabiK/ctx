#!/usr/bin/env node
/**
 * ctx CLI entry point — the inbound adapter.
 *
 * Parses argv without external dependencies and dispatches each command to
 * its own application use case (init, prompt, doctor, file, files, read).
 * `runCli` takes the platform ports so tests can drive the full CLI surface
 * with fakes.
 */

import { EXECUTABLE_NAME, PRODUCT_NAME, VERSION } from "./branding.js";
import { MAX_DEPTH, MAX_RESULTS } from "./config.js";
import type { PlatformPorts } from "./application/ports.js";
import { DoctorUseCase } from "./application/doctor.js";
import { DiscoveryUseCase } from "./application/discovery.js";
import { GitUseCase } from "./application/git.js";
import { InitUseCase } from "./application/init.js";
import { PromptUseCase } from "./application/prompt.js";
import { ReadUseCase } from "./application/read.js";
import { RequestUseCase } from "./application/request.js";
import { SearchUseCase } from "./application/search.js";
import { WatchUseCase } from "./application/watch.js";
import { WriteUseCase } from "./application/write.js";
import { isSafeRevision, isSafeShowPath } from "./protocol.js";
import { SystemClipboard } from "./platform/clipboard.js";
import { SystemClock } from "./platform/clock.js";
import { SystemEnv } from "./platform/env.js";
import { SystemFs } from "./platform/fs.js";
import { SystemGit } from "./platform/git.js";
import { createSearchPort } from "./platform/search.js";
import { SystemTerminal } from "./platform/terminal.js";
import { SystemTui } from "./platform/tui.js";

const EXIT_OK = 0;
const EXIT_FAILURE = 1;
const EXIT_USAGE = 2;

type Command =
  | "init"
  | "prompt"
  | "doctor"
  | "file"
  | "files"
  | "read"
  | "tree"
  | "glob"
  | "inspect"
  | "search"
  | "status"
  | "changed"
  | "diff"
  | "log"
  | "show"
  | "apply"
  | "watch";

interface ParsedArgs {
  command: Command | null;
  help: boolean;
  version: boolean;
  force: boolean;
  compact: boolean;
  copy: boolean;
  allowSensitive: boolean;
  staged: boolean;
  depth: number | null;
  limit: number | null;
  args: string[];
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
    `  file      Read one repository file, optionally a bounded line range.`,
    `  files     Read several repository files in one response.`,
    `  tree      Print a bounded directory tree.`,
    `  glob      List repository files matching a pattern.`,
    `  inspect   Print a bounded tree plus principal files and module metadata.`,
    `  search    Search repository content (ripgrep, findstr fallback).`,
    `  status    Print branch and staged/modified/untracked/deleted files.`,
    `  changed   Print the changed-file list (optionally scoped to a path).`,
    `  diff      Print the working-tree or staged diff (optionally scoped).`,
    `  log       Print recent commits (optionally scoped to a path).`,
    `  show      Print one file's content at a revision (git show rev:path).`,
    `  read      Execute the @ctx request in the clipboard and copy the response back.`,
    `  apply     Apply the tagged patch/write/sequence proposal in the clipboard.`,
    `  watch     Foreground clipboard watcher TUI (safe/auto modes).`,
    `  help      Show this help.`,
    ``,
    `Options:`,
    `  -h, --help           Show help for a command or the whole CLI.`,
    `  -v, --version        Print the version.`,
    `  -c, --copy           Copy the protocol response to the clipboard (file/files/tree/glob/inspect/search).`,
    `  -s, --allow-sensitive  Permit sensitive path/content disclosure for this run.`,
    `  --staged             Show the staged diff (diff).`,
    `  --depth N            Tree depth (1-${MAX_DEPTH}, tree/inspect).`,
    `  --limit N            Result limit (1-${MAX_RESULTS}, glob/search/log).`,
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
    case "file":
      return [
        `Usage: ${EXECUTABLE_NAME} file <path>[:<start>-<end>] [--copy] [--allow-sensitive]`,
        ``,
        `Read one repository-relative file, optionally a bounded line range`,
        `(also: :<line>, :<start>- to the end, :-<end> from line 1). Paths are`,
        `resolved inside the repository root; traversal, absolute paths, ignored,`,
        `and sensitive files are refused. Prints the selected lines to the terminal`,
        `and copies the stable protocol response only with --copy.`,
        ``,
        `Options:`,
        `  --copy              Copy the # CTX RESPONSE block to the clipboard.`,
        `  --allow-sensitive   Disclose sensitive paths/content for this run.`,
      ].join("\n");
    case "files":
      return [
        `Usage: ${EXECUTABLE_NAME} files <path[:range]>... [--copy] [--allow-sensitive]`,
        ``,
        `Read several repository-relative files in one response. Each path may`,
        `carry a bounded line range. Omitted and refused items are explained;`,
        `exits non-zero when nothing could be read.`,
        ``,
        `Options:`,
        `  --copy              Copy the # CTX RESPONSE block to the clipboard.`,
        `  --allow-sensitive   Disclose sensitive paths/content for this run.`,
      ].join("\n");
    case "read":
      return [
        `Usage: ${EXECUTABLE_NAME} read [--allow-sensitive]`,
        ``,
        `Execute the @ctx request found in the clipboard and copy the stable protocol`,
        `response back. Requests may be plain @ctx lines or a @ctx batch block (one`,
        `@ctx line per operation, in order). This build supports file, files, tree,`,
        `glob, inspect, search, status, changed, diff, log, show, and batch. Malformed,`,
        `denied, or oversized requests produce a structured recovery response instead`,
        `of silently truncated content.`,
        ``,
        `A tagged write proposal (@ctx patch + a unified multi-file diff, @ctx write`,
        `<path> + a full-file body, or @ctx sequence) is validated and preflighted`,
        `here without changing anything — the preview is copied and the actual write`,
        `requires the explicit ${EXECUTABLE_NAME} apply command.`,
        ``,
        `Options:`,
        `  --allow-sensitive   Disclose sensitive paths/content for this run.`,
      ].join("\n");
    case "tree":
      return [
        `Usage: ${EXECUTABLE_NAME} tree [--depth N] [--copy] [--allow-sensitive]`,
        ``,
        `Print a bounded directory tree from the repository root. Depth and entry`,
        `limits come from the project configuration (tree_depth, max_results) and`,
        `are reported explicitly when hit.`,
        ``,
        `Options:`,
        `  --depth N           Tree depth (1-${MAX_DEPTH}, overrides tree_depth).`,
        `  --copy              Copy the # CTX RESPONSE block to the clipboard.`,
        `  --allow-sensitive   Disclose sensitive paths/content for this run.`,
      ].join("\n");
    case "glob":
      return [
        `Usage: ${EXECUTABLE_NAME} glob <pattern> [--limit N] [--copy] [--allow-sensitive]`,
        ``,
        `List repository files matching a gitignore-style glob (e.g. \`src/**/*.ts\`,`,
        `\`*.md\`). Ignored and sensitive paths are never listed.`,
        ``,
        `Options:`,
        `  --limit N           Max matches (1-${MAX_RESULTS}, overrides max_results).`,
        `  --copy              Copy the # CTX RESPONSE block to the clipboard.`,
        `  --allow-sensitive   Disclose sensitive paths/content for this run.`,
      ].join("\n");
    case "inspect":
      return [
        `Usage: ${EXECUTABLE_NAME} inspect [path] [--depth N] [--copy] [--allow-sensitive]`,
        ``,
        `Print a bounded directory tree (default depth 2) plus the repo-root`,
        `principal files (package.json metadata, README, AGENTS.md, ...). With an`,
        `optional repository-relative path, the tree is scoped to that directory.`,
        ``,
        `Options:`,
        `  --depth N           Tree depth (1-${MAX_DEPTH}, overrides inspect_depth).`,
        `  --copy              Copy the # CTX RESPONSE block to the clipboard.`,
        `  --allow-sensitive   Disclose sensitive paths/content for this run.`,
      ].join("\n");
    case "search":
      return [
        `Usage: ${EXECUTABLE_NAME} search <query>... [--limit N] [--copy] [--allow-sensitive]`,
        ``,
        `Search repository content with ripgrep when available (findstr on Windows`,
        `otherwise). Results honour .ctxignore, allowed roots, and sensitive rules.`,
        ``,
        `Options:`,
        `  --limit N           Max matches (1-${MAX_RESULTS}, overrides max_results).`,
        `  --copy              Copy the # CTX RESPONSE block to the clipboard.`,
        `  --allow-sensitive   Disclose sensitive paths/content for this run.`,
      ].join("\n");
    case "status":
      return [
        `Usage: ${EXECUTABLE_NAME} status [--copy] [--allow-sensitive]`,
        ``,
        `Print the current branch and changed files bucketed into staged, modified,`,
        `untracked, and deleted. Read-only Git context.`,
        ``,
        `Options:`,
        `  --copy              Copy the # CTX RESPONSE block to the clipboard.`,
        `  --allow-sensitive   Disclose sensitive paths/content for this run.`,
      ].join("\n");
    case "changed":
      return [
        `Usage: ${EXECUTABLE_NAME} changed [path] [--copy] [--allow-sensitive]`,
        ``,
        `Print the flat changed-file list with each file's state bucket. With an`,
        `optional repository-relative path, only files under that path are listed.`,
        ``,
        `Options:`,
        `  --copy              Copy the # CTX RESPONSE block to the clipboard.`,
        `  --allow-sensitive   Disclose sensitive paths/content for this run.`,
      ].join("\n");
    case "diff":
      return [
        `Usage: ${EXECUTABLE_NAME} diff [--staged] [path] [--copy] [--allow-sensitive]`,
        ``,
        `Print the working-tree diff (or the staged diff with --staged), optionally`,
        `scoped to a repository-relative path, with file/insertion/deletion counts.`,
        ``,
        `Options:`,
        `  --staged            Show the staged diff instead of the working tree.`,
        `  --copy              Copy the # CTX RESPONSE block to the clipboard.`,
        `  --allow-sensitive   Disclose sensitive paths/content for this run.`,
      ].join("\n");
    case "log":
      return [
        `Usage: ${EXECUTABLE_NAME} log [path] [--limit N] [--copy] [--allow-sensitive]`,
        ``,
        `Print recent commits (short hash, date, subject), bounded by --limit or`,
        `the configured max_results. With an optional repository-relative path,`,
        `only commits touching that path are listed.`,
        ``,
        `Options:`,
        `  --limit N           Max commits (1-${MAX_RESULTS}, overrides max_results).`,
        `  --copy              Copy the # CTX RESPONSE block to the clipboard.`,
        `  --allow-sensitive   Disclose sensitive paths/content for this run.`,
      ].join("\n");
    case "show":
      return [
        `Usage: ${EXECUTABLE_NAME} show <rev> <path> [--copy] [--allow-sensitive]`,
        ``,
        `Print the content of <path> at revision <rev> (git show rev:path), read`,
        `from the object store. Revisions are restricted to HEAD (with ~N/^N),`,
        `hex commit hashes, and plain branch/tag names; paths must be`,
        `repository-relative and free of traversal and :/% characters.`,
        ``,
        `Options:`,
        `  --copy              Copy the # CTX RESPONSE block to the clipboard.`,
        `  --allow-sensitive   Disclose sensitive paths/content for this run.`,
      ].join("\n");
    case "apply":
      return [
        `Usage: ${EXECUTABLE_NAME} apply [--allow-sensitive]`,
        ``,
        `Apply the tagged write proposal found in the clipboard: @ctx patch (one`,
        `multi-file unified diff), @ctx write <path> (a full-file body), or @ctx`,
        `sequence (the write followed by verification reads that run only after`,
        `it succeeds). Paths are re-validated against the repository boundary`,
        `(repository-relative, inside the repo root, .ctxignore and sensitive`,
        `rules) and patches are preflighted with git apply --check before any`,
        `change. Refused proposals change no files and copy a structured`,
        `diagnostic instead. Git is the recovery path (git apply -R reverses).`,
        ``,
        `Options:`,
        `  --allow-sensitive   Permit writing sensitive paths/content for this run.`,
      ].join("\n");
    case "watch":
      return [
        `Usage: ${EXECUTABLE_NAME} watch [--allow-sensitive]`,
        ``,
        `Launch the foreground clipboard watcher TUI. It observes clipboard`,
        `changes, ignores ${PRODUCT_NAME}'s own responses and duplicate clipboard`,
        `content (loop prevention), and surfaces tagged @ctx patch/write/sequence`,
        `proposals as pending writes for an explicit action.`,
        ``,
        `Keys: m toggle mode (safe/auto), e command entry, a apply pending write,`,
        `c cancel pending write, p preview pending write, q quit.`,
        ``,
        `Safe mode confirms read requests and proposed writes; auto mode runs`,
        `valid reads automatically but keeps writes awaiting an explicit action.`,
        `The command entry executes supported read operations and copies their`,
        `structured response.`,
        ``,
        `Options:`,
        `  --allow-sensitive   Permit sensitive path/content disclosure for this run.`,
      ].join("\n");
  }
}

/**
 * Parse argv (excluding the node and script entries). Unknown commands or
 * options produce `null`; the caller prints usage and returns EXIT_USAGE.
 */
export function parseArgs(argv: string[]): { parsed: ParsedArgs } | { error: string } {
  const parsed: ParsedArgs = {
    command: null,
    help: false,
    version: false,
    force: false,
    compact: false,
    copy: false,
    allowSensitive: false,
    staged: false,
    depth: null,
    limit: null,
    args: [],
  };
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg === "--version" || arg === "-v") {
      parsed.version = true;
    } else if (arg === "--force") {
      parsed.force = true;
    } else if (arg === "--compact") {
      parsed.compact = true;
    } else if (arg === "--copy" || arg === "-c") {
      parsed.copy = true;
    } else if (arg === "--allow-sensitive" || arg === "-s") {
      parsed.allowSensitive = true;
    } else if (arg === "--staged") {
      parsed.staged = true;
    } else if (arg === "--depth" || arg === "--limit") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { error: `${arg} requires a value` };
      }
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1) {
        return { error: `${arg} requires a positive integer (got \`${value}\`)` };
      }
      if (arg === "--depth") {
        if (n > MAX_DEPTH) {
          return { error: `--depth must be between 1 and ${MAX_DEPTH}` };
        }
        parsed.depth = n;
      } else {
        if (n > MAX_RESULTS) {
          return { error: `--limit must be between 1 and ${MAX_RESULTS}` };
        }
        parsed.limit = n;
      }
      i++;
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
  if (
    command !== "init" &&
    command !== "prompt" &&
    command !== "doctor" &&
    command !== "file" &&
    command !== "files" &&
    command !== "read" &&
    command !== "tree" &&
    command !== "glob" &&
    command !== "inspect" &&
    command !== "search" &&
    command !== "status" &&
    command !== "changed" &&
    command !== "diff" &&
    command !== "log" &&
    command !== "show" &&
    command !== "apply" &&
    command !== "watch" &&
    command !== "help"
  ) {
    return { error: `Unknown command: ${command}` };
  }
  if (command === "help") {
    parsed.help = true;
    return { parsed };
  }
  parsed.command = command;
  parsed.args = positional.slice(1);

  // Help short-circuits path-count validation (`ctx file --help`).
  if (parsed.help) {
    return { parsed };
  }

  if (command === "file" && parsed.args.length !== 1) {
    return { error: `file accepts exactly one path (got ${parsed.args.length})` };
  }
  if (command === "files" && parsed.args.length === 0) {
    return { error: `files requires at least one path` };
  }
  if (command === "glob" && parsed.args.length !== 1) {
    return { error: `glob requires exactly one pattern (got ${parsed.args.length})` };
  }
  if (command === "inspect" && parsed.args.length > 1) {
    return { error: `inspect accepts at most one path (got ${parsed.args.length})` };
  }
  if (command === "search" && parsed.args.length === 0) {
    return { error: `search requires at least one query term` };
  }
  if (command === "changed" && parsed.args.length > 1) {
    return { error: `changed accepts at most one path (got ${parsed.args.length})` };
  }
  if (command === "diff" && parsed.args.length > 1) {
    return { error: `diff accepts at most one path (got ${parsed.args.length})` };
  }
  if (command === "log" && parsed.args.length > 1) {
    return { error: `log accepts at most one path (got ${parsed.args.length})` };
  }
  if (command === "show") {
    if (parsed.args.length !== 2) {
      return { error: `show requires exactly <rev> and <path> (got ${parsed.args.length})` };
    }
    const rev = parsed.args[0] ?? "";
    const path = parsed.args[1] ?? "";
    if (!isSafeRevision(rev)) {
      return {
        error:
          `unsafe revision \`${rev}\` — show accepts only HEAD (with ~N/^N), ` +
          `hex commit hashes, or plain branch/tag names`,
      };
    }
    if (!isSafeShowPath(path)) {
      return {
        error:
          `unsafe path \`${path}\` — show paths must be repository-relative ` +
          `and free of traversal and \`:\`/\`%\` characters`,
      };
    }
  }
  if (
    (command === "init" ||
      command === "prompt" ||
      command === "doctor" ||
      command === "read" ||
      command === "apply" ||
      command === "watch" ||
      command === "tree" ||
      command === "status") &&
    parsed.args.length > 0
  ) {
    return { error: `Unexpected argument: ${parsed.args[0]}` };
  }
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
    case "file": {
      const reader = new ReadUseCase(clipboard, terminal, git, fs);
      return reader.file(parsed.args[0] ?? "", {
        copy: parsed.copy,
        allowSensitive: parsed.allowSensitive,
        protocol: false,
      });
    }
    case "files": {
      const reader = new ReadUseCase(clipboard, terminal, git, fs);
      return reader.files(parsed.args, {
        copy: parsed.copy,
        allowSensitive: parsed.allowSensitive,
        protocol: false,
      });
    }
    case "tree": {
      const discovery = new DiscoveryUseCase(clipboard, terminal, git, fs);
      return discovery.tree(parsed.depth, {
        copy: parsed.copy,
        allowSensitive: parsed.allowSensitive,
        protocol: false,
      });
    }
    case "glob": {
      const discovery = new DiscoveryUseCase(clipboard, terminal, git, fs);
      return discovery.glob(parsed.args[0] ?? "", {
        copy: parsed.copy,
        allowSensitive: parsed.allowSensitive,
        protocol: false,
        limit: parsed.limit,
      });
    }
    case "inspect": {
      const discovery = new DiscoveryUseCase(clipboard, terminal, git, fs);
      return discovery.inspect(parsed.args[0] ?? null, {
        copy: parsed.copy,
        allowSensitive: parsed.allowSensitive,
        protocol: false,
        depth: parsed.depth,
      });
    }
    case "search":
      return runSearch(ports, parsed);
    case "status": {
      const gitOps = new GitUseCase(clipboard, terminal, git, fs);
      return gitOps.status({
        copy: parsed.copy,
        allowSensitive: parsed.allowSensitive,
        protocol: false,
      });
    }
    case "changed": {
      const gitOps = new GitUseCase(clipboard, terminal, git, fs);
      return gitOps.changed(parsed.args[0] ?? null, {
        copy: parsed.copy,
        allowSensitive: parsed.allowSensitive,
        protocol: false,
      });
    }
    case "diff": {
      const gitOps = new GitUseCase(clipboard, terminal, git, fs);
      return gitOps.diff(parsed.args[0] ?? null, parsed.staged, {
        copy: parsed.copy,
        allowSensitive: parsed.allowSensitive,
        protocol: false,
      });
    }
    case "log": {
      const gitOps = new GitUseCase(clipboard, terminal, git, fs);
      return gitOps.log(parsed.args[0] ?? null, {
        copy: parsed.copy,
        allowSensitive: parsed.allowSensitive,
        protocol: false,
        limit: parsed.limit,
      });
    }
    case "show": {
      const gitOps = new GitUseCase(clipboard, terminal, git, fs);
      return gitOps.show(parsed.args[0] ?? "", parsed.args[1] ?? "", {
        copy: parsed.copy,
        allowSensitive: parsed.allowSensitive,
        protocol: false,
      });
    }
    case "read":
      return runRead(ports, parsed);
    case "apply": {
      const { clipboard, terminal, git, fs, search } = ports;
      return new WriteUseCase(clipboard, terminal, git, fs, search).apply({
        allowSensitive: parsed.allowSensitive,
      });
    }
    case "watch": {
      const { clipboard, terminal, git, fs, search, tui, clock } = ports;
      return new WatchUseCase(clipboard, terminal, git, fs, search, tui, clock).watch({
        allowSensitive: parsed.allowSensitive,
      });
    }
  }
}

/** Run `ctx search`, using the wired search backend (ripgrep or findstr). */
async function runSearch(
  ports: PlatformPorts,
  parsed: ParsedArgs,
): Promise<number> {
  const { clipboard, terminal, git, fs, search } = ports;
  return new SearchUseCase(clipboard, terminal, git, fs, search).search(
    parsed.args.join(" "),
    {
      copy: parsed.copy,
      allowSensitive: parsed.allowSensitive,
      protocol: false,
      limit: parsed.limit,
    },
  );
}

/** Run `ctx read`, using the wired search backend for discovery operations. */
async function runRead(ports: PlatformPorts, parsed: ParsedArgs): Promise<number> {
  const { clipboard, terminal, git, fs, search } = ports;
  return new RequestUseCase(clipboard, terminal, git, fs, search).read({
    allowSensitive: parsed.allowSensitive,
  });
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
    search: createSearchPort(env),
    tui: new SystemTui(),
    clock: new SystemClock(),
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