import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("release version", () => {
  it("reports the installed action version after a release-only metadata bump", () => {
    const workspace = mkdtempSync(join(tmpdir(), "prek-release-version-"));
    try {
      const action = join(workspace, "action");
      const caller = join(workspace, "caller");
      mkdirSync(join(action, "dist"), { recursive: true });
      mkdirSync(caller);
      copyFileSync("dist/index.js", join(action, "dist", "index.js"));
      writeFileSync(
        join(action, "package.json"),
        JSON.stringify({ type: "module", version: "99.8.7" }),
      );
      writeFileSync(
        join(caller, "package.json"),
        JSON.stringify({ version: "1.2.3" }),
      );

      const result = spawnSync(
        process.execPath,
        [join(action, "dist", "index.js")],
        {
          cwd: caller,
          encoding: "utf8",
          env: { ...process.env, INPUT_TOKEN: "" },
          timeout: 10_000,
        },
      );

      // Stop at input validation, before any GitHub or repository operations.
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("prek-autoupdate version v99.8.7");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
