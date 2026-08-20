/**
 * Shared operation collection (application logic).
 *
 * Executes one parsed read operation through its application use case and
 * returns the renderable block. Used by the request use case for combined and
 * batch requests and by the write use case for sequence verification reads,
 * so every path renders the same sections through the same boundary rules.
 */

import type { ReadOp } from "../protocol.js";
import { DiscoveryUseCase, type OpExecution } from "./discovery.js";
import { GitUseCase } from "./git.js";
import type {
  ClipboardPort,
  FsPort,
  GitPort,
  SearchPort,
  TerminalPort,
} from "./ports.js";
import { ReadUseCase } from "./read.js";
import { buildReadPart } from "./response.js";
import { SearchUseCase } from "./search.js";

/** The application use cases that execute individual read operations. */
export interface OpCollector {
  reader: ReadUseCase;
  discovery: DiscoveryUseCase;
  search: SearchUseCase;
  gitOps: GitUseCase;
  /**
   * Execute one read operation into a renderable part, or `null` on an
   * infrastructure failure (already reported to the terminal).
   */
  collect(op: ReadOp, allowSensitive: boolean): Promise<OpExecution | null>;
}

/** Build the shared collector over the platform ports. */
export function createCollector(
  clipboard: ClipboardPort,
  terminal: TerminalPort,
  git: GitPort,
  fs: FsPort,
  search: SearchPort,
): OpCollector {
  const reader = new ReadUseCase(clipboard, terminal, git, fs);
  const discovery = new DiscoveryUseCase(clipboard, terminal, git, fs);
  const searchOps = new SearchUseCase(clipboard, terminal, git, fs, search);
  const gitOps = new GitUseCase(clipboard, terminal, git, fs);
  return {
    reader,
    discovery,
    search: searchOps,
    gitOps,
    async collect(op, allowSensitive): Promise<OpExecution | null> {
      switch (op.kind) {
        case "file":
        case "files": {
          const collected = await reader.collectSpecs(op.specs, allowSensitive);
          if (collected === null) {
            return null;
          }
          const items = collected.items;
          const readCount = items.filter((i) => i.kind === "read").length;
          return {
            part: buildReadPart(
              items,
              op.kind === "file" ? `file ${op.specs[0] ?? ""}` : `files ${op.specs.join(" ")}`,
            ),
            produced: readCount > 0,
            maxBatchBytes: collected.maxBatchBytes,
          };
        }
        case "tree":
          return discovery.collectTree(op.depth, allowSensitive);
        case "glob":
          return discovery.collectGlob(op.pattern, allowSensitive, null);
        case "inspect":
          return discovery.collectInspect(op.path, allowSensitive, null);
        case "search":
          return searchOps.collectSearch(op.query, allowSensitive, null);
        case "status":
          return gitOps.collectStatus(allowSensitive);
        case "changed":
          return gitOps.collectChanged(op.path, allowSensitive);
        case "diff":
          return gitOps.collectDiff(op.path, op.staged, allowSensitive);
        case "log":
          return gitOps.collectLog(op.path, allowSensitive, op.limit);
        case "show":
          return gitOps.collectShow(op.rev, op.path, allowSensitive);
      }
    },
  };
}