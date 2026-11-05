import { isPlainObject } from "../json-tools.js";
import { createMedia } from "../models.js";
import { extractHashtags, firstPresent } from "../parsers.js";
import { InstagramDataProvider, ProviderResult } from "./base.js";

const SOCIALCRAWL_BASE_URL = "https://www.socialcrawl.dev/v1/instagram";
const SHORTCODE_IN_URL_PATTERN = /\/(?:p|reel|reels)\/([\w-]+)/;

function extractShortcode(row) {
  const directShortcode = firstPresent(row, "post.shortcode", "post.code", "shortcode", "code", "post.ext.shortcode");
  if (directShortcode) {
    return directShortcode;
  }
  const rowUrl = firstPresent(row, "post.url", "url", "post.permalink", "permalink");
  const urlMatch = SHORTCODE_IN_URL_PATTERN.exec(rowUrl || "");
  return urlMatch ? urlMatch[1] : null;
}

export function socialcrawlRowToModel(row) {
  const shortcode = extractShortcode(row);
  if (!shortcode) {
    return null;
  }
  const captionText = firstPresent(row, "post.content.text", "post.text", "post.caption", "content.text", "text", "caption");
  const hashtagList = firstPresent(row, "post.content.hashtags", "post.hashtags", "hashtags");
  return createMedia({
    shortcode,
    url: firstPresent(row, "post.url", "url") || `https://www.instagram.com/p/${shortcode}/`,
    media_type: firstPresent(row, "post.content.type", "post.type", "post.media_type", "type"),
    caption: captionText,
    owner_username: firstPresent(row, "author.handle", "author.username", "post.author.handle", "post.ext.author_handle"),
    like_count: firstPresent(row, "engagement.likes", "post.engagement.likes", "likes"),
    comment_count: firstPresent(row, "engagement.comments", "post.engagement.comments", "comments"),
    view_count: firstPresent(row, "engagement.views", "post.engagement.views", "views"),
    taken_at: firstPresent(row, "published_at", "post.published_at"),
    hashtags: Array.isArray(hashtagList) ? hashtagList : extractHashtags(captionText),
    source_strategy: "provider_socialcrawl",
  });
}

function extractRows(envelope) {
  const responseData = envelope.data;
  if (isPlainObject(responseData)) {
    if (Array.isArray(responseData.items)) {
      return responseData.items;
    }
    if (isPlainObject(responseData.post)) {
      return [responseData];
    }
  }
  if (Array.isArray(responseData)) {
    return responseData;
  }
  return [];
}

export class SocialCrawlProvider extends InstagramDataProvider {
  static providerName = "socialcrawl";
  static apiKeyEnvironmentVariable = "SOCIALCRAWL_API_KEY";
  static supportedCapabilities = ["trending", "hashtag", "hashtag_recent", "search", "profile_posts", "post"];

  async callEndpoint(endpointPath, queryParameters, capability, target, pageLimit = 1) {
    const providerResult = new ProviderResult({ providerName: this.providerName, capability, target });
    let totalCreditsUsed = 0;
    const currentParameters = { ...queryParameters };
    for (let pageIndex = 0; pageIndex < pageLimit; pageIndex += 1) {
      const envelope = await this.sendRequest("GET", `${SOCIALCRAWL_BASE_URL}${endpointPath}`, { params: { ...currentParameters }, headers: { "x-api-key": this.apiKey } });
      providerResult.rawResponses.push(envelope);
      totalCreditsUsed += envelope.credits_used || 0;
      for (const row of extractRows(envelope)) {
        const media = socialcrawlRowToModel(row);
        if (media) {
          providerResult.items.push(media);
        }
      }
      const pagination = envelope.pagination || {};
      providerResult.nextCursor = pagination.next_cursor ?? null;
      if (!pagination.has_more || !providerResult.nextCursor) {
        break;
      }
      currentParameters.cursor = providerResult.nextCursor;
    }
    providerResult.costNote = `${totalCreditsUsed} credits used (~£0.006 each on the starter pack)`;
    return providerResult;
  }

  async fetchTrending(target, limit) {
    const providerResult = new ProviderResult({ providerName: this.providerName, capability: "trending", target: null });
    const seenShortcodes = new Set();
    const maximumCalls = Math.max(1, Math.min(5, Math.floor(limit / 10) || 1));
    for (let callIndex = 0; callIndex < maximumCalls; callIndex += 1) {
      const pageResult = await this.callEndpoint("/reels/trending", {}, "trending", null);
      providerResult.rawResponses.push(...pageResult.rawResponses);
      for (const media of pageResult.items) {
        if (!seenShortcodes.has(media.shortcode)) {
          seenShortcodes.add(media.shortcode);
          providerResult.items.push(media);
        }
      }
    }
    providerResult.costNote = `${maximumCalls} calls x 5 credits (trending is a repeating global sample, deduplicated)`;
    return providerResult;
  }

  async fetchHashtagRanked(hashtagName, limit, ranking, capability) {
    const providerResult = await this.callEndpoint(
      "/search/hashtag",
      { hashtag: hashtagName.replace(/^#+/, ""), type: ranking, max_items: limit },
      capability,
      hashtagName,
    );
    providerResult.items = providerResult.items.slice(0, limit);
    return providerResult;
  }

  fetchHashtag(hashtagName, limit) {
    return this.fetchHashtagRanked(hashtagName, limit, "top", "hashtag");
  }

  fetchHashtagRecent(hashtagName, limit) {
    return this.fetchHashtagRanked(hashtagName, limit, "recent", "hashtag_recent");
  }

  fetchSearch(query, limit) {
    return this.callEndpoint("/search/reels", { query }, "search", query, Math.max(1, Math.floor(limit / 20)));
  }

  fetchProfilePosts(username, limit) {
    return this.callEndpoint("/profile/posts", { handle: username.replace(/^@+/, "") }, "profile_posts", username, Math.max(1, Math.floor(limit / 12)));
  }

  fetchPost(shortcode) {
    return this.callEndpoint("/post", { url: `https://www.instagram.com/p/${shortcode}/` }, "post", shortcode);
  }
}
