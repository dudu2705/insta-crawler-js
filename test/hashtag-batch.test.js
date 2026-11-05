import assert from "node:assert/strict";
import { test } from "node:test";

import { RankingNotSupportedError, providerHashtagFetcher, runHashtagBatch } from "../src/hashtag-batch.js";
import { createMedia } from "../src/models.js";
import { HikerApiProvider } from "../src/providers/hikerapi.js";
import { SocialCrawlProvider } from "../src/providers/socialcrawl.js";

function hoursAgo(hourCount) {
  return new Date(Date.now() - hourCount * 3_600_000).toISOString();
}

function makeMedia(shortcode, likeCount, ageHours, viewCount = null) {
  return createMedia({ shortcode, url: `https://www.instagram.com/p/${shortcode}/`, like_count: likeCount, comment_count: 0, view_count: viewCount, taken_at: hoursAgo(ageHours) });
}

test("batch dedupes, ranks and records skips and errors", async () => {
  const fakeFeeds = {
    "balayage|top": [makeMedia("OLD_BIG", 10_000, 200), makeMedia("SHARED", 500, 5)],
    "balayage|recent": [makeMedia("FRESH", 300, 1, 6000)],
    "haircolor|top": [makeMedia("SHARED", 500, 5)],
  };
  const fakeFetcher = async (hashtag, ranking) => {
    if (hashtag === "hairtok") {
      throw new Error("HTTP 500");
    }
    if (hashtag === "haircolor" && ranking === "recent") {
      throw new RankingNotSupportedError("no recent feed");
    }
    return fakeFeeds[`${hashtag}|${ranking}`] ?? [];
  };
  const collection = await runHashtagBatch("fake", fakeFetcher, ["balayage", "haircolor", "hairtok"], { rankings: ["top", "recent"], limitPerQuery: 30, pauseSeconds: 0, log: () => {} });
  assert.deepEqual(collection.posts.map((post) => post.shortcode), ["FRESH", "SHARED", "OLD_BIG"]);
  assert.deepEqual(collection.posts[1].hashtag_sources, ["balayage", "haircolor"]);
  assert.equal(collection.posts[0].views_per_hour, 6000);
  const statuses = {};
  for (const entry of collection.queries) {
    statuses[`${entry.hashtag}|${entry.ranking}`] = entry.status;
  }
  assert.equal(statuses["haircolor|recent"], "skipped");
  assert.equal(statuses["hairtok|top"], "error");
  assert.equal(collection.metadata.partial, true);
  assert.deepEqual(collection.summary.posts_per_hashtag, { balayage: 3, haircolor: 1, hairtok: 0 });
});

test("socialcrawl recent sends type=recent", async () => {
  const provider = new SocialCrawlProvider("test-key");
  const sentParameters = [];
  provider.sendRequest = async (method, url, requestOptions) => {
    sentParameters.push([url, requestOptions.params]);
    return { data: { items: [{ post: { shortcode: "R1" }, engagement: { likes: 3 }, published_at: hoursAgo(2) }] }, pagination: { has_more: false }, credits_used: 1 };
  };
  const fetcher = providerHashtagFetcher(provider);
  assert.deepEqual((await fetcher("balayage", "recent", 25)).map((media) => media.shortcode), ["R1"]);
  assert.ok(sentParameters[0][0].endsWith("/v1/instagram/search/hashtag"));
  assert.deepEqual(sentParameters[0][1], { hashtag: "balayage", type: "recent", max_items: 25 });
  await fetcher("balayage", "top", 25);
  assert.equal(sentParameters[1][1].type, "top");
});

test("provider without a recent feed is skipped", async () => {
  const fetcher = providerHashtagFetcher(new HikerApiProvider("test-key"));
  await assert.rejects(fetcher("balayage", "recent", 10), RankingNotSupportedError);
});
