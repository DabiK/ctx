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
  extractDiffTargets,
  isProposalOp,
  parseRequestText,
  SUPPORTED_OPS,
  type ProposalOp,
  type ReadOp,
  type RequestOp,
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

/** One validated proposal (standalone or the write inside a sequence). */
type Proposal = ProposalOp | { kind: "sequence"; write: ProposalOp; verify: ReadOp[] };

/** The ok branch of a parsed request. */
type ParsedOk = { ok: true; ops: RequestOp[]; batch: boolean; sequence: boolean };

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
  async preview(parsed: ParsedOk, allowSensitive: boolean): Promise<number> {
    const ctx = await this.openContext(allowSensitive);
    if (ctx === null) {
      return EXIT_FAILURE;
    }
    const proposal = this.singleProposal(parsed);
    if (proposal === null) {
      return EXIT_FAILURE;
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
      await copyOrThrow(response, this.clipboard, this.terminal);
      this.terminal.error(
        `${PRODUCT_NAME}: ${label.toLowerCase()} refused — nothing was changed (refusal copied to the clipboard).`,
      );
      return EXIT_FAILURE;
    }
    const response = buildWritePreviewResponse(
      label,
      validation.targets,
      validation.statusNote,
      validation.verificationNote,
    );
    await copyOrThrow(response, this.clipboard, this.terminal);
    this.terminal.info(
      `${PRODUCT_NAME}: ${label.toLowerCase()} validated and preflighted — apply it unchanged with ` +
        `\`${PRODUCT_NAME} apply\` (preview copied to the clipboard).`,
    );
    return EXIT_OK;
  }

  /**
   * `ctx apply` — the explicit approval that actually applies a tagged write
   * proposal from the clipboard. Re-validates and re-preflights (the
   * clipboard may have changed), applies the write, and runs the verification
   * reads of a sequence only after the write succeeds.
   */
  async apply(opts: WriteOptions): Promise<number> {
    const ctx = await this.openContext(opts.allowSensitive);
    if (ctx === null) {
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
    const proposal = this.singleProposal(parsed);
    if (proposal === null) {
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
      this.terminal.error(
        `${PRODUCT_NAME}: ${label.toLowerCase()} refused — nothing was changed (refusal copied to the clipboard).`,
      );
      return EXIT_FAILURE;
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
      this.terminal.error(
        `${PRODUCT_NAME}: ${label.toLowerCase()} failed — nothing was changed (diagnostic copied to the clipboard).`,
      );
      return EXIT_FAILURE;
    }

    // A sequence verifies the repository only after the write succeeded.
    const verification: VerificationSection[] = [];
    if (proposal.kind === "sequence") {
      for (const vop of proposal.verify) {
        const exec = await this.collector.collect(vop, opts.allowSensitive);
        if (exec === null) {
          verification.push({
            title: readOpLabel(vop),
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
      this.terminal.error(
        `${PRODUCT_NAME}: write applied, but the verification response was over the total budget ` +
          `(${totalBytes} bytes > ${maxBatchBytes}) — a reduced ${RESPONSE_MARKER} was copied.`,
      );
      return EXIT_OK;
    }
    await copyOrThrow(response, this.clipboard, this.terminal);
    this.terminal.info(
      `${PRODUCT_NAME}: ${proposal.kind === "patch" ? "patch" : "write"} applied — ` +
        `${validation.targets.length} file(s) changed; ${RESPONSE_MARKER} copied to the clipboard.`,
    );
    return EXIT_OK;
  }

  /** Extract the single proposal op of a parsed request (or `null`). */
  private singleProposal(parsed: ParsedOk): Proposal | null {
    const op = parsed.ops[0];
    if (op === undefined) {
      return null;
    }
    if (isProposalOp(op) || op.kind === "sequence") {
      return op;
    }
    return null;
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
    const labels = proposal.verify.map(readOpLabel);
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

/** Short label of a read operation (for skipped verification sections). */
function readOpLabel(op: ReadOp): string {
  switch (op.kind) {
    case "file":
      return `file ${op.specs[0] ?? ""}`;
    case "files":
      return `files ${op.specs.join(" ")}`;
    case "tree":
      return "tree";
    case "glob":
      return `glob ${op.pattern}`;
    case "inspect":
      return "inspect";
    case "search":
      return `search ${op.query}`;
    case "status":
      return "status";
    case "changed":
      return "changed";
    case "diff":
      return "diff";
    case "log":
      return "log";
    case "show":
      return `show ${op.rev} ${op.path}`;
  }
}