/**
 * Controlled writes application use case (`@ctx patch`, `@ctx write`,
 * `@ctx sequence`, and the `ctx apply` command).
 *
 * A tagged write proposal in the clipboard is validated against the same
 * repository boundary as reads (repository-relative, inside the repository
 * root only, `.ctxignore` and sensitive-path rules, plus the `.ctx.toml`/
 * `.ctxignore` permission-boundary files) and against sensitive write
 * content. `ctx read` surfaces the validated proposal as a preview and
 * preflights patches with `git apply --check` without changing anything; the
 * explicit `ctx apply` command is the approval that actually applies the
 * proposal. A `@ctx sequence` applies its write first and runs its
 * verification reads only after the write succeeds; when the write is
 * refused or fails, the verification steps are skipped and the refusal says
 * why.
 *
 * Git is deliberately the recovery path: patches are applied with `git apply`
 * (reversible with `git apply -R`); ctx does not implement fuzzy repair,
 * partial application, backups, or persistent write history.
 */

import { CONFIG_FILE_NAME, PRODUCT_NAME, REQUEST_MARKER, RESPONSE_MARKER } from "../branding.js";
import { clampBatchBytes, parseProjectConfig, type ProjectConfig } from "../config.js";
import {
  describeReadOp,
  extractDiffTargets,
  isProposalRequest,
  parseRequestText,
  singleProposal,
  SUPPORTED_OPS,
  type ParsedOkRequest,
  type Proposal,
  type ReadOp,
} from "../protocol.js";
import { containsSensitiveContent, diffAddsSensitiveContent } from "../sensitive.js";
import { PathGuard } from "./boundary.js";
import { createCollector, type OpCollector } from "./collect.js";
import {
  EXIT_FAILURE,
  EXIT_OK,
  copyOrThrow,
  requireGitRoot,
  utf8ByteLength,
} from "./common.js";
import type {
  ClipboardPort,
  FsPort,
  GitPort,
  GitPatchResult,
  SearchPort,
  TerminalPort,
} from "./ports.js";
import {
  buildRefusalResponse,
  buildWriteAppliedResponse,
  buildWriteOversizedResponse,
  buildWritePreviewResponse,
  buildWriteRefusedResponse,
  type VerificationSection,
  type WriteTargetReport,
} from "./response.js";

export interface WriteOptions {
  allowSensitive: boolean;
}

/** Repository context shared by the write operations. */
interface WriteContext {
  root: string;
  config: ProjectConfig;
  guard: PathGuard;
}

/** Validation outcome: either a preview/applicable proposal or a refusal. */
interface ValidatedProposal {
  /** Refusal issues (target refusals are separate) — empty when applicable. */
  issues: string[];
  /** Change targets with their validation outcome. */
  targets: WriteTargetReport[];
  /** One-line status for the preview/applied responses. */
  statusNote: string;
  /** Preview-only note about the verification reads of a sequence. */
  verificationNote: string | null;
}

/** Result of building the preview/refusal response of a proposal (no copy). */
export interface PreviewOutcome {
  status: "preview" | "refused";
  code: number;
  /** The preview or refusal response text (caller decides whether to copy). */
  response: string;
  /** Human-readable proposal label ("Patch proposal", ...). */
  label: string;
  targets: WriteTargetReport[];
  statusNote: string;
}

/** Result of applying a proposal (the response is copied by the method). */
export interface ApplyOutcome {
  status: "applied" | "refused" | "failed";
  code: number;
  /** The copied response text (applied, refusal, or fail-closed oversized). */
  response: string;
  label: string;
  targets: WriteTargetReport[];
  statusNote: string;
}

export class WriteUseCase {
  private readonly collector: OpCollector;

  constructor(
    private readonly clipboard: ClipboardPort,
    private readonly terminal: TerminalPort,
    private readonly git: GitPort,
    private readonly fs: FsPort,
    search: SearchPort,
  ) {
    this.collector = createCollector(clipboard, terminal, git, fs, search);
  }

  /**
   * `ctx read` proposal path: validate and preflight the proposal found in the
   * clipboard request and copy a preview response. Nothing is changed; the
   * preview tells the LLM to run `ctx apply` for the actual write.
   */
  async preview(parsed: ParsedOkRequest, allowSensitive: boolean): Promise<number> {
    const proposal = singleProposal(parsed);
    if (proposal === null) {
      this.terminal.error(`${PRODUCT_NAME}: no write proposal found in the request.`);
      return EXIT_FAILURE;
    }
    const outcome = await this.previewParsed(proposal, allowSensitive);
    if (outcome === null) {
      return EXIT_FAILURE;
    }
    await copyOrThrow(outcome.response, this.clipboard, this.terminal);
    if (outcome.status === "refused") {
      this.terminal.error(
        `${PRODUCT_NAME}: ${outcome.label.toLowerCase()} refused — nothing was changed (refusal copied to the clipboard).`,
      );
    } else {
      this.terminal.info(
        `${PRODUCT_NAME}: ${outcome.label.toLowerCase()} validated and preflighted — apply it unchanged with ` +
          `\`${PRODUCT_NAME} apply\` (preview copied to the clipboard).`,
      );
    }
    return outcome.code;
  }

  /**
   * Validate and preflight an already-parsed proposal and build its preview or
   * refusal response text, without copying anything. Shared by `preview`
   * (which copies it) and the watcher (which surfaces it as a pending write
   * while the proposal stays in the clipboard). Returns `null` on an
   * infrastructure failure (already reported to the terminal).
   */
  async previewParsed(
    proposal: Proposal,
    allowSensitive: boolean,
  ): Promise<PreviewOutcome | null> {
    const ctx = await this.openContext(allowSensitive);
    if (ctx === null) {
      return null;
    }
    const validation = await this.validateProposal(proposal, ctx, allowSensitive);
    const label = proposalLabel(proposal);
    if (!this.applicable(validation)) {
      const issues = [...validation.issues];
      if (proposal.kind === "sequence") {
        issues.push(
          "Verification reads were skipped — the write proposal was refused before anything ran.",
        );
      }
      const response = buildWriteRefusedResponse(label, validation.targets, issues);
      return {
        status: "refused",
        code: EXIT_FAILURE,
        response,
        label,
        targets: validation.targets,
        statusNote: validation.statusNote,
      };
    }
    const response = buildWritePreviewResponse(
      label,
      validation.targets,
      validation.statusNote,
      validation.verificationNote,
    );
    return {
      status: "preview",
      code: EXIT_OK,
      response,
      label,
      targets: validation.targets,
      statusNote: validation.statusNote,
    };
  }

  /**
   * `ctx apply` — the explicit approval that actually applies a tagged write
   * proposal from the clipboard. Re-validates and re-preflights (the
   * clipboard may have changed), applies the write, and runs the verification
   * reads of a sequence only after the write succeeds.
   */
  async apply(opts: WriteOptions): Promise<number> {
    // Fail before touching the clipboard when there is no repository: apply
    // without a repository must report the actionable Git-root message and
    // copy nothing. The context is re-opened in `applyParsed` so the write
    // is re-validated against the current repository state.
    const preflight = await this.openContext(opts.allowSensitive);
    if (preflight === null) {
      return EXIT_FAILURE;
    }
    let requestText: string;
    try {
      requestText = await this.clipboard.read();
    } catch (err) {
      const detail = err instanceof Error ? `: ${err.message}` : "";
      this.terminal.error(`Failed to read the clipboard${detail}`);
      return EXIT_FAILURE;
    }
    const parsed = parseRequestText(requestText);
    if (!parsed.ok) {
      const response = buildRefusalResponse(parsed.reason, SUPPORTED_OPS);
      await copyOrThrow(response, this.clipboard, this.terminal);
      this.terminal.error(
        `${PRODUCT_NAME}: apply refused — ${parsed.reason} (refusal copied to the clipboard).`,
      );
      return EXIT_FAILURE;
    }
    if (!isProposalRequest(parsed)) {
      const response = buildRefusalResponse(
        `no write proposal found in the clipboard — expected a tagged \`${REQUEST_MARKER} patch\`, ` +
          `\`${REQUEST_MARKER} write\`, or \`${REQUEST_MARKER} sequence\``,
        SUPPORTED_OPS,
      );
      await copyOrThrow(response, this.clipboard, this.terminal);
      this.terminal.error(
        `${PRODUCT_NAME}: apply refused — no write proposal in the clipboard (refusal copied).`,
      );
      return EXIT_FAILURE;
    }
    const proposal = singleProposal(parsed);
    if (proposal === null) {
      return EXIT_FAILURE;
    }

    const outcome = await this.applyParsed(proposal, opts);
    if (outcome === null) {
      return EXIT_FAILURE;
    }
    if (outcome.status === "refused") {
      this.terminal.error(
        `${PRODUCT_NAME}: ${outcome.label.toLowerCase()} refused — nothing was changed (refusal copied to the clipboard).`,
      );
    } else if (outcome.status === "failed") {
      this.terminal.error(
        `${PRODUCT_NAME}: ${outcome.label.toLowerCase()} failed — nothing was changed (diagnostic copied to the clipboard).`,
      );
    } else {
      this.terminal.info(
        `${PRODUCT_NAME}: ${proposal.kind === "patch" ? "patch" : "write"} applied — ` +
          `${outcome.targets.length} file(s) changed; ${RESPONSE_MARKER} copied to the clipboard.`,
      );
    }
    return outcome.code;
  }

  /**
   * Apply an already-parsed proposal: re-validate, re-preflight, apply the
   * write, run sequence verification reads only after the write succeeds, and
   * copy the response (applied, refusal, or fail-closed oversized). Returns
   * `null` on an infrastructure failure (already reported to the terminal).
   * Shared by `apply` (which reads the proposal from the clipboard) and the
   * watcher (which applies a pending write surfaced in the TUI).
   */
  async applyParsed(
    proposal: Proposal,
    opts: WriteOptions,
  ): Promise<ApplyOutcome | null> {
    const ctx = await this.openContext(opts.allowSensitive);
    if (ctx === null) {
      return null;
    }

    const validation = await this.validateProposal(proposal, ctx, opts.allowSensitive);
    const label = proposalLabel(proposal);
    if (!this.applicable(validation)) {
      const issues = [...validation.issues];
      if (proposal.kind === "sequence") {
        issues.push(
          "Verification reads were skipped — the write did not succeed.",
        );
      }
      const response = buildWriteRefusedResponse(label, validation.targets, issues);
      await copyOrThrow(response, this.clipboard, this.terminal);
      return {
        status: "refused",
        code: EXIT_FAILURE,
        response,
        label,
        targets: validation.targets,
        statusNote: validation.statusNote,
      };
    }

    // Apply the write (patch via git apply, full write via the fs port).
    const applied = await this.executeWrite(proposal, ctx);
    if (!applied.ok) {
      const issues = applied.issues;
      if (proposal.kind === "sequence") {
        issues.push("Verification reads were skipped — the write did not succeed.");
      }
      const response = buildWriteRefusedResponse(label, validation.targets, issues);
      await copyOrThrow(response, this.clipboard, this.terminal);
      return {
        status: "failed",
        code: EXIT_FAILURE,
        response,
        label,
        targets: validation.targets,
        statusNote: validation.statusNote,
      };
    }

    // A sequence verifies the repository only after the write succeeded.
    const verification: VerificationSection[] = [];
    if (proposal.kind === "sequence") {
      for (const vop of proposal.verify) {
        const exec = await this.collector.collect(vop, opts.allowSensitive);
        if (exec === null) {
          verification.push({
            title: describeReadOp(vop),
            lines: ["Not completed — the operation failed (see the terminal)."],
            bytes: 0,
          });
        } else {
          verification.push({ title: exec.part.title, lines: exec.part.lines, bytes: exec.part.bytes });
        }
      }
    }

    const appliedLabel = proposal.kind === "sequence" ? "Sequence — write applied" : label.replace(" proposal", " applied");
    const response = buildWriteAppliedResponse(
      appliedLabel,
      validation.targets,
      validation.statusNote,
      verification,
    );
    const maxBatchBytes = clampBatchBytes(ctx.config.maxBatchBytes);
    const totalBytes = utf8ByteLength(response);
    if (totalBytes > maxBatchBytes) {
      const oversized = buildWriteOversizedResponse(appliedLabel, totalBytes, maxBatchBytes);
      await copyOrThrow(oversized, this.clipboard, this.terminal);
      return {
        status: "applied",
        code: EXIT_OK,
        response: oversized,
        label: appliedLabel,
        targets: validation.targets,
        statusNote: validation.statusNote,
      };
    }
    await copyOrThrow(response, this.clipboard, this.terminal);
    return {
      status: "applied",
      code: EXIT_OK,
      response,
      label: appliedLabel,
      targets: validation.targets,
      statusNote: validation.statusNote,
    };
  }

  /**
   * Validate a proposal: every target path against the write boundary, the
   * sensitive write-content rules, and (for patches) a `git apply --check`
   * preflight before anything changes.
   */
  private async validateProposal(
    proposal: Proposal,
    ctx: WriteContext,
    allowSensitive: boolean,
  ): Promise<ValidatedProposal> {
    const write = proposal.kind === "sequence" ? proposal.write : proposal;
    if (write.kind === "patch") {
      const targets: WriteTargetReport[] = extractDiffTargets(write.diff).map((t) => ({
        relPath: t.relPath,
        kind: t.kind,
        refusedReason: null,
        bytes: null,
      }));
      const issues: string[] = [];
      for (const target of targets) {
        const guarded = ctx.guard.guardWrite(target.relPath);
        if (!guarded.ok) {
          target.refusedReason = guarded.reason;
        }
      }
      if (!allowSensitive && diffAddsSensitiveContent(write.diff)) {
        issues.push(
          "the patch adds lines with obvious sensitive content — requires an explicit override to disclose",
        );
      }
      if (targets.some((t) => t.refusedReason !== null) || issues.length > 0) {
        issues.unshift("Preflight: not run (validation failed)");
        return { issues, targets, statusNote: "", verificationNote: null };
      }
      const preflight = await this.git.checkPatch(ctx.root, write.diff);
      if (!preflight.ok) {
        return {
          issues: ["Preflight failed (git apply --check):", preflight.error],
          targets,
          statusNote: "",
          verificationNote: null,
        };
      }
      const verificationNote =
        proposal.kind === "sequence"
          ? this.verificationNote(proposal)
          : null;
      return {
        issues: [],
        targets,
        statusNote: "Preflight: passed (git apply --check)",
        verificationNote,
      };
    }

    // Full-file write: one validated target, no git preflight.
    const targets: WriteTargetReport[] = [
      { relPath: write.path, kind: "full write", refusedReason: null, bytes: utf8ByteLength(write.content) },
    ];
    const issues: string[] = [];
    const guarded = ctx.guard.guardWrite(write.path);
    if (!guarded.ok) {
      targets[0]!.refusedReason = guarded.reason;
    }
    if (!allowSensitive && containsSensitiveContent(write.content)) {
      issues.push(
        "the write body contains obvious sensitive content — requires an explicit override to disclose",
      );
    }
    if (targets.some((t) => t.refusedReason !== null) || issues.length > 0) {
      issues.unshift("Preflight: not run (validation failed)");
      return { issues, targets, statusNote: "", verificationNote: null };
    }
    return {
      issues: [],
      targets,
      statusNote: "Validation: repository-relative, inside the repository root, not sensitive",
      verificationNote:
        proposal.kind === "sequence" ? this.verificationNote(proposal) : null,
    };
  }

  /** Apply the validated write. Returns `ok` and refusal issues on failure. */
  private async executeWrite(
    proposal: Proposal,
    ctx: WriteContext,
  ): Promise<{ ok: true } | { ok: false; issues: string[] }> {
    const write = proposal.kind === "sequence" ? proposal.write : proposal;
    if (write.kind === "patch") {
      const applied: GitPatchResult = await this.git.applyPatch(ctx.root, write.diff);
      if (!applied.ok) {
        return {
          ok: false,
          issues: [
            "Preflight passed, but the application failed:",
            applied.error,
            "Recover with `git apply -R` if any file was touched.",
          ],
        };
      }
      return { ok: true };
    }

    // Full-file write: create missing parent directories, then write.
    const guarded = ctx.guard.guardWrite(write.path);
    if (!guarded.ok) {
      return { ok: false, issues: [guarded.reason] };
    }
    const relSegments = guarded.relPath.split("/");
    const parent =
      relSegments.length <= 1
        ? ctx.root
        : this.fs.join(ctx.root, ...relSegments.slice(0, -1));
    if (!this.fs.mkdirs(parent)) {
      return {
        ok: false,
        issues: [`could not create the parent directory for \`${guarded.relPath}\``],
      };
    }
    this.fs.writeText(guarded.absPath, write.content);
    return { ok: true };
  }

  /** True when the proposal is applicable (nothing refused, no issues). */
  private applicable(validation: ValidatedProposal): boolean {
    return (
      validation.issues.length === 0 &&
      validation.targets.every((t) => t.refusedReason === null)
    );
  }

  /** Preview note describing the verification reads of a sequence. */
  private verificationNote(
    proposal: { kind: "sequence"; verify: ReadOp[] },
  ): string {
    const labels = proposal.verify.map(describeReadOp);
    return (
      `Verification: ${proposal.verify.length} read operation(s) run only after the write applies ` +
      `(${labels.join(", ")}).`
    );
  }

  /** Resolve the repository root, project config, and permission boundary. */
  private async openContext(allowSensitive: boolean): Promise<WriteContext | null> {
    const root = await requireGitRoot(this.git, this.fs, this.terminal);
    if (root === null) {
      return null;
    }
    const config = parseProjectConfig(this.fs.readText(this.fs.join(root, CONFIG_FILE_NAME)));
    return { root, config, guard: new PathGuard(root, config, allowSensitive, this.fs) };
  }
}

/** Human-readable label of a proposal ("Patch proposal", "Sequence proposal", ...). */
function proposalLabel(proposal: Proposal): string {
  if (proposal.kind === "patch") {
    return "Patch proposal";
  }
  if (proposal.kind === "write") {
    return "Write proposal";
  }
  return "Sequence proposal";
}