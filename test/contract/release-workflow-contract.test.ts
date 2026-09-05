import { execFileSync } from "node:child_process";
import {
  cpSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface WorkflowStep {
  readonly if?: string;
  readonly env?: Record<string, string>;
  readonly id?: string;
  readonly name?: string;
  readonly run?: string;
  readonly uses?: string;
  readonly with?: Record<string, unknown>;
}

interface WorkflowJob {
  readonly if?: string;
  readonly needs?: string | string[];
  readonly outputs?: Record<string, string>;
  readonly permissions?: Record<string, string>;
  readonly steps: WorkflowStep[];
}

interface Workflow {
  readonly on: {
    readonly release: {
      readonly types: string[];
    };
  };
  readonly permissions: Record<string, string>;
  readonly jobs: {
    readonly candidate: WorkflowJob;
    readonly prerelease: WorkflowJob;
    readonly release: WorkflowJob;
  };
}

interface CandidateStagingResult {
  readonly error: Error | undefined;
  readonly hasStagedChanges: boolean;
}

interface CandidateConstructionResult {
  readonly bundle: string;
  readonly error: Error | undefined;
  readonly lockVersion: string;
  readonly packageVersion: string;
}

const RELEASE_DECISION_SCRIPT = resolve(".github/scripts/decide-major-tag.mjs");

function workflow(): Workflow {
  return parse(
    readFileSync(".github/workflows/release.yml", "utf8"),
  ) as Workflow;
}

function requiredStep(
  steps: readonly WorkflowStep[],
  predicate: (step: WorkflowStep) => boolean,
  description: string,
): WorkflowStep {
  const step = steps.find(predicate);
  if (step === undefined) {
    throw new Error(`Release workflow is missing the ${description} step`);
  }
  return step;
}

function runCandidateConstruction(
  releaseTag: string,
  currentVersion: string,
): CandidateConstructionResult {
  const candidateRun = requiredStep(
    workflow().jobs.candidate.steps,
    (step) =>
      step.env?.RELEASE_TAG === "${{ github.event.release.tag_name }}" &&
      (step.run?.includes(".github/scripts/prepare-release.mjs") ?? false),
    "release candidate construction",
  ).run!;
  const directory = mkdtempSync(join(tmpdir(), "prek-release-construction-"));
  const binDirectory = mkdtempSync(join(tmpdir(), "prek-release-bin-"));
  const outputPath = join(binDirectory, "github-output");
  const npmPath = join(binDirectory, "npm");
  try {
    mkdirSync(join(directory, ".github", "scripts"), { recursive: true });
    mkdirSync(join(directory, "dist"), { recursive: true });
    cpSync("src", join(directory, "src"), { recursive: true });
    cpSync("rollup.config.mjs", join(directory, "rollup.config.mjs"));
    symlinkSync(resolve("node_modules"), join(directory, "node_modules"));
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ name: "candidate-fixture", version: currentVersion }),
    );
    writeFileSync(
      join(directory, "package-lock.json"),
      JSON.stringify({
        name: "candidate-fixture",
        packages: {
          "": { name: "candidate-fixture", version: currentVersion },
        },
        version: currentVersion,
      }),
    );
    writeFileSync(
      join(directory, "dist", "index.js"),
      `var version = "${currentVersion}";\n`,
    );
    writeFileSync(
      join(directory, ".github", "scripts", "prepare-release.mjs"),
      readFileSync(".github/scripts/prepare-release.mjs"),
    );
    writeFileSync(
      npmPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'if [[ "$*" == "ci --ignore-scripts" ]]; then exit 0; fi',
        'if [[ "$*" != "run build" ]]; then exit 64; fi',
        "exec node_modules/.bin/rollup --config",
        "",
      ].join("\n"),
    );
    chmodSync(npmPath, 0o755);
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: directory });
    execFileSync("git", ["add", "."], { cwd: directory });
    execFileSync(
      "git",
      [
        "-c",
        "user.email=test@example.invalid",
        "-c",
        "user.name=Release test",
        "commit",
        "-m",
        "base",
      ],
      { cwd: directory },
    );

    let error: Error | undefined;
    try {
      execFileSync("bash", ["-c", candidateRun], {
        cwd: directory,
        env: {
          ...process.env,
          GITHUB_OUTPUT: outputPath,
          PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
          RELEASE_TAG: releaseTag,
        },
        stdio: "pipe",
      });
    } catch (caught) {
      const output = caught as {
        stderr?: Buffer | string;
        stdout?: Buffer | string;
      };
      error = new Error(
        output.stderr?.toString().trim() ||
          output.stdout?.toString().trim() ||
          "candidate construction failed",
        { cause: caught },
      );
    }
    const packageJson = JSON.parse(
      readFileSync(join(directory, "package.json"), "utf8"),
    ) as { version: string };
    const packageLock = JSON.parse(
      readFileSync(join(directory, "package-lock.json"), "utf8"),
    ) as { version: string };
    return {
      bundle: readFileSync(join(directory, "dist", "index.js"), "utf8"),
      error,
      lockVersion: packageLock.version,
      packageVersion: packageJson.version,
    };
  } finally {
    rmSync(directory, { recursive: true });
    rmSync(binDirectory, { recursive: true });
  }
}

function runCandidateStaging(
  candidatePackage: Record<string, unknown>,
  candidateLock?: Record<string, unknown>,
  candidateSha = "1".repeat(40),
  tagSha = candidateSha,
): CandidateStagingResult {
  const stagingRun = requiredStep(
    workflow().jobs.release.steps,
    (step) =>
      step.run?.includes(
        "expected_paths=(dist/index.js package-lock.json package.json)",
      ) ?? false,
    "read-only candidate validation",
  ).run!;
  const directory = mkdtempSync(join(tmpdir(), "prek-release-candidate-"));
  const artifactDirectory = mkdtempSync(
    join(tmpdir(), "prek-release-candidate-artifact-"),
  );
  const packageLock = {
    lockfileVersion: 3,
    name: "candidate-fixture",
    packages: {
      "": { name: "candidate-fixture", version: "1.0.0" },
    },
    version: "1.0.0",
  };
  try {
    mkdirSync(join(directory, "dist"), { recursive: true });
    mkdirSync(join(artifactDirectory, "dist"), { recursive: true });
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({
        name: "candidate-fixture",
        private: true,
        version: "1.0.0",
      }),
    );
    writeFileSync(
      join(directory, "package-lock.json"),
      JSON.stringify(packageLock),
    );
    writeFileSync(join(directory, "dist", "index.js"), "export {};\n");
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: directory });
    execFileSync(
      "git",
      ["add", "dist/index.js", "package-lock.json", "package.json"],
      {
        cwd: directory,
      },
    );
    execFileSync(
      "git",
      [
        "-c",
        "user.email=test@example.invalid",
        "-c",
        "user.name=Release test",
        "commit",
        "-m",
        "base",
      ],
      { cwd: directory },
    );
    writeFileSync(
      join(artifactDirectory, "package.json"),
      JSON.stringify(candidatePackage),
    );
    writeFileSync(
      join(artifactDirectory, "package-lock.json"),
      JSON.stringify(
        candidateLock ?? {
          ...packageLock,
          packages: {
            "": { name: "candidate-fixture", version: "1.0.1" },
          },
          version: "1.0.1",
        },
      ),
    );
    writeFileSync(join(artifactDirectory, "dist", "index.js"), "export {};\n");
    let error: Error | undefined;
    try {
      execFileSync("bash", ["-c", stagingRun], {
        cwd: directory,
        env: {
          ...process.env,
          CANDIDATE_SHA: candidateSha,
          RELEASE_ARTIFACT: artifactDirectory,
          RELEASE_TAG: "v1.0.1",
          TAG_SHA: tagSha,
        },
        stdio: "pipe",
      });
    } catch (caught) {
      const output = caught as {
        stderr?: Buffer | string;
        stdout?: Buffer | string;
      };
      const stderr = output.stderr;
      const stdout = output.stdout;
      error = new Error(
        stderr?.toString().trim() ||
          stdout?.toString().trim() ||
          "candidate staging failed",
        { cause: caught },
      );
    }
    let hasStagedChanges = false;
    try {
      execFileSync("git", ["diff", "--cached", "--quiet"], {
        cwd: directory,
        stdio: "ignore",
      });
    } catch {
      hasStagedChanges = true;
    }
    return {
      error,
      hasStagedChanges,
    };
  } finally {
    rmSync(directory, { recursive: true });
    rmSync(artifactDirectory, { recursive: true });
  }
}

function decideRelease(
  releaseTag: string,
  targetSha: string,
  tags: Array<{ name: string; commit: { sha: string } }>,
  releases: Array<{
    tag_name: string;
    draft: boolean;
    prerelease: boolean;
    published_at: string | null;
  }> = tags
    .filter((tag) => /^v[0-9]+\.[0-9]+\.[0-9]+$/.test(tag.name))
    .map((tag) => ({
      tag_name: tag.name,
      draft: false,
      prerelease: false,
      published_at: "2026-01-01T00:00:00Z",
    })),
): string {
  const directory = mkdtempSync(join(tmpdir(), "prek-autoupdate-release-"));
  const tagsFile = join(directory, "tags.json");
  const releasesFile = join(directory, "releases.json");
  writeFileSync(tagsFile, JSON.stringify([tags.slice(0, 1), tags.slice(1)]));
  writeFileSync(
    releasesFile,
    JSON.stringify([releases.slice(0, 1), releases.slice(1)]),
  );
  try {
    return execFileSync(process.execPath, [RELEASE_DECISION_SCRIPT], {
      encoding: "utf8",
      env: {
        ...process.env,
        RELEASE_TAG: releaseTag,
        TARGET_SHA: targetSha,
        TAGS_FILE: tagsFile,
        RELEASES_FILE: releasesFile,
      },
    });
  } finally {
    rmSync(directory, { recursive: true });
  }
}

function prepareRelease(
  releaseTag: string,
  packageVersion: string,
): {
  output: string;
  packageJson: { version: string };
  packageLock: { version: string; packages: { "": { version: string } } };
} {
  const directory = mkdtempSync(
    join(tmpdir(), "prek-autoupdate-prepare-release-"),
  );
  const packagePath = join(directory, "package.json");
  const lockPath = join(directory, "package-lock.json");
  const outputPath = join(directory, "output");
  writeFileSync(packagePath, JSON.stringify({ version: packageVersion }));
  writeFileSync(
    lockPath,
    JSON.stringify({
      version: packageVersion,
      packages: { "": { version: packageVersion } },
    }),
  );
  try {
    try {
      execFileSync(
        process.execPath,
        [resolve(".github/scripts/prepare-release.mjs")],
        {
          cwd: resolve("."),
          env: {
            ...process.env,
            GITHUB_OUTPUT: outputPath,
            PACKAGE_JSON_PATH: packagePath,
            PACKAGE_LOCK_PATH: lockPath,
            RELEASE_TAG: releaseTag,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } catch (error) {
      const stderr = (error as { stderr?: Buffer | string }).stderr;
      throw new Error(
        stderr?.toString().trim() || "release preparation failed",
        {
          cause: error,
        },
      );
    }
    return {
      output: readFileSync(outputPath, "utf8"),
      packageJson: JSON.parse(readFileSync(packagePath, "utf8")),
      packageLock: JSON.parse(readFileSync(lockPath, "utf8")),
    };
  } finally {
    rmSync(directory, { recursive: true });
  }
}

function runPrereleaseValidation(releaseTag: string): Error | undefined {
  const verification = requiredStep(
    workflow().jobs.prerelease.steps,
    (step) => step.name === "Verify prerelease identity without mutating refs",
    "prerelease identity verification",
  ).run!;
  const directory = mkdtempSync(join(tmpdir(), "prek-prerelease-validation-"));
  const version = releaseTag.slice(1);
  try {
    mkdirSync(join(directory, "dist"), { recursive: true });
    writeFileSync(join(directory, "package.json"), JSON.stringify({ version }));
    writeFileSync(
      join(directory, "package-lock.json"),
      JSON.stringify({ version, packages: { "": { version } } }),
    );
    writeFileSync(join(directory, "dist", "index.js"), "export {};\n");
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: directory });
    execFileSync("git", ["add", "."], { cwd: directory });
    execFileSync(
      "git",
      [
        "-c",
        "user.email=test@example.invalid",
        "-c",
        "user.name=Prerelease test",
        "commit",
        "-m",
        "release",
      ],
      { cwd: directory },
    );
    execFileSync("git", ["tag", releaseTag], { cwd: directory });
    execFileSync("git", ["remote", "add", "origin", directory], {
      cwd: directory,
    });
    try {
      execFileSync("bash", ["-c", verification], {
        cwd: directory,
        env: {
          ...process.env,
          DEFAULT_BRANCH: "main",
          RELEASE_TAG: releaseTag,
          RELEASE_TARGET: "main",
        },
        stdio: "pipe",
      });
    } catch (caught) {
      const error = caught as {
        stderr?: Buffer | string;
        stdout?: Buffer | string;
      };
      return new Error(
        error.stderr?.toString().trim() ||
          error.stdout?.toString().trim() ||
          "prerelease validation failed",
        { cause: caught },
      );
    }
    return undefined;
  } finally {
    rmSync(directory, { recursive: true });
  }
}

type ReleaseUpdateAction = "create" | "noop" | "skip" | "update";
type ReleaseUpdateFailure =
  "create-race" | "major-race" | "none" | "point-mismatch" | "release-tag-move";

interface ReleaseUpdateResult {
  readonly error: Error | undefined;
  readonly initialMajorSha: string | undefined;
  readonly majorDirectOid: string | undefined;
  readonly majorSha: string | undefined;
  readonly newerSha: string;
  readonly output: string;
  readonly targetSha: string;
}

function runReleaseUpdate(
  action: ReleaseUpdateAction,
  failure: ReleaseUpdateFailure = "none",
  annotatedMajor = false,
  staleListedPointSha = false,
): ReleaseUpdateResult {
  const directory = mkdtempSync(
    join(tmpdir(), "prek-autoupdate-release-write-"),
  );
  const remote = join(directory, "remote.git");
  const workspace = join(directory, "workspace");
  const binDirectory = join(directory, "bin");
  const ghPath = join(binDirectory, "gh");
  const gitPath = join(binDirectory, "git");
  const pointReadsPath = join(directory, "point-reads");
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const runGit = (arguments_: string[]): string =>
    execFileSync(realGit, arguments_, {
      cwd: workspace,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const remoteOid = (ref: string): string | undefined => {
    try {
      return runGit(["--git-dir", remote, "rev-parse", "--verify", ref]);
    } catch {
      return undefined;
    }
  };
  try {
    mkdirSync(binDirectory);
    execFileSync(realGit, ["init", "--bare", remote], { stdio: "ignore" });
    execFileSync(realGit, ["init", "--initial-branch=main", workspace], {
      stdio: "ignore",
    });
    runGit(["config", "user.name", "Release test"]);
    runGit(["config", "user.email", "test@example.invalid"]);
    runGit(["remote", "add", "origin", remote]);
    const commit = (message: string): string => {
      writeFileSync(join(workspace, "version"), `${message}\n`);
      runGit(["add", "version"]);
      runGit(["commit", "-m", message]);
      return runGit(["rev-parse", "HEAD"]);
    };
    const oldSha = commit("old release");
    const targetSha = commit("target release");
    const newerSha = commit("newer release");
    const raceSha = commit("racing update");
    const pointSha = failure === "point-mismatch" ? raceSha : targetSha;

    runGit(["tag", "v1.9.9", oldSha]);
    runGit(["tag", "-a", "v1.10.0", "-m", "Release v1.10.0", pointSha]);
    if (action === "skip") {
      runGit(["tag", "-a", "v1.11.0", "-m", "Release v1.11.0", newerSha]);
    }
    if (action !== "create") {
      const majorSha =
        action === "skip" ? newerSha : action === "noop" ? targetSha : oldSha;
      runGit(
        annotatedMajor
          ? ["tag", "-a", "v1", "-m", "Moving v1", majorSha]
          : ["tag", "v1", majorSha],
      );
    }
    runGit(["push", "origin", "HEAD:refs/heads/main"]);
    runGit(["push", "origin", "refs/tags/v1.9.9", "refs/tags/v1.10.0"]);
    if (action === "skip") runGit(["push", "origin", "refs/tags/v1.11.0"]);
    if (action !== "create") runGit(["push", "origin", "refs/tags/v1"]);

    const initialMajorSha =
      remoteOid("refs/tags/v1^{}") ?? remoteOid("refs/tags/v1");
    const listedPointSha = staleListedPointSha ? oldSha : targetSha;
    const tags = [
      ...(action === "create"
        ? []
        : [
            {
              name: "v1",
              commit: {
                sha:
                  action === "skip"
                    ? newerSha
                    : action === "noop"
                      ? targetSha
                      : oldSha,
              },
            },
          ]),
      { name: "v1.9.9", commit: { sha: oldSha } },
      { name: "v1.10.0", commit: { sha: listedPointSha } },
      ...(action === "skip"
        ? [{ name: "v1.11.0", commit: { sha: newerSha } }]
        : []),
    ];
    const releases = tags
      .filter((tag) => tag.name !== "v1")
      .map((tag) => ({
        tag_name: tag.name,
        draft: false,
        prerelease: false,
        published_at: "2026-01-01T00:00:00Z",
      }));
    writeFileSync(
      ghPath,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"tags?per_page=100"* ]]; then
  printf '%s' "$TAGS_JSON"
elif [[ "$*" == *"releases?per_page=100"* ]]; then
  printf '%s' "$RELEASES_JSON"
else
  printf 'unexpected gh call: %s\\n' "$*" >&2
  exit 2
fi
`,
    );
    chmodSync(ghPath, 0o755);
    writeFileSync(
      gitPath,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "ls-remote" && "$*" == *"refs/tags/$RELEASE_TAG"* ]]; then
  count=0
  [[ ! -f "$POINT_READS_PATH" ]] || read -r count < "$POINT_READS_PATH"
  ((count += 1))
  printf '%s\\n' "$count" > "$POINT_READS_PATH"
  if [[ "$FAILURE" == "release-tag-move" && "$count" -ge 2 ]]; then
    "$REAL_GIT" --git-dir="$REMOTE_PATH" update-ref "refs/tags/$RELEASE_TAG" "$RACE_SHA"
  fi
elif [[ "$1" == "push" ]]; then
  if [[ "$FAILURE" == "major-race" || "$FAILURE" == "create-race" ]]; then
    "$REAL_GIT" --git-dir="$REMOTE_PATH" update-ref "refs/tags/$MAJOR_TAG" "$RACE_SHA"
  fi
fi
exec "$REAL_GIT" "$@"
`,
    );
    chmodSync(gitPath, 0o755);

    let output = "";
    let error: Error | undefined;
    try {
      output = execFileSync(
        "bash",
        [resolve(".github/scripts/update-major-tag.sh")],
        {
          cwd: workspace,
          encoding: "utf8",
          env: {
            ...process.env,
            FAILURE: failure,
            GITHUB_REPOSITORY: "owner/repository",
            MAJOR_TAG: "v1",
            PATH: `${binDirectory}:${process.env.PATH}`,
            POINT_READS_PATH: pointReadsPath,
            RACE_SHA: raceSha,
            REAL_GIT: realGit,
            RELEASES_JSON: JSON.stringify([releases]),
            RELEASE_TAG: "v1.10.0",
            REMOTE_PATH: remote,
            TAGS_JSON: JSON.stringify([tags]),
            TARGET_SHA: targetSha,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } catch (caught) {
      const failureOutput = caught as {
        stderr?: Buffer | string;
        stdout?: Buffer | string;
      };
      error = new Error(
        failureOutput.stderr?.toString().trim() ||
          failureOutput.stdout?.toString().trim() ||
          "release update failed",
        { cause: caught },
      );
    }
    return {
      error,
      initialMajorSha,
      majorDirectOid: remoteOid("refs/tags/v1"),
      majorSha: remoteOid("refs/tags/v1^{}") ?? remoteOid("refs/tags/v1"),
      newerSha,
      output,
      targetSha,
    };
  } finally {
    rmSync(directory, { recursive: true });
  }
}

describe("release workflow", () => {
  it("runs only when a GitHub release is published", () => {
    const releaseWorkflow = workflow();

    expect(Object.keys(releaseWorkflow.on)).toEqual(["release"]);
    expect(releaseWorkflow.on.release.types).toEqual(["published"]);
  });

  it("validates the candidate before lease-guarded atomic promotion", () => {
    const steps = workflow().jobs.release.steps;
    const gate = requiredStep(
      steps,
      (step) => step.run?.includes("verify-release-checks.mjs") ?? false,
      "immutable release gate",
    );
    const promotion = requiredStep(
      steps,
      (step) => step.run?.includes("git push --atomic") ?? false,
      "atomic promotion",
    );
    const cleanup = requiredStep(
      steps,
      (step) => step.run?.includes('origin ":refs/heads/$TEMP_REF"') ?? false,
      "validated-branch cleanup",
    );

    expect(gate.run).toContain("--required-check 'ci.yml::Node CI'");
    expect(gate.run).toContain(
      "--required-check 'prek-autofix-review.yml::review'",
    );
    expect(gate.run).toContain('--sha "$CANDIDATE_SHA"');
    expect(promotion.run).toContain(
      '--force-with-lease="refs/heads/$RELEASE_TARGET:$TARGET_SHA"',
    );
    expect(promotion.env).toMatchObject({
      RELEASE_TARGET: "${{ steps.base.outputs.target }}",
    });
    expect(promotion.run).toContain(
      '--force-with-lease="refs/tags/$RELEASE_TAG:$ORIGINAL_TAG_OID"',
    );
    expect(cleanup.run).toContain(
      '--force-with-lease="refs/heads/$TEMP_REF:$CANDIDATE_SHA"',
    );
  });

  it.each([
    ["stable", "v2.0.3", "2.0.2", "v2.0.1", "2.0.2", "v2"],
    [
      "prerelease",
      "v2.1.0-beta.2",
      "2.1.0-beta.1",
      "v2.1.0-beta.1",
      "2.1.0-beta.2",
      "v2.1.0-beta.01",
    ],
  ] as const)(
    "updates package metadata to a valid %s version",
    (
      _kind,
      releaseTag,
      currentVersion,
      downgradeTag,
      downgradeCurrentVersion,
      invalidTag,
    ) => {
      const version = releaseTag.slice(1);
      const prepared = prepareRelease(releaseTag, currentVersion);

      expect(prepared.output).toMatch(
        /^major-tag=v2\nsource-sha=[0-9a-f]{40}\n$/,
      );
      expect(prepared.packageJson.version).toBe(version);
      expect(prepared.packageLock.version).toBe(version);
      expect(prepared.packageLock.packages[""].version).toBe(version);
      expect(() =>
        prepareRelease(downgradeTag, downgradeCurrentVersion),
      ).toThrow(/downgrade/u);
      expect(() => prepareRelease(invalidTag, currentVersion)).toThrow(
        /vMAJOR\.MINOR\.PATCH/u,
      );
    },
  );

  it("enforces SemVer prerelease identifiers before inspecting release refs", () => {
    expect(runPrereleaseValidation("v2.1.0-beta.01")).toBeDefined();
    expect(runPrereleaseValidation("v2.1.0-beta.1")).toBeUndefined();
    expect(runPrereleaseValidation("v2.1.0-beta.rc-1")).toBeUndefined();
  });

  it.each([
    ["new release", "1.2.3", "1.2.4"],
    ["release rerun", "1.2.4", "1.2.4"],
  ] as const)(
    "builds a candidate for a %s",
    (_scenario, currentVersion, releaseVersion) => {
      const result = runCandidateConstruction(
        `v${releaseVersion}`,
        currentVersion,
      );

      expect(result.error).toBeUndefined();
      expect(result.packageVersion).toBe(releaseVersion);
      expect(result.lockVersion).toBe(releaseVersion);
      expect(result.bundle).toContain(`var version = "${releaseVersion}";`);
    },
  );

  it("isolates candidate construction from privileged release mutation", () => {
    const releaseWorkflow = workflow();
    const candidate = releaseWorkflow.jobs.candidate;
    const release = releaseWorkflow.jobs.release;
    const prerelease = releaseWorkflow.jobs.prerelease;
    const steps = release.steps;
    const metadata = requiredStep(
      steps,
      (step) => step.id === "base",
      "release metadata",
    );
    const validationPush = requiredStep(
      steps,
      (step) => step.run?.includes("refs/heads/$temp_ref") ?? false,
      "validation branch publication",
    );
    const finalIdentity = requiredStep(
      steps,
      (step) =>
        step.run?.includes('git show "$expected_sha:package.json"') ?? false,
      "final release identity",
    );
    const preparationGate = requiredStep(
      steps,
      (step) =>
        step.run?.includes("Read-only candidate construction must succeed") ??
        false,
      "new-release preparation gate",
    );
    const staging = requiredStep(
      steps,
      (step) =>
        step.run?.includes(
          "expected_paths=(dist/index.js package-lock.json package.json)",
        ) ?? false,
      "read-only candidate validation",
    );
    const candidateCheckout = requiredStep(
      candidate.steps,
      (step) => step.uses?.startsWith("actions/checkout@") ?? false,
      "candidate checkout",
    );
    const candidateArtifact = requiredStep(
      candidate.steps,
      (step) => step.uses?.startsWith("actions/upload-artifact@") ?? false,
      "candidate artifact export",
    );

    expect(metadata.env).toMatchObject({
      DEFAULT_BRANCH: "${{ github.event.repository.default_branch }}",
      RELEASE_TARGET: "${{ github.event.release.target_commitish }}",
    });
    expect(metadata.run).toContain(
      'if [[ "$RELEASE_TARGET" != "$DEFAULT_BRANCH" ]]',
    );
    expect(metadata.run).toContain(
      'git diff --name-only "$tag_sha^" "$tag_sha"',
    );
    expect(candidate.if).toBe("github.event.release.prerelease == false");
    expect(candidateCheckout.with?.ref).toBe(
      "${{ github.event.release.tag_name }}",
    );
    expect(
      String(candidateArtifact.with?.path).trim().split("\n").sort(),
    ).toEqual(["dist/index.js", "package-lock.json", "package.json"]);
    expect(candidate.outputs?.sha).toBe("${{ steps.revision.outputs.sha }}");
    const candidateRevision = requiredStep(
      candidate.steps,
      (step) => step.id === "revision",
      "candidate revision export",
    );
    expect(candidateRevision.run).toContain("git rev-parse HEAD");
    expect(release.needs).toBe("candidate");
    expect(release.if).toContain("always()");
    expect(release.if).toContain("!cancelled()");
    expect(release.if).toContain("github.event.release.prerelease == false");
    expect(
      [...candidate.steps, ...release.steps]
        .filter((step) => step.uses !== undefined)
        .every((step) => step.uses?.startsWith("actions/")),
    ).toBe(true);
    expect(release.steps.some((step) => step.run?.includes("npm "))).toBe(
      false,
    );
    expect(preparationGate.if).toContain("steps.base.outputs.resume != 'true'");
    expect(preparationGate.if).toContain("needs.candidate.result != 'success'");
    expect(staging.if).toBe("steps.base.outputs.resume != 'true'");
    expect(staging.env).toMatchObject({
      CANDIDATE_SHA: "${{ needs.candidate.outputs.sha }}",
      TAG_SHA: "${{ steps.base.outputs.tag-sha }}",
    });
    expect(staging.run).toContain('[[ "$CANDIDATE_SHA" != "$TAG_SHA" ]]');
    expect(staging.run).toContain(
      'cd "$RELEASE_ARTIFACT" && find . -type f -print',
    );
    expect(staging.run).not.toMatch(
      /\.github\/scripts\/|\b(?:bash|node|sh)\s+["']?\$RELEASE_ARTIFACT/u,
    );
    expect(prerelease.if).toBe("github.event.release.prerelease == true");
    expect(
      prerelease.steps.some((step) => step.run?.includes("git push")),
    ).toBe(false);
    expect(validationPush.run).toContain(
      'git push origin "$CANDIDATE_SHA:refs/heads/$temp_ref"',
    );
    expect(validationPush.run).not.toContain('git push origin "HEAD:');
    expect(finalIdentity.run).toContain(
      'git cat-file -e "$expected_sha:dist/index.js"',
    );
  });

  it("rejects candidate metadata changes beyond release version fields", () => {
    const packageMetadata = {
      name: "candidate-fixture",
      private: true,
      version: "1.0.1",
    };

    expect(runCandidateStaging(packageMetadata).error).toBeUndefined();
    expect(
      runCandidateStaging({
        ...packageMetadata,
        scripts: { preinstall: "unexpected" },
      }).error,
    ).toBeDefined();
    expect(
      runCandidateStaging(packageMetadata, {
        lockfileVersion: 3,
        name: "candidate-fixture",
        packages: {
          "": {
            name: "candidate-fixture",
            packageManager: "unexpected",
            version: "1.0.1",
          },
        },
        version: "1.0.1",
      }).error,
    ).toBeDefined();
  });

  it("rejects a candidate artifact from a different release revision before staging", () => {
    const result = runCandidateStaging(
      {
        name: "candidate-fixture",
        private: true,
        version: "1.0.1",
      },
      undefined,
      "1".repeat(40),
      "2".repeat(40),
    );

    expect(result.error).toBeDefined();
    expect(result.error?.message).toContain(
      "does not match the validated release tag",
    );
    expect(result.hasStagedChanges).toBe(false);
  });

  it("keeps release credentials scoped to write-capable jobs", () => {
    const releaseWorkflow = workflow();
    const checkouts = Object.values(releaseWorkflow.jobs).flatMap((job) =>
      job.steps.filter((step) => step.uses?.startsWith("actions/checkout@")),
    );

    expect(releaseWorkflow.permissions).toEqual({ contents: "read" });
    expect(releaseWorkflow.jobs.candidate.permissions).toEqual({
      contents: "read",
    });
    expect(releaseWorkflow.jobs.prerelease.permissions).toEqual({
      contents: "read",
    });
    expect(releaseWorkflow.jobs.release.permissions).toEqual({
      actions: "write",
      checks: "read",
      contents: "write",
      statuses: "write",
    });
    expect(checkouts.length).toBeGreaterThan(0);
    for (const checkout of checkouts) {
      expect(checkout.with?.["persist-credentials"]).toBe(false);
    }
  });

  it.each([
    ["ci.yml", "node", "${{ inputs.expected_sha || github.sha }}"],
    [
      "prek-autofix-review.yml",
      "review",
      "${{ github.event.pull_request.head.sha || inputs.expected_sha || github.sha }}",
    ],
  ])(
    "requires %s to check out the exact dispatched SHA",
    (workflowName, jobName, checkoutRef) => {
      const gateWorkflow = parse(
        readFileSync(`.github/workflows/${workflowName}`, "utf8"),
      ) as {
        on: {
          workflow_dispatch: {
            inputs: Record<string, Record<string, unknown>>;
          };
        };
        jobs: Record<string, WorkflowJob>;
      };
      const expectedSha = gateWorkflow.on.workflow_dispatch.inputs.expected_sha;
      const job = gateWorkflow.jobs[jobName];
      const guard = job?.steps.find((step) =>
        step.run?.includes('test "$WORKFLOW_SHA" = "$EXPECTED_SHA"'),
      );
      const checkout = job?.steps.find((step) =>
        step.uses?.startsWith("actions/checkout@"),
      );

      expect(expectedSha).toMatchObject({ required: true, type: "string" });
      expect(guard?.run).toContain('[[ "$EXPECTED_SHA" =~ ^[0-9a-f]{40}$ ]]');
      expect(checkout?.with?.ref).toBe(checkoutRef);
      expect(checkout?.with?.["persist-credentials"]).toBe(false);
    },
  );

  it("keeps moving major tags monotonic across releases and reruns", () => {
    const oldSha = "1".repeat(40);
    const targetSha = "2".repeat(40);
    const newerSha = "3".repeat(40);

    expect(
      decideRelease("v1.10.0", targetSha, [
        { name: "v1.9.9", commit: { sha: oldSha } },
        { name: "v1.10.0", commit: { sha: targetSha } },
      ]),
    ).toBe(`create\t${targetSha}`);
    expect(
      decideRelease("v1.10.0", targetSha, [
        { name: "v1", commit: { sha: oldSha } },
        { name: "v1.9.9", commit: { sha: oldSha } },
        { name: "v1.10.0", commit: { sha: targetSha } },
      ]),
    ).toBe(`update\t${targetSha}\t${oldSha}`);
    expect(
      decideRelease("v1.10.12", targetSha, [
        { name: "v1", commit: { sha: oldSha } },
        { name: "v1.10.9", commit: { sha: oldSha } },
        { name: "v1.10.12", commit: { sha: targetSha } },
      ]),
    ).toBe(`update\t${targetSha}\t${oldSha}`);
    expect(
      decideRelease("v1.10.0", targetSha, [
        { name: "v1", commit: { sha: targetSha } },
        { name: "v1.10.0", commit: { sha: targetSha } },
      ]),
    ).toBe("noop\t");
    expect(
      decideRelease("v1.10.0", targetSha, [
        { name: "v1", commit: { sha: newerSha } },
        { name: "v1.10.0", commit: { sha: targetSha } },
        { name: "v1.11.0", commit: { sha: newerSha } },
      ]),
    ).toBe("skip\t");
  });

  it("promotes only the triggering release verified by the read-only job", () => {
    const oldSha = "1".repeat(40);
    const triggeringSha = "2".repeat(40);
    const unverifiedNewerSha = "3".repeat(40);
    const tags = [
      { name: "v1", commit: { sha: oldSha } },
      { name: "v1.9.9", commit: { sha: oldSha } },
      { name: "v1.10.0", commit: { sha: triggeringSha } },
      { name: "v1.11.0", commit: { sha: unverifiedNewerSha } },
    ];

    expect(decideRelease("v1.10.0", triggeringSha, tags)).toBe(
      `update\t${triggeringSha}\t${oldSha}`,
    );
  });

  it("allows a surviving verified pending job to advance after replacement", () => {
    const oldSha = "1".repeat(40);
    const runningSha = "2".repeat(40);
    const replacedPendingSha = "3".repeat(40);
    const survivingPendingSha = "4".repeat(40);
    const tagsBeforeRunningUpdate = [
      { name: "v1", commit: { sha: oldSha } },
      { name: "v1.9.9", commit: { sha: oldSha } },
      { name: "v1.10.0", commit: { sha: runningSha } },
      { name: "v1.11.0", commit: { sha: replacedPendingSha } },
      { name: "v1.12.0", commit: { sha: survivingPendingSha } },
    ];

    expect(decideRelease("v1.10.0", runningSha, tagsBeforeRunningUpdate)).toBe(
      `update\t${runningSha}\t${oldSha}`,
    );

    const tagsAfterRunningUpdate = tagsBeforeRunningUpdate.map((tag) =>
      tag.name === "v1" ? { ...tag, commit: { sha: runningSha } } : tag,
    );
    expect(
      decideRelease("v1.12.0", survivingPendingSha, tagsAfterRunningUpdate),
    ).toBe(`update\t${survivingPendingSha}\t${runningSha}`);
  });

  it.each([
    ["lightweight", false],
    ["annotated", true],
  ] as const)(
    "updates an existing %s moving tag through a real Git remote",
    (_kind, annotated) => {
      const result = runReleaseUpdate("update", "none", annotated);

      expect(result.error).toBeUndefined();
      expect(result.initialMajorSha).not.toBe(result.targetSha);
      expect(result.majorSha).toBe(result.targetSha);
      expect(result.majorDirectOid).toBe(result.targetSha);
    },
  );

  it("creates a missing moving tag through a real Git remote", () => {
    const result = runReleaseUpdate("create");

    expect(result.error).toBeUndefined();
    expect(result.initialMajorSha).toBeUndefined();
    expect(result.majorSha).toBe(result.targetSha);
  });

  it.each(["noop", "skip"] as const)(
    "leaves the moving tag unchanged for a %s decision",
    (action) => {
      const result = runReleaseUpdate(action);

      expect(result.error).toBeUndefined();
      expect(result.majorSha).toBe(result.initialMajorSha);
      expect(result.output).toMatch(/leaving it unchanged|already points/u);
      if (action === "skip") expect(result.majorSha).toBe(result.newerSha);
    },
  );

  it("accepts a stale paginated SHA after verifying the exact remote tag", () => {
    const result = runReleaseUpdate("create", "none", false, true);

    expect(result.error).toBeUndefined();
    expect(result.majorSha).toBe(result.targetSha);
  });

  it("fails closed when the exact finalized release ref does not match", () => {
    const result = runReleaseUpdate("update", "point-mismatch");

    expect(result.error?.message).toMatch(
      /does not match its exact finalized tag ref/u,
    );
    expect(result.majorSha).toBe(result.initialMajorSha);
  });

  it.each([
    ["update", "major-race"],
    ["create", "create-race"],
  ] as const)(
    "rejects a competing %s through the real Git lease",
    (action, failure) => {
      const result = runReleaseUpdate(action, failure, action === "update");

      expect(result.error).toBeDefined();
      expect(result.majorSha).not.toBe(result.targetSha);
    },
  );

  it.each(["update", "create", "noop", "skip"] as const)(
    "rejects release-tag movement before completing a %s decision",
    (action) => {
      const result = runReleaseUpdate(action, "release-tag-move");

      expect(result.error?.message).toMatch(
        /changed while its update was being prepared/u,
      );
      expect(result.majorSha).toBe(result.initialMajorSha);
    },
  );

  it("fails closed when moving-tag monotonicity cannot be proven", () => {
    const targetSha = "2".repeat(40);

    expect(() =>
      decideRelease("v2.10.12", targetSha, [
        { name: "v2", commit: { sha: "f".repeat(40) } },
        { name: "v2.10.12", commit: { sha: targetSha } },
      ]),
    ).toThrow(/known finalized stable release/);
  });

  it("ignores tags without a successfully published stable release", () => {
    const targetSha = "2".repeat(40);
    const futureSha = "3".repeat(40);
    const tags = [
      { name: "v1.10.0", commit: { sha: targetSha } },
      { name: "v1.11.0", commit: { sha: futureSha } },
      { name: "v1.12.0", commit: { sha: futureSha } },
      { name: "v1.13.0", commit: { sha: futureSha } },
    ];
    const releases = [
      {
        tag_name: "v1.10.0",
        draft: false,
        prerelease: false,
        published_at: "2026-01-01T00:00:00Z",
      },
      {
        tag_name: "v1.12.0",
        draft: true,
        prerelease: false,
        published_at: null,
      },
      {
        tag_name: "v1.13.0",
        draft: false,
        prerelease: true,
        published_at: "2026-01-02T00:00:00Z",
      },
    ];

    expect(decideRelease("v1.10.0", targetSha, tags, releases)).toBe(
      `create\t${targetSha}`,
    );
  });

  it("requires the triggering release and every eligible release to match a tag", () => {
    const targetSha = "2".repeat(40);
    const published = (tagName: string) => ({
      tag_name: tagName,
      draft: false,
      prerelease: false,
      published_at: "2026-01-01T00:00:00Z",
    });

    expect(() =>
      decideRelease(
        "v1.10.0",
        targetSha,
        [{ name: "v1.10.0", commit: { sha: targetSha } }],
        [
          {
            ...published("v1.10.0"),
            prerelease: true,
          },
        ],
      ),
    ).toThrow(/not a published stable release/);
    expect(() =>
      decideRelease(
        "v1.10.0",
        targetSha,
        [{ name: "v1.10.0", commit: { sha: targetSha } }],
        [published("v1.10.0"), published("v1.11.0")],
      ),
    ).toThrow(/has no matching tag/);
  });
});
