import { isPlainObject, unwrapLoggedOutGate, walkJson } from "./json-tools.js";
import { createMedia, isEmptyValue } from "./models.js";

export const HASHTAG_PATTERN = /#([\p{L}\p{N}_]+)/gu;

const MEDIA_TYPE_NAMES = { 1: "image", 2: "video", 8: "carousel" };
const TYPENAME_TO_MEDIA_TYPE = {
  GraphImage: "image",
  GraphVideo: "video",
  GraphSidecar: "carousel",
  XDTGraphImage: "image",
  XDTGraphVideo: "video",
  XDTGraphSidecar: "carousel",
};
const ENGAGEMENT_KEYS = ["like_count", "edge_media_preview_like", "edge_liked_by", "comment_count", "edge_media_to_comment", "play_count", "video_view_count"];

export function extractHashtags(text) {
  const hashtags = [];
  for (const hashtagMatch of (text || "").matchAll(HASHTAG_PATTERN)) {
    hashtags.push(hashtagMatch[1]);
  }
  return hashtags;
}

export function firstPresent(source, ...keyPaths) {
  for (const keyPath of keyPaths) {
    let currentValue = source;
    for (const keyPart of keyPath.split(".")) {
      if (!isPlainObject(currentValue) || !Object.hasOwn(currentValue, keyPart)) {
        currentValue = null;
        break;
      }
      currentValue = currentValue[keyPart];
    }
    if (currentValue !== null && currentValue !== undefined) {
      return currentValue;
    }
  }
  return null;
}

export function timestampToIso(rawTimestamp) {
  if (rawTimestamp === null || rawTimestamp === undefined) {
    return null;
  }
  return new Date(Math.trunc(Number(rawTimestamp)) * 1000).toISOString().replace(".000Z", "+00:00");
}

export function extractCaptionText(mediaNode) {
  const captionValue = mediaNode.caption;
  if (isPlainObject(captionValue)) {
    return captionValue.text ?? null;
  }
  if (typeof captionValue === "string") {
    return captionValue;
  }
  const captionEdges = firstPresent(mediaNode, "edge_media_to_caption.edges") || [];
  if (captionEdges.length) {
    return firstPresent(captionEdges[0], "node.text");
  }
  return null;
}

export function looksLikeMediaNode(candidate) {
  const hasIdentifier = Boolean(candidate.shortcode || candidate.code);
  // Logged-out grids (Nov 2026) send XIGPolarisMedia nodes with caption/owner but no engagement fields.
  if (hasIdentifier && candidate.__isXIGPolarisMedia) {
    return true;
  }
  let hasEngagement = false;
  for (const engagementKey of ENGAGEMENT_KEYS) {
    if (engagementKey in candidate) {
      hasEngagement = true;
      break;
    }
  }
  return hasIdentifier && hasEngagement;
}

export function normalizeMediaNode(mediaNode, sourceStrategy) {
  const shortcode = mediaNode.shortcode || mediaNode.code;
  const captionText = extractCaptionText(mediaNode);
  return createMedia({
    shortcode,
    url: `https://www.instagram.com/p/${shortcode}/`,
    media_type: TYPENAME_TO_MEDIA_TYPE[mediaNode.__typename] || MEDIA_TYPE_NAMES[mediaNode.media_type],
    caption: captionText,
    owner_username: firstPresent(mediaNode, "owner.username", "user.username"),
    like_count: firstPresent(mediaNode, "like_count", "edge_media_preview_like.count", "edge_liked_by.count"),
    comment_count: firstPresent(mediaNode, "comment_count", "edge_media_to_comment.count", "edge_media_to_parent_comment.count"),
    view_count: firstPresent(mediaNode, "play_count", "ig_play_count", "video_play_count", "view_count", "video_view_count"),
    taken_at: timestampToIso(firstPresent(mediaNode, "taken_at", "taken_at_timestamp")),
    hashtags: extractHashtags(captionText),
    source_strategy: sourceStrategy,
  });
}

export function countFilledFields(media) {
  let filledCount = 0;
  for (const fieldValue of Object.values(media)) {
    if (!isEmptyValue(fieldValue)) {
      filledCount += 1;
    }
  }
  return filledCount;
}

export function findMediaNodes(payload, sourceStrategy) {
  const collectedMedia = new Map();
  const carouselSlideShortcodes = new Set();
  for (const jsonObject of walkJson(unwrapLoggedOutGate(payload))) {
    if (!looksLikeMediaNode(jsonObject)) {
      continue;
    }
    for (const carouselSlide of Array.isArray(jsonObject.carousel_media) ? jsonObject.carousel_media : []) {
      if (isPlainObject(carouselSlide) && carouselSlide.code) {
        carouselSlideShortcodes.add(carouselSlide.code);
      }
    }
    if (carouselSlideShortcodes.has(jsonObject.shortcode || jsonObject.code)) {
      continue;
    }
    const normalizedMedia = normalizeMediaNode(jsonObject, sourceStrategy);
    const existingMedia = collectedMedia.get(normalizedMedia.shortcode);
    if (existingMedia === undefined || countFilledFields(normalizedMedia) > countFilledFields(existingMedia)) {
      collectedMedia.set(normalizedMedia.shortcode, normalizedMedia);
    }
  }
  return [...collectedMedia.values()];
}
