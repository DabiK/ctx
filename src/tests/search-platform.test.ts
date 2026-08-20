/**
 * Search backend parser tests: ripgrep JSON and findstr text output parsing,
 * plus the backend factory selection. Pure functions, testable on any host.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  FindstrSearch,
  MissingSearchPort,
  RipgrepSearch,
  createSearchPort,
  parseFindstrOutput,
  parseRipgrepJson,
} from "../platform/search.js";
import { FakeEnv } from "./fakes.js";

const ROOT = "/repo";

describe("parseRipgrepJson", () => {
  it("parses rg --json match lines into repository-relative matches", () => {
    const stdout = [
      JSON.stringify({
        type: "match",
        data: {
          path: { text: `${ROOT}/src/app.ts` },
          lines: { text: "hello\n" },
          line_number: 3,
        },
      }),
      JSON.stringify({
        type: "match",
        data: {
          path: { text: `${ROOT}/src/lib/util.ts` },
          lines: { text: "util" },
          line_number: 1,
        },
      }),
    ].join("\n");

    const matches = parseRipgrepJson(stdout, ROOT);
    assert.deepEqual(matches, [
      { relPath: "src/app.ts", line: 3, content: "hello" },
      { relPath: "src/lib/util.ts", line: 1, content: "util" },
    ]);
  });

  it("ignores non-match events and unparsable lines", () => {
    const stdout = [
      JSON.stringify({ type: "begin", data: { path: { text: `${ROOT}/src/app.ts` } } }),
      "not json at all",
      "",
    ].join("\n");
    assert.deepEqual(parseRipgrepJson(stdout, ROOT), []);
  });

  it("drops matches outside the root", () => {
    const stdout = JSON.stringify({
      type: "match",
      data: {
        path: { text: "/outside/secret.ts" },
        lines: { text: "x\n" },
        line_number: 1,
      },
    });
    assert.deepEqual(parseRipgrepJson(stdout, ROOT), []);
  });
});

describe("parseFindstrOutput", () => {
  it("parses `path:line:content` lines into matches", () => {
    const stdout = [
      `${ROOT}\\src\\app.ts:3:hello`,
      `${ROOT}\\docs\\guide.md:1:guide`,
    ].join("\r\n");

    const matches = parseFindstrOutput(stdout, ROOT);
    assert.deepEqual(matches, [
      { relPath: "src/app.ts", line: 3, content: "hello" },
      { relPath: "docs/guide.md", line: 1, content: "guide" },
    ]);
  });

  it("skips lines that do not carry a line number", () => {
    assert.deepEqual(parseFindstrOutput(`${ROOT}\\src\\app.ts:no-number:hello`, ROOT), []);
  });
});

describe("createSearchPort", () => {
  it("prefers ripgrep when available", () => {
    const env = new FakeEnv();
    env.available = new Set(["rg"]);
    assert.ok(createSearchPort(env) instanceof RipgrepSearch);
  });

  it("falls back to findstr on Windows when ripgrep is absent", () => {
    const env = new FakeEnv();
    env.platform = "win32";
    env.available = new Set(["findstr"]);
    assert.ok(createSearchPort(env) instanceof FindstrSearch);
  });

  it("returns a stub that fails with an actionable message on unsupported hosts", async () => {
    const env = new FakeEnv();
    env.platform = "linux";
    env.available = new Set();
    const port = createSearchPort(env);
    assert.ok(port instanceof MissingSearchPort);
    await assert.rejects(
      () => port.search("x", ["/repo"], 10),
      /ripgrep is required/,
    );
  });
});
