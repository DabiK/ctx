/**
 * `ctx doctor` application use case.
 *
 * Reports readiness of the Git repository, project configuration, clipboard
 * backend, and preferred search backend (ripgrep), with actionable failure
 * messages. Exits non-zero when an expected prerequisite is missing.
 * Depends only on application ports — no Node/OS imports.
 */

import { CONFIG_FILE_NAME, PRODUCT_NAME } from "../branding.js";
import type { EnvPort, FsPort, GitPort, TerminalPort } from "./ports.js";
import { EXIT_FAILURE, EXIT_OK, report } from "./common.js";

export class DoctorUseCase {
  constructor(
    private readonly terminal: TerminalPort,
    private readonly git: GitPort,
    private readonly fs: FsPort,
    private readonly env: EnvPort,
  ) {}

  async doctor(): Promise<number> {
    const root = await this.git.root(this.fs.cwd());

    // 1. Git repository
    let gitOk = false;
    if (root !== null) {
      gitOk = true;
      this.report("ok", `Git repository found at ${root}`);
    } else {
      this.report(
        "fail",
        `Not inside a Git repository — ${PRODUCT_NAME} requires one. ` +
          `Run \`git init\` (or open an existing checkout) and then \`${PRODUCT_NAME} init\`.`,
      );
    }

    // 2. Configuration
    const configPath = root !== null ? this.fs.join(root, CONFIG_FILE_NAME) : null;
    if (configPath !== null && this.fs.exists(configPath)) {
      this.report("ok", `${CONFIG_FILE_NAME} found at the repository root`);
    } else if (configPath !== null) {
      this.report(
        "warn",
        `${CONFIG_FILE_NAME} not present — run \`${PRODUCT_NAME} init\` to create the default configuration.`,
      );
    } else {
      this.report("warn", `Configuration not checked (no repository root).`);
    }

    // 3. Clipboard
    const clipboardAvailable = this.isClipboardAvailable();
    if (clipboardAvailable) {
      this.report(
        "ok",
        `Clipboard backend available${this.clipboardBackend() !== null ? ` (${this.clipboardBackend()})` : ""}`,
      );
    } else {
      this.report(
        "fail",
        `Clipboard backend not available — ${this.clipboardFailureHint()}`,
      );
    }

    // 4. Preferred search backend (ripgrep; Windows-native fallback only).
    const rgAvailable = this.env.executableAvailable("rg");
    if (rgAvailable) {
      this.report("ok", "ripgrep found — preferred search backend ready");
    } else if (this.env.platform === "win32") {
      this.report(
        "warn",
        "ripgrep not found — the Windows-native search fallback will be used.",
      );
    } else {
      this.report(
        "fail",
        "ripgrep not found — search requires it on this platform. " +
          `Install ripgrep (e.g. \`brew install ripgrep\`) or rerun \`${PRODUCT_NAME} doctor\`.`,
      );
    }

    const failed = !gitOk || !clipboardAvailable || (this.env.platform !== "win32" && !rgAvailable);
    this.terminal.info(
      failed
        ? `${PRODUCT_NAME} doctor: one or more prerequisites are missing — see the failures above.`
        : `${PRODUCT_NAME} doctor: all checks passed.`,
    );
    return failed ? EXIT_FAILURE : EXIT_OK;
  }

  private report(status: "ok" | "warn" | "fail", message: string): void {
    report(this.terminal, status, message);
  }

  private isClipboardAvailable(): boolean {
    return this.clipboardBackend() !== null;
  }

  private clipboardBackend(): string | null {
    if (this.env.platform === "darwin") {
      return this.env.executableAvailable("pbcopy") ? "pbcopy" : null;
    }
    if (this.env.platform === "win32") {
      return this.env.executableAvailable("powershell.exe") ? "powershell.exe" : null;
    }
    return null;
  }

  private clipboardFailureHint(): string {
    if (this.env.platform === "darwin") {
      return "pbcopy was not found on PATH (macOS ships it at /usr/bin/pbcopy).";
    }
    if (this.env.platform === "win32") {
      return "powershell.exe was not found on PATH (Windows ships it at C:\\Windows\\System32\\WindowsPowerShell).";
    }
    return `${this.env.platform} is not supported by the MVP; ctx supports macOS and Windows.`;
  }
}
