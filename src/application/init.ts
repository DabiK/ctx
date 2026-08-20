/**
 * `ctx init` application use case.
 *
 * Creates missing project configuration/ignore files (never overwriting
 * without an explicit force option), then copies the generated protocol
 * prompt plus the repository-root AGENTS.md (or its reported absence) to the
 * clipboard. Depends only on application ports — no Node/OS imports.
 */

import { CONFIG_FILE_NAME, IGNORE_FILE_NAME, PRODUCT_NAME } from "../branding.js";
import { buildConfigTemplate, buildIgnoreTemplate } from "../templates.js";
import type { ClipboardPort, FsPort, GitPort, TerminalPort } from "./ports.js";
import {
  EXIT_FAILURE,
  EXIT_OK,
  buildClipboardPayload,
  copyPayload,
  requireGitRoot,
} from "./common.js";

/** Result of the init config-file step for one file. */
type FileAction = "created" | "left-unchanged" | "overwritten";

export interface InitOptions {
  force: boolean;
}

export class InitUseCase {
  constructor(
    private readonly clipboard: ClipboardPort,
    private readonly terminal: TerminalPort,
    private readonly git: GitPort,
    private readonly fs: FsPort,
  ) {}

  async init(opts: InitOptions): Promise<number> {
    const root = await requireGitRoot(this.git, this.fs, this.terminal);
    if (root === null) {
      return EXIT_FAILURE;
    }

    const configPath = this.fs.join(root, CONFIG_FILE_NAME);
    const ignorePath = this.fs.join(root, IGNORE_FILE_NAME);
    const configAction = this.createIfMissing(
      configPath,
      buildConfigTemplate(),
      opts.force,
      PRODUCT_NAME + " project configuration",
    );
    const ignoreAction = this.createIfMissing(
      ignorePath,
      buildIgnoreTemplate(),
      opts.force,
      "context ignore rules",
    );

    this.terminal.info(`Initialised ${PRODUCT_NAME} in ${root}`);
    for (const [file, action] of [
      [CONFIG_FILE_NAME, configAction],
      [IGNORE_FILE_NAME, ignoreAction],
    ] as const) {
      this.terminal.info(`  ${this.describeAction(file, action)}`);
    }

    const payload = buildClipboardPayload(root, this.fs, false);
    await copyPayload(payload, this.clipboard, this.terminal);
    return EXIT_OK;
  }

  /** Create a missing file, or overwrite it when `force` is set. */
  private createIfMissing(
    path: string,
    content: string,
    force: boolean,
    label: string,
  ): FileAction {
    if (this.fs.exists(path)) {
      if (!force) {
        return "left-unchanged";
      }
      this.fs.writeText(path, content);
      return "overwritten";
    }
    this.fs.writeText(path, content);
    return "created";
  }

  private describeAction(file: string, action: FileAction): string {
    switch (action) {
      case "created":
        return `${file}: created`;
      case "overwritten":
        return `${file}: overwritten (--force)`;
      case "left-unchanged":
        return `${file}: exists, left unchanged (use --force to overwrite)`;
    }
  }
}
