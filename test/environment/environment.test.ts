import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  hardenedGitArguments,
  sanitizedChildEnvironment,
} from "../../src/environment.js";

const ORIGINAL_ENVIRONMENT = { ...process.env };

describe("sanitizedChildEnvironment", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENVIRONMENT };
  });

  it("removes action inputs and caller-controlled Git process settings", () => {
    Object.assign(process.env, {
      INPUT_TOKEN: "secret",
      INPUT_ADD_PATHS: "unsafe",
      GIT_ASKPASS: "/tmp/askpass",
      GIT_CONFIG_GLOBAL: "/tmp/global-config",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "malicious",
      GIT_CONFIG_PARAMETERS: "'credential.helper=malicious'",
      GIT_CONFIG_SYSTEM: "/tmp/system-config",
      GIT_SSH_COMMAND: "ssh -o ProxyCommand=malicious",
      GIT_TRACE: "1",
      GIT_TRACE2_EVENT: "/tmp/trace",
      LD_LIBRARY_PATH: "/tmp/malicious-libraries",
      LD_PRELOAD: "/tmp/malicious-loader.so",
      DYLD_INSERT_LIBRARIES: "/tmp/malicious-loader.dylib",
      PATH: "/tmp/poisoned-bin",
      SSH_ASKPASS: "/tmp/ssh-askpass",
      SAFE_ACTION_VALUE: "preserved",
    });

    const environment = sanitizedChildEnvironment();

    expect(environment).toMatchObject({
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      PATH: "/usr/bin:/bin",
      SAFE_ACTION_VALUE: "preserved",
    });
    expect(environment).not.toHaveProperty("INPUT_TOKEN");
    expect(environment).not.toHaveProperty("INPUT_ADD_PATHS");
    expect(environment).not.toHaveProperty("GIT_ASKPASS");
    expect(environment).not.toHaveProperty("GIT_CONFIG_KEY_0");
    expect(environment).not.toHaveProperty("GIT_CONFIG_VALUE_0");
    expect(environment).not.toHaveProperty("GIT_CONFIG_PARAMETERS");
    expect(environment).not.toHaveProperty("GIT_CONFIG_SYSTEM");
    expect(environment).not.toHaveProperty("GIT_SSH_COMMAND");
    expect(environment).not.toHaveProperty("GIT_TRACE");
    expect(environment).not.toHaveProperty("GIT_TRACE2_EVENT");
    expect(environment).not.toHaveProperty("LD_LIBRARY_PATH");
    expect(environment).not.toHaveProperty("LD_PRELOAD");
    expect(environment).not.toHaveProperty("DYLD_INSERT_LIBRARIES");
    expect(environment).not.toHaveProperty("SSH_ASKPASS");
  });

  it("allows trusted additions without overriding isolation or restoring secrets", () => {
    process.env.INPUT_TOKEN = "inherited-secret";

    const environment = sanitizedChildEnvironment({
      ACTION_OPERATION: "update",
      GIT_CONFIG_GLOBAL: "/tmp/attacker-global",
      GIT_CONFIG_NOSYSTEM: "0",
      GIT_TERMINAL_PROMPT: "1",
      GIT_TRACE: "1",
      INPUT_TOKEN: "replacement-secret",
      LD_AUDIT: "/tmp/audit.so",
      DYLD_LIBRARY_PATH: "/tmp/libraries",
      PATH: "/tmp/replacement-bin",
    });

    expect(environment).toMatchObject({
      ACTION_OPERATION: "update",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      PATH: "/usr/bin:/bin",
    });
    expect(environment).not.toHaveProperty("INPUT_TOKEN");
    expect(environment).not.toHaveProperty("GIT_TRACE");
    expect(environment).not.toHaveProperty("LD_AUDIT");
    expect(environment).not.toHaveProperty("DYLD_LIBRARY_PATH");
  });

  it("does not resolve Git from an inherited poisoned PATH", () => {
    const temporaryDirectory = mkdtempSync(
      join(tmpdir(), "prek-autoupdate-environment-"),
    );
    const fakeGit = join(temporaryDirectory, "git");
    const fakeGitMarker = join(temporaryDirectory, "fake-git-ran");

    try {
      writeFileSync(
        fakeGit,
        `#!/bin/sh\ntouch "${fakeGitMarker}"\necho fake-git\n`,
      );
      chmodSync(fakeGit, 0o755);
      process.env.PATH = temporaryDirectory;

      const output = execFileSync("git", ["--version"], {
        encoding: "utf8",
        env: sanitizedChildEnvironment(),
      });

      expect(output).toMatch(/^git version /);
      expect(existsSync(fakeGitMarker)).toBe(false);
    } finally {
      rmSync(temporaryDirectory, { force: true, recursive: true });
    }
  });
});

describe("hardenedGitArguments", () => {
  it("disables hooks and credential helpers before caller arguments", () => {
    expect(hardenedGitArguments(["status", "--short"])).toEqual([
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "credential.helper=",
      "status",
      "--short",
    ]);
  });
});
