import * as core from "@actions/core";
import { getOctokit } from "@actions/github";
import * as yaml from "js-yaml";
import { readFileSync } from "node:fs";
import { createGzip } from "node:zlib";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { pack } from "tar-fs";
enum SpmOs {
  Linux = "linux",
  Macos = "macos",
  Windows = "windows",
}
enum SpmCpu {
  X86_64 = "x86_64",
  Aarch64 = "aarch64",
}
interface SpmJson {
  version: number;
  extensions: {
    [k: string]: {
      description: string;
      platforms: UploadedPlatform[];
    };
  };
}

interface UploadedPlatform {
  os: SpmOs;
  cpu: SpmCpu;
  asset_name: string;
  asset_sha256: string;
  asset_md5: string;
}
function parsePlatformString(platform: string): [SpmOs, SpmCpu] {
  return [SpmOs.Linux, SpmCpu.X86_64];
}

function targz(files: { name: string; data: Buffer }[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    console.log("targz files: ", files[0].name, files[0]);

    // @ts-ignore
    const tarStream = pack();

    for (const file of files) {
      tarStream.entry({ name: file.name }, file.data);
    }

    tarStream.finalize();

    const gzip = createGzip();

    const chunks: Buffer[] = [];
    tarStream
      .pipe(gzip)
      .on("data", (chunk) => {
        chunks.push(chunk);
      })
      .on("end", () => {
        const buffer = Buffer.concat(chunks);
        resolve(buffer);
      })
      .on("error", reject);
  });
}

interface Platform {
  os: SpmOs;
  cpu: SpmCpu;
  paths: string | string[];
}

function parsePlatformInput(input: string): Platform[] {
  const mapping = yaml.load(input);
  assertPlatformInputValid(mapping);

  return Object.keys(mapping).map(([platform, path]) => {
    const [os, cpu] = parsePlatformString(platform);
    return {
      os,
      cpu,
      paths: path,
    };
  });
}
function assertPlatformInputValid(
  mapping: any
): asserts mapping is { [key: string]: string } {
  // TODO finish
  mapping;
}
async function run(): Promise<void> {
  try {
    const octokit = getOctokit(
      core.getInput("github-token", { required: true })
    );
    const PROJECT = core.getInput("name", { required: true });
    const platformsInput = core.getInput("platforms", {
      required: true,
    });
    core.info(JSON.stringify({ PROJECT, platformsInput }));
    const platforms = parsePlatformInput(platformsInput);
    core.info(JSON.stringify({ platforms }));

    const VERSION = process.env.GITHUB_REF_NAME!;

    const [owner, repo] = process.env.GITHUB_REPOSITORY!.split("/");

    const release = await octokit.rest.repos.getReleaseByTag({
      owner,
      repo,
      tag: process.env.GITHUB_REF!.replace("refs/tags/", ""),
    });
    const release_id = release.data.id;

    async function uploadPlatform(
      platform: Platform
    ): Promise<UploadedPlatform> {
      const { paths, os, cpu } = platform;

      const tar = await targz(
        (typeof paths === "string" ? [paths] : paths).map((path) => ({
          name: basename(path),
          data: readFileSync(path),
        }))
      );

      const asset_name = `${PROJECT}-${VERSION}-${os}-${cpu}.tar.gz`;
      const asset_md5 = createHash("md5").update(tar).digest("base64");
      const asset_sha256 = createHash("sha256").update(tar).digest("hex");

      await octokit.rest.repos.uploadReleaseAsset({
        owner,
        repo,
        release_id,
        name: asset_name,
        // @ts-ignore seems to accept a buffer just fine
        data: tar,
      });

      return {
        os,
        cpu,
        asset_name,
        asset_sha256,
        asset_md5,
      };
    }

    const spm_json = {
      version: 0,
      extensions: {
        ["TODO"]: {
          description: "",
          platforms: await Promise.all(
            platforms.map((platform) => uploadPlatform(platform))
          ),
        },
      },
    };

    await octokit.rest.repos.uploadReleaseAsset({
      owner,
      repo,
      release_id,
      name: "spm.json",
      data: JSON.stringify(spm_json),
    });

    core.debug(`TODO ...`);
    core.setOutput("TODO", "TODO");
  } catch (error) {
    if (error instanceof Error) core.setFailed(error.message);
  }
}

run();
