import * as core from "@actions/core";
import { getOctokit } from "@actions/github";
import * as glob from "@actions/glob";
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
  description: string;
  platforms: UploadedPlatform[];
}

interface UploadedPlatform {
  os: SpmOs;
  cpu: SpmCpu;
  asset_name: string;
  asset_sha256: string;
  asset_md5: string;
}
function parsePlatformString(platform: string): [SpmOs, SpmCpu] {
  const [os, cpu] = platform.split("-");
  return [os as SpmOs, cpu as SpmCpu];
}

function targz(files: { name: string; data: Buffer }[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // @ts-ignore
    const tarStream = pack();

    for (const file of files) {
      core.debug(`entry ${file.name}`);
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
  paths: string[];
}

async function parsePlatformInput(input: string): Promise<Platform[]> {
  const mapping = yaml.load(input) as { [key: string]: string | string[] };

  return await Promise.all(
    Object.entries(mapping).map(async ([platform, rawPaths]) => {
      const [os, cpu] = parsePlatformString(platform);
      const paths: string[] = Array.isArray(rawPaths)
        ? (
            await Promise.all(
              rawPaths.map((path) => glob.create(path).then((g) => g.glob()))
            )
          ).flatMap((d) => d)
        : await glob.create(rawPaths).then((g) => g.glob());
      return {
        os,
        cpu,
        paths,
      };
    })
  );
}
async function run(): Promise<void> {
  try {
    const VERSION = process.env.GITHUB_REF_NAME!;
    const PROJECT = core.getInput("name", { required: true });

    const octokit = getOctokit(
      core.getInput("github-token", { required: true })
    );
    const platforms = await parsePlatformInput(
      core.getInput("platforms", {
        required: true,
      })
    );

    const [owner, repo] = process.env.GITHUB_REPOSITORY!.split("/");
    const tag = process.env.GITHUB_REF!.replace("refs/tags/", "");

    const release = await octokit.rest.repos.getReleaseByTag({
      owner,
      repo,
      tag,
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

    const uploadedPlatforms = await Promise.all(
      platforms.map((platform) => uploadPlatform(platform))
    );
    const spm_json: SpmJson = {
      version: 0,
      description: "",
      platforms: uploadedPlatforms,
    };

    const spmAsset = await octokit.rest.repos.uploadReleaseAsset({
      owner,
      repo,
      release_id,
      name: "spm.json",
      data: JSON.stringify(spm_json),
    });
    core.setOutput("number_platforms", uploadPlatform.length);
    core.setOutput("spm_link", spmAsset.url);
  } catch (error) {
    if (error instanceof Error) core.setFailed(error.message);
  }
}

run();
