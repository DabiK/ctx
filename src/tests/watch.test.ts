/**
 * Watcher/TUI tests: the `ctx watch` loop with fake clipboard, clock, and TUI
 * ports. Covers loop prevention (own responses and duplicate hashes), safe and
 * auto mode behavior, mode transitions, the command entry, pending-write
 * surfacing, preview, application, cancellation, and quit.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RESPONSE_MARKER } from "../branding.js";
import { EXIT_FAILURE, EXIT_OK } from "../application/common.js";
import { WatchUseCase } from "../application/watch.js";
import { fakePorts } from "./fakes.js";
import type { FakeFs, FakeGit } from "./fakes.js";

const ROOT = "/repo";

function seedRepo(fs: FakeFs): void {
  fs.seed(`${ROOT}/src/app.ts`, "alpha\nbeta\ngamma\n");
}

/** Build a WatchUseCase from a fake port bundle. */
function makeWatch(ports: ReturnType<typeof fakePorts>["ports"]): WatchUseCase {
  const { clipboard, terminal, git, fs, search, tui, clock } = ports;
  return new WatchUseCase(clipboard, terminal, git, fs, search, tui, clock);
}

/** Seed a fake status (branch + changed files). */
function gitStatus(git: FakeGit): void {
  git.branch = "main";
  git.statusFiles = [{ relPath: "src/app.ts", state: "modified" }];
}

describe("WatchUseCase.watch", () => {
  it("refuses to start outside a Git repository and never opens the TUI", async () => {
    const { ports, git, tui } = fakePorts();
    git.rootToReport = null;

    const code = await makeWatch(ports).watch({ allowSensitive: false });

    assert.equal(code, EXIT_FAILURE);
    assert.equal(tui.openCalls, 0);
    assert.equal(tui.closeCalls, 0);
  });

  it("starts, renders the initial view, and quits cleanly", async () => {
    const { ports, tui } = fakePorts();

    const code = await makeWatch(ports).watch({ allowSensitive: false });

    assert.equal(code, EXIT_OK);
    assert.equal(tui.openCalls, 1);
    assert.equal(tui.closeCalls, 1);
    const view = tui.lastView();
    assert.equal(view.mode, "safe");
    assert.ok(view.events.some((e) => e.text.includes("watcher started")));
  });

  it("ignores ctx's own clipboard responses (loop prevention)", async () => {
    const { ports, clipboard, tui } = fakePorts();
    clipboard.content = `${RESPONSE_MARKER}\n## Status\nWorking tree clean.\n`;
    tui.keys = [null, "q"];

    const code = await makeWatch(ports).watch({ allowSensitive: false });

    assert.equal(code, EXIT_OK);
    assert.equal(clipboard.copied.length, 0, "nothing copied for an own response");
    assert.ok(
      tui.lastView().events.some((e) => e.text.includes("Ignored ctx's own clipboard response")),
    );
  });

  it("ignores duplicate clipboard content after the first poll (loop prevention)", async () => {
    const { ports, clipboard, fs, tui } = fakePorts();
    seedRepo(fs);
    clipboard.content = "@ctx file src/app.ts";
    // Toggle to auto so the first poll executes without confirmation, then
    // poll twice more: the second and third polls see the same hash.
    tui.keys = ["m", null, null, null, "q"];

    const code = await makeWatch(ports).watch({ allowSensitive: false });

    assert.equal(code, EXIT_OK);
    assert.equal(clipboard.copied.length, 1, "the request executed exactly once");
  });

  it("confirms a read request in safe mode and executes it when confirmed", async () => {
    const { ports, clipboard, fs, tui } = fakePorts();
    seedRepo(fs);
    clipboard.content = "@ctx file src/app.ts";
    tui.keys = [null, "q"];
    tui.confirmAnswers = [true];

    const code = await makeWatch(ports).watch({ allowSensitive: false });

    assert.equal(code, EXIT_OK);
    const copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.includes(RESPONSE_MARKER));
    assert.ok(copied.includes("## src/app.ts"));
    assert.ok(tui.lastView().events.some((e) => e.text.includes("processed request")));
  });

  it("does not execute a declined read request in safe mode", async () => {
    const { ports, clipboard, fs, tui } = fakePorts();
    seedRepo(fs);
    clipboard.content = "@ctx file src/app.ts";
    tui.keys = [null, "q"];
    tui.confirmAnswers = [false];

    const code = await makeWatch(ports).watch({ allowSensitive: false });

    assert.equal(code, EXIT_OK);
    assert.equal(clipboard.copied.length, 0, "nothing copied for a declined request");
    assert.ok(tui.lastView().events.some((e) => e.text.includes("Read request declined")));
  });

  it("runs valid reads automatically in auto mode", async () => {
    const { ports, clipboard, fs, tui } = fakePorts();
    seedRepo(fs);
    clipboard.content = "@ctx file src/app.ts";
    tui.keys = ["m", null, "q"];

    const code = await makeWatch(ports).watch({ allowSensitive: false });

    assert.equal(code, EXIT_OK);
    assert.equal(tui.lastView().mode, "auto");
    assert.ok((clipboard.lastCopied() ?? "").includes("## src/app.ts"));
  });

  it("copies a structured refusal for malformed requests without executing them", async () => {
    const { ports, clipboard, tui } = fakePorts();
    clipboard.content = "@ctx explode src/app.ts";
    tui.keys = [null, "q"];

    const code = await makeWatch(ports).watch({ allowSensitive: false });

    assert.equal(code, EXIT_OK);
    const copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.includes("## Request refused"));
    assert.ok(copied.includes("unsupported operation `explode`"));
    assert.ok(tui.lastView().events.some((e) => e.text.includes("Malformed request refused")));
  });

  it("executes batch requests through the clipboard poll", async () => {
    const { ports, clipboard, fs, tui } = fakePorts();
    seedRepo(fs);
    clipboard.content = ["@ctx batch", "@ctx file src/app.ts:1-1", "@ctx status"].join("\n");
    tui.keys = ["m", null, "q"];

    const code = await makeWatch(ports).watch({ allowSensitive: false });

    assert.equal(code, EXIT_OK);
    const copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.includes("## Batch response"));
    assert.ok(copied.includes("## file src/app.ts:1-1"));
  });

  it("executes a supported read command from the TUI command entry and copies the response", async () => {
    const { ports, clipboard, fs, tui, git } = fakePorts();
    seedRepo(fs);
    gitStatus(git);
    tui.keys = ["e", "q"];
    tui.readLineValues = ["status"];

    const code = await makeWatch(ports).watch({ allowSensitive: false });

    assert.equal(code, EXIT_OK);
    const copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.includes("## Status"));
    assert.ok(tui.lastView().events.some((e) => e.text.includes("Command executed: status")));
  });

  it("refuses an unsupported command in the TUI command entry", async () => {
    const { ports, clipboard, tui } = fakePorts();
    tui.keys = ["e", "q"];
    tui.readLineValues = ["explode"];

    const code = await makeWatch(ports).watch({ allowSensitive: false });

    assert.equal(code, EXIT_OK);
    assert.equal(clipboard.copied.length, 0);
    assert.ok(tui.lastView().events.some((e) => e.text.includes("Command refused")));
  });

  it("surfaces a write proposal as pending without copying over it", async () => {
    const { ports, clipboard, tui } = fakePorts();
    clipboard.content = [
      "@ctx write src/new.ts",
      "```",
      "hello watcher",
      "```",
    ].join("\n");
    tui.keys = ["m", null, "q"];

    const code = await makeWatch(ports).watch({ allowSensitive: false });

    assert.equal(code, EXIT_OK);
    assert.equal(clipboard.copied.length, 0, "the proposal stays untouched in the clipboard");
    const view = tui.lastView();
    assert.equal(view.pendingWrites.length, 1);
    assert.equal(view.pendingWrites[0]?.label, "Write proposal");
    assert.deepEqual(view.pendingWrites[0]?.targets, ["src/new.ts"]);
    assert.ok(view.events.some((e) => e.text.includes("surfaced")));
  });

  it("shows the pending-write preview on the preview action", async () => {
    const { ports, clipboard, tui } = fakePorts();
    clipboard.content = [
      "@ctx write src/new.ts",
      "```",
      "hello watcher",
      "```",
    ].join("\n");
    tui.keys = ["m", null, "p", "q"];

    const code = await makeWatch(ports).watch({ allowSensitive: false });

    assert.equal(code, EXIT_OK);
    assert.equal(tui.details.length, 1);
    assert.ok(tui.details[0]?.includes("## Write proposal — ready to apply"));
    assert.equal(tui.lastView().pendingWrites.length, 1, "preview keeps the write pending");
  });

  it("applies a pending write in auto mode with the explicit apply action", async () => {
    const { ports, clipboard, fs, tui } = fakePorts();
    clipboard.content = [
      "@ctx write src/new.ts",
      "```",
      "hello watcher",
      "```",
    ].join("\n");
    tui.keys = ["m", null, "a", "q"];

    const code = await makeWatch(ports).watch({ allowSensitive: false });

    assert.equal(code, EXIT_OK);
    assert.equal(fs.readText(`${ROOT}/src/new.ts`), "hello watcher");
    const copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.includes("## Write applied"));
    assert.equal(tui.lastView().pendingWrites.length, 0, "applied writes leave the pending queue");
    assert.ok(tui.lastView().events.some((e) => e.text.includes("applied")));
  });

  it("confirms proposed writes and their application in safe mode", async () => {
    const { ports, clipboard, fs, tui } = fakePorts();
    clipboard.content = [
      "@ctx write src/new.ts",
      "```",
      "hello watcher",
      "```",
    ].join("\n");
    tui.keys = [null, "a", "q"];
    tui.confirmAnswers = [true, true];

    const code = await makeWatch(ports).watch({ allowSensitive: false });

    assert.equal(code, EXIT_OK);
    assert.equal(fs.readText(`${ROOT}/src/new.ts`), "hello watcher");
    assert.equal(tui.lastView().pendingWrites.length, 0);
  });

  it("keeps a declined write out of the pending queue in safe mode", async () => {
    const { ports, clipboard, tui } = fakePorts();
    clipboard.content = [
      "@ctx write src/new.ts",
      "```",
      "hello watcher",
      "```",
    ].join("\n");
    tui.keys = [null, "q"];
    tui.confirmAnswers = [false];

    const code = await makeWatch(ports).watch({ allowSensitive: false });

    assert.equal(code, EXIT_OK);
    assert.equal(tui.lastView().pendingWrites.length, 0);
    assert.ok(tui.lastView().events.some((e) => e.text.includes("declined")));
  });

  it("cancels a pending write without applying it", async () => {
    const { ports, clipboard, fs, tui } = fakePorts();
    clipboard.content = [
      "@ctx write src/new.ts",
      "```",
      "hello watcher",
      "```",
    ].join("\n");
    tui.keys = ["m", null, "c", "q"];

    const code = await makeWatch(ports).watch({ allowSensitive: false });

    assert.equal(code, EXIT_OK);
    assert.equal(fs.readText(`${ROOT}/src/new.ts`), null, "the write was never applied");
    assert.equal(tui.lastView().pendingWrites.length, 0);
    assert.ok(tui.lastView().events.some((e) => e.text.includes("Cancelled pending")));
  });

  it("applies a sequence and runs its verification reads only after the write", async () => {
    const { ports, clipboard, fs, tui, git } = fakePorts();
    seedRepo(fs);
    clipboard.content = [
      "@ctx sequence",
      "@ctx write src/app.ts",
      "```",
      "alpha\nchanged",
      "```",
      "@ctx file src/app.ts:2",
      "@ctx status",
    ].join("\n");
    git.statusFiles = [{ relPath: "src/app.ts", state: "modified" }];
    tui.keys = ["m", null, "a", "q"];

    const code = await makeWatch(ports).watch({ allowSensitive: false });

    assert.equal(code, EXIT_OK);
    assert.equal(fs.readText(`${ROOT}/src/app.ts`), "alpha\nchanged");
    const copied = clipboard.lastCopied() ?? "";
    assert.ok(copied.includes("## Sequence — write applied"));
    assert.ok(copied.includes("## Verification: file src/app.ts:2"));
    assert.ok(copied.includes("2 | changed"), "verification reads the written content");
  });

  it("reflects mode transitions in the rendered view", async () => {
    const { ports, tui } = fakePorts();
    tui.keys = ["m", "m", "q"];

    const code = await makeWatch(ports).watch({ allowSensitive: false });

    assert.equal(code, EXIT_OK);
    assert.equal(tui.lastView().mode, "safe", "two toggles return to safe");
    assert.ok(tui.rendered.some((v) => v.mode === "auto"));
  });

  it("keeps events timestamped with the clock port", async () => {
    const { ports, clock, tui } = fakePorts();
    clock.advance(100);
    tui.keys = [null, "q"];

    const code = await makeWatch(ports).watch({ allowSensitive: false });

    assert.equal(code, EXIT_OK);
    for (const event of tui.lastView().events) {
      assert.equal(event.at, 100);
    }
  });
});