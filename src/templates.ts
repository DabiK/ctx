/**
 * Generated project configuration templates written by `ctx init`.
 *
 * `.ctx.toml` is the project configuration; `.ctxignore` decides ordinary
 * context exclusions (`.gitignore` does not). The ignore template contains
 * prudent generated-artifact and sensitive-file entries.
 */

import { CONFIG_FILE_NAME, IGNORE_FILE_NAME, PRODUCT_NAME } from "./branding.js";

/** Content of the generated project configuration file (`.ctx.toml`). */
export function buildConfigTemplate(): string {
  return [
    `# ${PRODUCT_NAME} project configuration`,
    ``,
    `# Allowed external directories from which ctx may read, in addition to the`,
    `# Git repository root. Paths must be absolute; symlinks are resolved and`,
    `# must stay inside an allowed root.`,
    `# allowed_roots = ["/absolute/path/to/related-project"]`,
    ``,
    `# Line numbering for copied file content (true by default).`,
    `# line_numbers = true`,
    ``,
    `# Explicitly configured sensitive paths: never copied or written without an`,
    `# explicit override, regardless of ignore rules.`,
    `# sensitive_paths = [".env", "secrets/"]`,
  ].join("\n") + "\n";
}

/** Content of the generated context-ignore template (`.ctxignore`). */
export function buildIgnoreTemplate(): string {
  return [
    `# ${PRODUCT_NAME} context exclusions (.ctxignore).`,
    `# Files and directories listed here are never included in outbound context.`,
    `# Git-style patterns; each line is one pattern.`,
    ``,
    `# VCS and tooling`,
    `.git/`,
    ``,
    `# Generated artifacts`,
    `node_modules/`,
    `dist/`,
    `build/`,
    `out/`,
    `target/`,
    `coverage/`,
    `*.tsbuildinfo`,
    ``,
    `# Logs`,
    `*.log`,
    ``,
    `# Local environment and credentials (sensitive)`,
    `.env`,
    `.env.*`,
    `*.pem`,
    `*.key`,
    `id_rsa*`,
    `id_ed25519*`,
    ``,
    `# OS and editor junk`,
    `.DS_Store`,
    `Thumbs.db`,
    `.idea/`,
    `.vscode/`,
  ].join("\n") + "\n";
}
