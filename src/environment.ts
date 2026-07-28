const BLOCKED_GIT_VARIABLES = new Set([
  "GIT_ASKPASS",
  "GIT_CEILING_DIRECTORIES",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_SYSTEM",
  "GIT_DIR",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_EXEC_PATH",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_OPTIONAL_LOCKS",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_TERMINAL_PROMPT",
  "GIT_WORK_TREE",
  "SSH_ASKPASS",
]);

const TRUSTED_SYSTEM_PATH = "/usr/bin:/bin";

/** Return a child environment without action inputs or caller-controlled Git behavior. */
export function sanitizedChildEnvironment(
  additions: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (isBlocked(key)) continue;
    environment[key] = value;
  }
  for (const [key, value] of Object.entries(additions)) {
    if (isBlocked(key)) continue;
    environment[key] = value;
  }
  return {
    ...environment,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    PATH: TRUSTED_SYSTEM_PATH,
  };
}

/** Prefix Git arguments with settings that suppress hooks and credential helpers. */
export function hardenedGitArguments(
  arguments_: readonly string[],
): readonly string[] {
  return [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "credential.helper=",
    ...arguments_,
  ];
}

function isBlocked(key: string): boolean {
  return (
    key.startsWith("INPUT_") ||
    key.startsWith("LD_") ||
    key.startsWith("DYLD_") ||
    key.startsWith("GIT_CONFIG_KEY_") ||
    key.startsWith("GIT_CONFIG_VALUE_") ||
    key.startsWith("GIT_TRACE") ||
    BLOCKED_GIT_VARIABLES.has(key)
  );
}
