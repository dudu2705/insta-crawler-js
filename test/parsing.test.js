import assert from "node:assert/strict";
import { test } from "node:test";

import { extractEmbeddedJsonBlobs } from "../src/json-tools.js";
import { findMediaNodes } from "../src/parsers.js";

const NEW_FORMAT_POST = {
  data: {
    xdt_api__v1__media__shortcode__web_info: {
      items: [
        {
          code: "DdeRysim9zK",
          media_type: 2,
          like_count: 1520,
          comment_count: 41,
          play_count: 98000,
          taken_at: 1761900000,
          user: { username: "someone" },
          caption: { text: "Hà Nội mùa thu #hanoi #autumn" },
        },
      ],
    },
  },
};

const LEGACY_GATED_POST = {
  if_not_gated_logged_out: {
    xdt_shortcode_media: {
      __typename: "XDTGraphVideo",
      shortcode: "ABC123",
      edge_media_preview_like: { count: 77 },
      edge_media_to_parent_comment: { count: 5 },
      video_view_count: 3000,
      taken_at_timestamp: 1761800000,
      owner: { username: "legacy_user" },
      edge_media_to_caption: { edges: [{ node: { text: "old shape #retro" } }] },
    },
  },
};

test("new format post is normalized", () => {
  const mediaItems = findMediaNodes(NEW_FORMAT_POST, "test");
  assert.equal(mediaItems.length, 1);
  const media = mediaItems[0];
  assert.equal(media.shortcode, "DdeRysim9zK");
  assert.equal(media.media_type, "video");
  assert.deepEqual([media.like_count, media.comment_count, media.view_count], [1520, 41, 98000]);
  assert.equal(media.owner_username, "someone");
  assert.deepEqual(media.hashtags, ["hanoi", "autumn"]);
  assert.ok(media.taken_at.startsWith("2025-10-31"));
});

test("logged-out gate and legacy fields", () => {
  const media = findMediaNodes(LEGACY_GATED_POST, "test")[0];
  assert.equal(media.shortcode, "ABC123");
  assert.equal(media.media_type, "video");
  assert.deepEqual([media.like_count, media.comment_count, media.view_count], [77, 5, 3000]);
  assert.equal(media.caption, "old shape #retro");
});

test("embedded JSON blobs from HTML", () => {
  const pageHtml = `<html><script type="application/json" data-sjs>${JSON.stringify(NEW_FORMAT_POST)}</script><script type="application/json">broken</script></html>`;
  const blobs = extractEmbeddedJsonBlobs(pageHtml);
  assert.equal(blobs.length, 1);
  assert.equal(findMediaNodes(blobs[0], "test")[0].shortcode, "DdeRysim9zK");
});

test("logged-out grid nodes without engagement are kept", () => {
  const gridPayload = { data: { items: [
    { __typename: "XIGPolarisVideoMedia", __isXIGPolarisMedia: "XIGPolarisVideoMedia", pk: "1", code: "DfQCqMnhpsG", caption: { text: "bedroom music #music" }, media_type: 2, user: { username: "instagram" } },
    { code: "NOT_MEDIA" },
  ] } };
  const mediaItems = findMediaNodes(gridPayload, "test");
  assert.deepEqual(mediaItems.map((media) => media.shortcode), ["DfQCqMnhpsG"]);
  assert.deepEqual([mediaItems[0].owner_username, mediaItems[0].media_type, mediaItems[0].like_count], ["instagram", "video", null]);
  assert.deepEqual(mediaItems[0].hashtags, ["music"]);
});

test("carousel slides are not returned as separate posts", () => {
  const postPayload = { items: [{
    __isXIGPolarisMedia: "XIGPolarisCarouselMedia",
    code: "CAROUSEL1",
    like_count: 636414,
    carousel_media: [
      { __isXIGPolarisMedia: "XIGPolarisImageMedia", code: "SLIDE1", like_count: null },
      { __isXIGPolarisMedia: "XIGPolarisVideoMedia", code: "SLIDE2" },
    ],
  }] };
  assert.deepEqual(findMediaNodes(postPayload, "test").map((media) => media.shortcode), ["CAROUSEL1"]);
});

test("unicode hashtags are kept whole", () => {
  const media = findMediaNodes({ code: "V1", like_count: 1, caption: "#phởhànội #ăn_vặt" }, "test")[0];
  assert.deepEqual(media.hashtags, ["phởhànội", "ăn_vặt"]);
});
