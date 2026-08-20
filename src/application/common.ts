/**
 * Shared helpers for the ctx application use cases.
 *
 * Pure application code: imports only domain modules, application ports, and
 * other application modules. No Node or operating-system imports.
 */

import { PRODUCT_NAME, RESPONSE_MARKER } from "../branding.js";
import { buildCompactPrompt, buildPrompt } from "../prompt.js";
import type { ClipboardPort, FsPort, GitPort, TerminalPort } from "./ports.js";
import { buildEnvelope, type ResponsePart } from "./response.js";

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;

/**
 * UTF-8 byte length of `text` (the same value `Buffer.byteLength` produces),
 * computed without any Node dependency so application code stays portable.
 */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code <= 0xffff) {
      bytes += 3;
    } else {
      bytes += 4;
    }
  }
  return bytes;
}

/**
 * Deterministic approximate token estimate (~4 bytes per token, the common
 * heuristic). Exported so budgets and response metadata stay consistent.
 */
export function estimateTokens(bytes: number): number {
  return Math.max(1, Math.round(bytes / 4));
}

/**
 * Resolve the repository root or report an actionable error and return `null`.
 * Returns `EXIT_FAILURE` intent through `null`; callers stop early.
 */
export async function requireGitRoot(
  git: GitPort,
  fs: FsPort,
  terminal: TerminalPort,
): Promise<string | null> {
  const root = await git.root(fs.cwd());
  if (root === null) {
    terminal.error(
      `${PRODUCT_NAME} requires a Git repository. Run it from inside a Git checkout.`,
    );
    return null;
  }
  return root;
}

/**
 * Build the clipboard payload: the generated protocol prompt plus the
 * repository-root AGENTS.md when present (or its reported absence).
 */
export function buildClipboardPayload(root: string, fs: FsPort, compact: boolean): string {
  const prompt = compact ? buildCompactPrompt() : buildPrompt();
  const agentsPath = fs.join(root, "AGENTS.md");
  const agents = fs.readText(agentsPath);

  let section: string;
  if (agents !== null) {
    section = [
      `# Repository instructions`,
      `The repository root contains AGENTS.md. Its content is included below verbatim`,
      `and takes precedence for project-local conventions.`,
      ``,
      `--- AGENTS.md ---`,
      agents.trimEnd(),
    ].join("\n");
  } else {
    section =
      `# Repository instructions\n` +
      `No AGENTS.md file is present at the repository root. Proceed without project-specific instructions.`;
  }

  return prompt + "\n\n" + section + "\n";
}

/** Copy `payload` to the clipboard, reporting failures, without announcing. */
export async function copyOrThrow(
  payload: string,
  clipboard: ClipboardPort,
  terminal: TerminalPort,
): Promise<void> {
  try {
    await clipboard.copy(payload);
  } catch (err) {
    const detail = err instanceof Error ? `: ${err.message}` : "";
    terminal.error(`Failed to copy to the clipboard${detail}`);
    throw err;
  }
}

/** Copy `payload` to the clipboard and report the result on the terminal. */
export async function copyPayload(
  payload: string,
  clipboard: ClipboardPort,
  terminal: TerminalPort,
): Promise<void> {
  await copyOrThrow(payload, clipboard, terminal);
  const bytes = utf8ByteLength(payload);
  terminal.info(
    `Protocol prompt copied to the clipboard (${bytes} bytes). ` +
      `Paste it in your chat; responses arrive as \`${RESPONSE_MARKER}\` blocks.`,
  );
}

/** Terminal line tagged with a check status, used by `ctx doctor`. */
export function report(
  terminal: TerminalPort,
  status: "ok" | "warn" | "fail",
  message: string,
): void {
  const tag = status === "ok" ? "[ok] " : status === "warn" ? "[warn] " : "[fail] ";
  terminal.info(tag + message);
}

/**
 * Shared tail of the discovery operations: copy the stable response on demand,
 * print the block (or a protocol summary line), and compute the exit code.
 */
export async function finishDiscoveryOp(
  exec: { part: ResponsePart; produced: boolean },
  opts: { copy: boolean; protocol: boolean },
  clipboard: ClipboardPort,
  terminal: TerminalPort,
): Promise<number> {
  if (opts.copy) {
    await copyOrThrow(
      buildEnvelope([`## ${exec.part.title}`, ...exec.part.lines]),
      clipboard,
      terminal,
    );
  }
  if (opts.protocol) {
    terminal.info(
      `${PRODUCT_NAME}: processed request — "${exec.part.title}" completed; ` +
        `${RESPONSE_MARKER} copied to the clipboard.`,
    );
  } else {
    for (const line of exec.part.lines) {
      terminal.info(line);
    }
    if (opts.copy) {
      terminal.info(`Protocol response (${RESPONSE_MARKER}) copied to the clipboard.`);
    }
  }
  return exec.produced ? EXIT_OK : EXIT_FAILURE;
}
