/**
 * Watcher/TUI tests: the `ctx watch` loop with fake clipboard, clock, and TUI
 * ports. Covers loop prevention (own responses and duplicate hashes), safe,
 * auto, and yolo mode behavior, persisted-mode restore, the yolo countdown
 * (completion and cancellation), sensitive-write refusal in yolo, the command
 * entry, pending-write surfacing, preview, application, cancellation,
 * notifications, and quit.
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
  const { clipboard, terminal, git, fs, search, tui, clock, userConfig, notifications } = ports;
  return new WatchUseCase(
    clipboard,
    terminal,
    git,
    fs,
    search,
    tui,
    clock,
    userConfig,
    notifications,
  );
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
    const { ports, clipboard, tui, notifications } = fakePorts();
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
    assert.ok(
      notifications.notices.some((n) => n.title === "Write proposal pending"),
      "a pending-write notification was emitted",
    );
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
    const { ports, clipboard, fs, tui, notifications } = fakePorts();
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
    assert.ok(
      notifications.notices.some((n) => n.title === "Write proposal applied"),
      "an applied-write notification was emitted",
    );
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
    tui.keys = ["m", "m", "m", "q"];

    const code = await makeWatch(ports).watch({ allowSensitive: false });

    assert.equal(code, EXIT_OK);
    assert.equal(tui.lastView().mode, "safe", "a full cycle returns to safe");
    assert.ok(tui.rendered.some((v) => v.mode === "auto"));
    assert.ok(tui.rendered.some((v) => v.mode === "yolo"));
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

  it("restores the persisted mode from user-local config on start", async () => {
    const { ports, clipboard, fs, userConfig, tui } = fakePorts();
    seedRepo(fs);
    userConfig.mode = "auto";
    clipboard.content = "@ctx file src/app.ts";
    // Auto mode runs the read without a confirmation prompt.
    tui.keys = [null, "q"];

    const code = await makeWatch(ports).watch({ allowSensitive: false });

    assert.equal(code, EXIT_OK);
    assert.equal(tui.lastView().mode, "auto");
    assert.ok((clipboard.lastCopied() ?? "").includes("## src/app.ts"));
  });

  it("persists every mode switch to user-local config through a full cycle", async () => {
    const { ports, userConfig, tui } = fakePorts();
    tui.keys = ["m", "m", "m", "q"];

    const code = await makeWatch(ports).watch({ allowSensitive: false });

    assert.equal(code, EXIT_OK);
    assert.equal(tui.lastView().mode, "safe", "a full cycle returns to safe");
    assert.equal(userConfig.mode, "safe", "the final mode is persisted");
    assert.ok(tui.rendered.some((v) => v.mode === "auto"));
    assert.ok(tui.rendered.some((v) => v.mode === "yolo"));
  });

  it("counts down three seconds and auto-applies a valid write in yolo", async () => {
    const { ports, clipboard, fs, tui, userConfig, notifications } = fakePorts();
    userConfig.mode = "yolo";
    clipboard.content = [
      "@ctx write src/new.ts",
      "```",
      "hello yolo",
      "```",
    ].join("\n");
    // Poll tick + 3 countdown ticks + quit: the countdown completes untouched.
    tui.keys = [null, null, null, null, "q"];

    const code = await makeWatch(ports).watch({ allowSensitive: false });

    assert.equal(code, EXIT_OK);
    assert.equal(fs.readText(`${ROOT}/src/new.ts`), "hello yolo");
    const countdownSteps = tui.rendered
      .flatMap((v) => (v.countdown !== null ? [v.countdown.secondsLeft] : []));
    assert.deepEqual(countdownSteps, [3, 2, 1], "the countdown rendered every second");
    assert.equal(tui.lastView().countdown, null, "the countdown clears after the apply");
    assert.ok(tui.lastView().events.some((e) => e.text.includes("Write proposal applied")));
    assert.ok(notifications.notices.some((n) => n.title === "Write proposal applied"));
  });

  it("cancels the yolo countdown on any key and keeps the proposal pending", async () => {
    const { ports, clipboard, fs, tui, userConfig } = fakePorts();
    userConfig.mode = "yolo";
    clipboard.content = [
      "@ctx write src/new.ts",
      "```",
      "hello yolo",
      "```",
    ].join("\n");
    // Poll tick + 2 countdown ticks; the `c` key during the countdown cancels.
    tui.keys = [null, null, "c", "q"];

    const code = await makeWatch(ports).watch({ allowSensitive: false });

    assert.equal(code, EXIT_OK);
    assert.equal(fs.readText(`${ROOT}/src/new.ts`), null, "a cancelled write is never applied");
    assert.equal(tui.lastView().pendingWrites.length, 1, "the cancelled proposal stays pending");
    assert.ok(tui.lastView().events.some((e) => e.text.includes("countdown cancelled")));
  });

  it("never auto-applies a sensitive write in yolo without the override", async () => {
    const { ports, clipboard, fs, tui, userConfig, notifications } = fakePorts();
    userConfig.mode = "yolo";
    clipboard.content = [
      "@ctx write .env",
      "```",
      "AKIA1234567890123456",
      "```",
    ].join("\n");
    // Enough ticks for a countdown to complete if it were started.
    tui.keys = [null, null, null, null, "q"];

    const code = await makeWatch(ports).watch({ allowSensitive: false });

    assert.equal(code, EXIT_OK);
    assert.equal(fs.readText(`${ROOT}/.env`), null, "sensitive writes stay blocked in yolo");
    assert.equal(tui.lastView().pendingWrites.length, 1, "the refusal is surfaced as pending");
    assert.ok(tui.lastView().events.some((e) => e.text.includes("refused in yolo")));
    assert.ok(notifications.notices.some((n) => n.title === "Write proposal refused"));
  });

  it("auto-applies a sensitive write in yolo with the explicit override", async () => {
    const { ports, clipboard, fs, tui, userConfig } = fakePorts();
    userConfig.mode = "yolo";
    clipboard.content = [
      "@ctx write .env",
      "```",
      "AKIA1234567890123456",
      "```",
    ].join("\n");
    tui.keys = [null, null, null, null, "q"];

    const code = await makeWatch(ports).watch({ allowSensitive: true });

    assert.equal(code, EXIT_OK);
    assert.equal(fs.readText(`${ROOT}/.env`), "AKIA1234567890123456");
    assert.equal(tui.lastView().pendingWrites.length, 0);
  });

  it("reports read completion through the notification port without replacing TUI diagnostics", async () => {
    const { ports, clipboard, fs, tui, notifications } = fakePorts();
    seedRepo(fs);
    clipboard.content = "@ctx file src/app.ts";
    tui.keys = ["m", null, "q"];

    const code = await makeWatch(ports).watch({ allowSensitive: false });

    assert.equal(code, EXIT_OK);
    const completed = notifications.notices.find((n) => n.title === "Request completed");
    assert.ok(completed, "a completion notification was emitted");
    assert.ok(completed?.body.includes("file src/app.ts"));
    // Notifications never replace TUI diagnostics.
    assert.ok(tui.lastView().events.some((e) => e.text.includes("processed request")));
  });
});