import * as toolCache from "@actions/tool-cache";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const PREK_VERSION = "0.4.11";
const RELEASE_ROOT = `https://github.com/j178/prek/releases/download/v${PREK_VERSION}`;

interface Release {
  readonly archiveSha256: string;
  readonly binarySha256: string;
  readonly target: string;
}

function release(): Release {
  if (process.arch === "x64") {
    return {
      target: "x86_64-unknown-linux-gnu",
      archiveSha256:
        "038f67b69c1d1547e920532f975a0ec1a51453b962f1a2d9148abcb252a6d194",
      binarySha256:
        "c8ff33f4745f31fd770adfce904bb09108365542fd07580f3c2b1f783879495a",
    };
  }
  if (process.arch === "arm64") {
    return {
      target: "aarch64-unknown-linux-gnu",
      archiveSha256:
        "22edbb9353ca948b8260a904abedc352d0087944170785adab8d1fa1025534e7",
      binarySha256:
        "c6388688a4e98ffaff076e94ce9b65fda377101219207e76099cef0b0ce29482",
    };
  }
  throw new Error(`Unsupported prek architecture: ${process.arch}`);
}

/** Install the source-pinned official prek release and return its binary path. */
export async function installPrek(): Promise<string> {
  const pinned = release();
  const cached = toolCache.find("prek", PREK_VERSION, process.arch);
  if (cached !== "") {
    const cachedBinary = path.join(cached, "prek");
    await verifyFileSha256(
      cachedBinary,
      pinned.binarySha256,
      "cached prek binary",
    );
    return cachedBinary;
  }

  const directory = await mkdtemp(path.join(tmpdir(), "prek-download-"));
  try {
    const asset = `prek-${pinned.target}.tar.gz`;
    const archive = await toolCache.downloadTool(`${RELEASE_ROOT}/${asset}`);
    const checksumFile = await toolCache.downloadTool(
      `${RELEASE_ROOT}/${asset}.sha256`,
    );
    await verifySha256(
      archive,
      await readFile(checksumFile, "utf8"),
      asset,
      pinned.archiveSha256,
    );
    const extracted = await toolCache.extractTar(archive, directory);
    const binary = path.join(extracted, `prek-${pinned.target}`, "prek");
    await verifyFileSha256(binary, pinned.binarySha256, "prek binary");
    await chmod(binary, 0o755);
    const cachedDirectory = await toolCache.cacheDir(
      path.dirname(binary),
      "prek",
      PREK_VERSION,
      process.arch,
    );
    const cachedBinary = path.join(cachedDirectory, "prek");
    await verifyFileSha256(
      cachedBinary,
      pinned.binarySha256,
      "cached prek binary",
    );
    return cachedBinary;
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

async function verifyFileSha256(
  file: string,
  expected: string,
  description: string,
): Promise<void> {
  const digest = createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
  if (digest !== expected) {
    throw new Error(`SHA256 verification failed for ${description}`);
  }
}

async function verifySha256(
  archive: string,
  checksumContents: string,
  asset: string,
  pinnedDigest: string,
): Promise<void> {
  const match = checksumContents.match(/^([a-fA-F0-9]{64})(?:\s+\*?(\S+))?/u);
  if (
    match === null ||
    (match[2] !== undefined && path.basename(match[2]) !== asset)
  ) {
    throw new Error(`Invalid SHA256 checksum file for ${asset}`);
  }
  const digest = createHash("sha256")
    .update(await readFile(archive))
    .digest("hex");
  if (digest !== match[1].toLowerCase() || digest !== pinnedDigest) {
    throw new Error(`SHA256 verification failed for ${asset}`);
  }
}
