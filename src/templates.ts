/**
 * Generated project configuration templates written by `ctx init`.
 *
 * `.ctx.toml` is the project configuration; `.ctxignore` decides ordinary
 * context exclusions (`.gitignore` does not). The ignore template contains
 * prudent generated-artifact and sensitive-file entries.
 */

import { CONFIG_FILE_NAME, IGNORE_FILE_NAME, PRODUCT_NAME } from "./branding.js";
import { MAX_BATCH_BYTES, MAX_FILE_BYTES } from "./config.js";

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
    ``,
    `# Discovery limits (bounds on outbound context, all optional):`,
    `# tree_depth = 3        # depth of \`tree\` (1-10)`,
    `# inspect_depth = 2     # depth of the tree inside \`inspect\` (1-10)`,
    `# max_results = 100     # per-operation result cap for tree/glob/inspect/search (1-1000)`,
    ``,
    `# Budget limits (bounds on copied context, all optional):`,
    `# max_file_bytes = 262144    # per-file cap; larger reads are omitted and explained (1-${MAX_FILE_BYTES})`,
    `# max_batch_bytes = 1048576  # total copied response cap; oversized responses fail closed (1-${MAX_BATCH_BYTES})`,
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
