import { context, getOctokit } from "@actions/github";

import { resolveUpdateLog, resolveUpdateLogDefault } from "./update-log.mjs";
import {
  listPublishedReleases,
  releaseFeedVersion,
  releaseFeedVariants,
  selectPublishedReleases,
  signedReleasePlatforms,
} from "./release-feed.mjs";

// Add stable update JSON filenames
const UPDATE_TAG_NAME = "updater";
const UPDATE_JSON_FILE = "update.json";
const UPDATE_JSON_PROXY = "update-proxy.json";
const UPDATE_JSON_CNB = "update-cnb.json";
// Add alpha update JSON filenames
const ALPHA_TAG_NAME = "updater-alpha";
const ALPHA_UPDATE_JSON_FILE = "update.json";
const ALPHA_UPDATE_JSON_PROXY = "update-proxy.json";
const ALPHA_UPDATE_JSON_CNB = "update-cnb.json";

/// generate update.json
/// upload to update tag's release asset
async function resolveUpdater() {
  if (process.env.GITHUB_TOKEN === undefined) {
    throw new Error("GITHUB_TOKEN is required");
  }

  const options = { owner: context.repo.owner, repo: context.repo.repo };
  const github = getOctokit(process.env.GITHUB_TOKEN);

  const releases = await listPublishedReleases(github, options);
  const selected = selectPublishedReleases(releases);
  if (selected.stable) await processRelease(github, options, selected.stable, false);
  if (selected.preview) await processRelease(github, options, selected.preview, true);
}

// Process a release (stable or alpha) and generate update files
async function processRelease(github, options, release, isAlpha) {
  if (!release) return;
  const tag = { name: release.tag_name };

  try {
    const updateData = {
      ...releaseFeedVersion(tag.name),
      notes: await resolveUpdateLog(tag.name).catch(() =>
        resolveUpdateLogDefault().catch(() => "No changelog available")
      ),
      pub_date: release.published_at ?? new Date().toISOString(),
      platforms: await signedReleasePlatforms(release),
    };

    const { proxy: updateDataNew, cnb: updateDataCNB } = releaseFeedVariants(updateData);

    // Get the appropriate updater release based on isAlpha flag
    const releaseTag = isAlpha ? ALPHA_TAG_NAME : UPDATE_TAG_NAME;
    console.log(`Processing ${isAlpha ? "alpha" : "stable"} release:`, releaseTag);

    try {
      let updateRelease;

      try {
        const response = await github.rest.repos.getReleaseByTag({
          ...options,
          tag: releaseTag,
        });
        updateRelease = response.data;
        console.log(`Found existing ${releaseTag} release with ID: ${updateRelease.id}`);
      } catch (error) {
        // If release doesn't exist, create it
        if (error.status === 404) {
          console.log(`Release with tag ${releaseTag} not found, creating new release...`);
          const createResponse = await github.rest.repos.createRelease({
            ...options,
            tag_name: releaseTag,
            name: isAlpha ? "Auto-update Alpha Channel" : "Auto-update Stable Channel",
            body: `This release contains the update information for ${isAlpha ? "alpha" : "stable"} channel.`,
            prerelease: isAlpha,
            make_latest: "false",
          });
          updateRelease = createResponse.data;
          console.log(`Created new ${releaseTag} release with ID: ${updateRelease.id}`);
        } else {
          // If it's another error, throw it
          throw error;
        }
      }

      // File names based on release type
      const jsonFile = isAlpha ? ALPHA_UPDATE_JSON_FILE : UPDATE_JSON_FILE;
      const proxyFile = isAlpha ? ALPHA_UPDATE_JSON_PROXY : UPDATE_JSON_PROXY;
      const cnbFile = isAlpha ? ALPHA_UPDATE_JSON_CNB : UPDATE_JSON_CNB;

      // Delete existing assets with these names
      for (const asset of updateRelease.assets) {
        if (asset.name === jsonFile) {
          await github.rest.repos.deleteReleaseAsset({
            ...options,
            asset_id: asset.id,
          });
        }

        if (asset.name === proxyFile) {
          await github.rest.repos
            .deleteReleaseAsset({ ...options, asset_id: asset.id })
            .catch(console.error); // do not break the pipeline
        }

        if (asset.name === cnbFile) {
          await github.rest.repos
            .deleteReleaseAsset({ ...options, asset_id: asset.id })
            .catch(console.error); // do not break the pipeline
        }
      }

      // Upload new assets
      await github.rest.repos.uploadReleaseAsset({
        ...options,
        release_id: updateRelease.id,
        name: jsonFile,
        data: JSON.stringify(updateData, null, 2),
      });

      await github.rest.repos.uploadReleaseAsset({
        ...options,
        release_id: updateRelease.id,
        name: proxyFile,
        data: JSON.stringify(updateDataNew, null, 2),
      });

      await github.rest.repos.uploadReleaseAsset({
        ...options,
        release_id: updateRelease.id,
        name: cnbFile,
        data: JSON.stringify(updateDataCNB, null, 2),
      });

      console.log(
        `Successfully uploaded ${isAlpha ? "alpha" : "stable"} update files to ${releaseTag}`
      );
    } catch (error) {
      console.error(`Failed to process ${isAlpha ? "alpha" : "stable"} release:`, error.message);
      throw error;
    }
  } catch (error) {
    if (error.status === 404) {
      throw new Error(`Release not found for tag: ${tag.name}`);
    } else {
      console.error(`Failed to get release for tag: ${tag.name}`, error.message);
      throw error;
    }
  }
}

resolveUpdater().catch((error) => {
  console.error(error);
  process.exit(1);
});
