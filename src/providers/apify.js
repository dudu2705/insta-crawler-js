import { createMedia } from "../models.js";
import { InstagramDataProvider, ProviderResult } from "./base.js";

const APIFY_ACTOR_ID = "apify~instagram-scraper";
const APIFY_RUN_SYNC_URL = `https://api.apify.com/v2/acts/${APIFY_ACTOR_ID}/run-sync-get-dataset-items`;
const APIFY_TYPE_NAMES = { Image: "image", Video: "video", Sidecar: "carousel" };

export function apifyItemToModel(apifyItem) {
  const shortcode = apifyItem.shortCode;
  if (!shortcode) {
    return null;
  }
  const rawLikeCount = apifyItem.likesCount;
  return createMedia({
    shortcode,
    url: apifyItem.url || `https://www.instagram.com/p/${shortcode}/`,
    media_type: APIFY_TYPE_NAMES[apifyItem.type] ?? apifyItem.type,
    caption: apifyItem.caption,
    owner_username: apifyItem.ownerUsername,
    like_count: Number.isInteger(rawLikeCount) && rawLikeCount >= 0 ? rawLikeCount : null,
    comment_count: apifyItem.commentsCount,
    view_count: apifyItem.videoPlayCount || apifyItem.videoViewCount,
    taken_at: apifyItem.timestamp,
    hashtags: apifyItem.hashtags || [],
    source_strategy: "provider_apify",
  });
}

export class ApifyProvider extends InstagramDataProvider {
  static providerName = "apify";
  static apiKeyEnvironmentVariable = "APIFY_TOKEN";
  static supportedCapabilities = ["hashtag", "search", "profile_posts", "post"];

  async runActor(actorInput, capability, target) {
    const datasetItems = await this.sendRequest("POST", APIFY_RUN_SYNC_URL, {
      json: actorInput,
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
    });
    const normalizedItems = [];
    for (const datasetItem of datasetItems) {
      const media = apifyItemToModel(datasetItem);
      if (media) {
        normalizedItems.push(media);
      }
    }
    return new ProviderResult({
      providerName: this.providerName,
      capability,
      target,
      items: normalizedItems,
      rawResponses: [datasetItems],
      costNote: `pay per result: ${datasetItems.length} results (~$1.50-2.70 per 1k), billed ${new Date().toLocaleDateString("en-CA")}`,
    });
  }

  fetchHashtag(hashtagName, limit) {
    const hashtagUrl = `https://www.instagram.com/explore/tags/${hashtagName.replace(/^#+/, "")}/`;
    return this.runActor({ directUrls: [hashtagUrl], resultsType: "posts", resultsLimit: limit }, "hashtag", hashtagName);
  }

  fetchSearch(query, limit) {
    return this.runActor({ search: query, searchType: "hashtag", searchLimit: 1, resultsType: "posts", resultsLimit: limit }, "search", query);
  }

  fetchProfilePosts(username, limit) {
    const profileUrl = `https://www.instagram.com/${username.replace(/^@+/, "")}/`;
    return this.runActor({ directUrls: [profileUrl], resultsType: "posts", resultsLimit: limit }, "profile_posts", username);
  }

  fetchPost(shortcode) {
    const postUrl = `https://www.instagram.com/p/${shortcode}/`;
    return this.runActor({ directUrls: [postUrl], resultsType: "posts", resultsLimit: 1 }, "post", shortcode);
  }
}
