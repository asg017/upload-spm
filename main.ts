import * as core from "@actions/core";
import { getOctokit } from "@actions/github";
import * as glob from "@actions/glob";
import * as yaml from "js-yaml";
import { readFileSync } from "node:fs";
import { createGzip } from "node:zlib";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { pack } from "tar-fs";
import AdmZip from "adm-zip";

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
  loadable: UploadedPlatform[];
  static?: UploadedPlatform[];
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

function zip(files: { name: string; data: Buffer }[]): Buffer {
  const zip = new AdmZip();
  for (const file of files) {
    zip.addFile(file.name, file.data);
  }
  return zip.toBuffer();
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
    const skipSpm = core.getInput("skip-spm", { required: false })
      ? core.getBooleanInput("skip-spm", { required: false })
      : false;
    const assetNameTemplate = core.getInput("asset-name-template", {
      required: false,
    });

    const outputAssetChecksums: { name: string; checksum: string }[] = [];

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
    ): Promise<{ loadable: UploadedPlatform; static?: UploadedPlatform }> {
      const { paths, os, cpu } = platform;
      const files = (typeof paths === "string" ? [paths] : paths).map(
        (path) => ({
          name: basename(path),
          data: readFileSync(path),
        })
      );
      const loadableFiles = files.filter((d) =>
        /\.(dylib|dll|so)$/.test(d.name)
      );
      const staticFiles = files.filter((d) => /\.(a|h)$/.test(d.name));

      let loadableData: Buffer | undefined;
      let staticData: Buffer | undefined;
      let extension: string;
      if (os === "windows") {
        loadableData = zip(loadableFiles);
        if (staticFiles.length > 0) {
          staticData = zip(staticFiles);
        }
        extension = `zip`;
      } else {
        loadableData = await targz(loadableFiles);
        if (staticFiles.length > 0) {
          staticData = await targz(staticFiles);
        }
        extension = `tar.gz`;
      }
      const loadableAssetMd5 = createHash("md5")
        .update(loadableData)
        .digest("base64");
      const loadableAssetSha256 = createHash("sha256")
        .update(loadableData)
        .digest("hex");
      const loadableAssetName =
        assetNameTemplate
          .replace("$PROJECT", PROJECT)
          .replace("$VERSION", VERSION)
          .replace("$TYPE", "loadable")
          .replace("$OS", os)
          .replace("$CPU", cpu) + `.${extension}`;

      const loadable = {
        os,
        cpu,
        asset_name: loadableAssetName,
        asset_md5: loadableAssetMd5,
        asset_sha256: loadableAssetSha256,
      };

      await octokit.rest.repos.uploadReleaseAsset({
        owner,
        repo,
        release_id,
        name: loadableAssetName,
        // @ts-ignore seems to accept a buffer just fine
        data: loadableData,
      });

      let static_;
      if (staticData !== undefined) {
        const staticAssetMd5 = createHash("md5")
          .update(staticData)
          .digest("base64");
        const staticAssetSha256 = createHash("sha256")
          .update(loadableData)
          .digest("hex");
        const staticAssetName =
          assetNameTemplate
            .replace("$PROJECT", PROJECT)
            .replace("$VERSION", VERSION)
            .replace("$TYPE", "static")
            .replace("$OS", os)
            .replace("$CPU", cpu) + `.${extension}`;
        static_ = {
          os,
          cpu,
          asset_name: staticAssetName,
          asset_md5: staticAssetMd5,
          asset_sha256: staticAssetSha256,
        };
        await octokit.rest.repos.uploadReleaseAsset({
          owner,
          repo,
          release_id,
          name: staticAssetName,
          // @ts-ignore seems to accept a buffer just fine
          data: staticData,
        });
      }

      return {
        loadable,
        static: static_,
      };
    }

    const uploadedPlatforms = await Promise.all(
      platforms.map((platform) => uploadPlatform(platform))
    );
    for (const uploadPlatform of uploadedPlatforms) {
      outputAssetChecksums.push({
        name: uploadPlatform.loadable.asset_name,
        checksum: uploadPlatform.loadable.asset_sha256,
      });
      if (uploadPlatform.static) {
        outputAssetChecksums.push({
          name: uploadPlatform.static.asset_name,
          checksum: uploadPlatform.static.asset_sha256,
        });
      }
    }

    if (!skipSpm) {
      const loadable = uploadedPlatforms.map((d) => d.loadable);
      const static_ = uploadedPlatforms
        .filter((d) => d.static !== undefined)
        .map((d) => d.static!);
      const spm_json: SpmJson = {
        version: 0,
        description: "",
        loadable,
        static: static_.length > 0 ? static_ : undefined,
      };
      const name = "spm.json";
      const data = JSON.stringify(spm_json);
      const checksum = createHash("sha256").update(data).digest("hex");

      const spmAsset = await octokit.rest.repos.uploadReleaseAsset({
        owner,
        repo,
        release_id,
        name,
        data,
      });

      core.setOutput("spm_link", spmAsset.url);
      outputAssetChecksums.push({
        name,
        checksum,
      });
    }

    core.setOutput("number_platforms", uploadedPlatforms.length);
    core.setOutput(
      "asset-checksums",
      outputAssetChecksums.map((d) => `${d.checksum} ${d.name}`).join("\n")
    );
  } catch (error) {
    if (error instanceof Error) core.setFailed(error.message);
  }
}

run();
