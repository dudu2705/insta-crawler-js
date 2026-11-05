import assert from "node:assert/strict";
import { test } from "node:test";

import { CapabilityNotSupportedError } from "../src/providers/index.js";
import { ApifyProvider } from "../src/providers/apify.js";
import { HikerApiProvider, splitChunkResponse } from "../src/providers/hikerapi.js";
import { SocialCrawlProvider } from "../src/providers/socialcrawl.js";

const APIFY_DATASET = [
  {
    shortCode: "DZxvMgyH8yR",
    url: "https://www.instagram.com/p/DZxvMgyH8yR/",
    type: "Image",
    caption: "Lava lake #volcano",
    hashtags: ["volcano"],
    likesCount: 55952,
    commentsCount: 110,
    timestamp: "2026-06-20T10:00:04.000Z",
    ownerUsername: "natgeo",
  },
  { shortCode: "HIDDEN", type: "Video", likesCount: -1, videoPlayCount: 500 },
  { error: "no_items" },
];

const SOCIALCRAWL_ENVELOPE_PAGE_ONE = {
  success: true,
  credits_used: 1,
  data: {
    items: [
      {
        post: { id: "1", url: "https://www.instagram.com/reel/REEL111/", content: { text: "Phở sáng #hanoi" } },
        author: { handle: "foodie" },
        engagement: { likes: 900, comments: 30, views: 45000 },
        published_at: "2026-10-30T01:00:00Z",
      },
    ],
  },
  pagination: { has_more: true, next_cursor: "CURSOR2" },
};

const SOCIALCRAWL_ENVELOPE_PAGE_TWO = {
  success: true,
  credits_used: 1,
  data: { items: [{ post: { shortcode: "REEL222" }, engagement: { likes: 10 } }] },
  pagination: { has_more: false },
};

const HIKERAPI_CHUNK = [
  [
    { code: "HK1", media_type: 2, like_count: 100, comment_count: 4, play_count: 9000, taken_at: 1761900000, user: { username: "a" }, caption: { text: "#vietnam" } },
    { code: "HK2", media_type: 1, like_count: 50, comment_count: 1, taken_at: 1761800000, user: { username: "b" } },
  ],
  "WyIzMzBmIl0=",
];

function buildFakeProvider(ProviderClass, responses) {
  const provider = new ProviderClass("test-key");
  const recordedCalls = [];
  provider.sendRequest = async (method, url, requestOptions) => {
    recordedCalls.push([method, url, requestOptions]);
    return structuredClone(responses.shift());
  };
  return { provider, recordedCalls };
}

test("apify hashtag normalizes and builds input", async () => {
  const { provider, recordedCalls } = buildFakeProvider(ApifyProvider, [APIFY_DATASET]);
  const providerResult = await provider.run("hashtag", "#volcano", 5);
  const [, url, requestOptions] = recordedCalls[0];
  assert.ok(url.endsWith("/acts/apify~instagram-scraper/run-sync-get-dataset-items"));
  assert.deepEqual(requestOptions.json, { directUrls: ["https://www.instagram.com/explore/tags/volcano/"], resultsType: "posts", resultsLimit: 5 });
  assert.equal(requestOptions.headers.Authorization, "Bearer test-key");
  assert.deepEqual(providerResult.items.map((item) => item.shortcode), ["DZxvMgyH8yR", "HIDDEN"]);
  assert.equal(providerResult.items[0].like_count, 55952);
  assert.equal(providerResult.items[1].like_count, null);
  assert.equal(providerResult.items[1].view_count, 500);
});

test("apify has no trending", async () => {
  const { provider } = buildFakeProvider(ApifyProvider, []);
  await assert.rejects(provider.run("trending", null, 10), CapabilityNotSupportedError);
});

test("provider without api key fails with a hint", () => {
  delete process.env.APIFY_TOKEN;
  assert.throws(() => new ApifyProvider(), /set APIFY_TOKEN in \.env/);
});

test("socialcrawl paginates and normalizes", async () => {
  const { provider, recordedCalls } = buildFakeProvider(SocialCrawlProvider, [SOCIALCRAWL_ENVELOPE_PAGE_ONE, SOCIALCRAWL_ENVELOPE_PAGE_TWO]);
  const providerResult = await provider.run("search", "phở", 40);
  assert.deepEqual(recordedCalls[0][2].headers, { "x-api-key": "test-key" });
  assert.equal(recordedCalls[1][2].params.cursor, "CURSOR2");
  const firstItem = providerResult.items[0];
  assert.deepEqual([firstItem.shortcode, firstItem.owner_username, firstItem.view_count], ["REEL111", "foodie", 45000]);
  assert.deepEqual(firstItem.hashtags, ["hanoi"]);
  assert.equal(providerResult.items[1].shortcode, "REEL222");
  assert.ok(providerResult.costNote.startsWith("2 credits"));
});

test("socialcrawl trending deduplicates", async () => {
  const { provider, recordedCalls } = buildFakeProvider(SocialCrawlProvider, [SOCIALCRAWL_ENVELOPE_PAGE_TWO, SOCIALCRAWL_ENVELOPE_PAGE_TWO]);
  const providerResult = await provider.run("trending", null, 20);
  assert.equal(recordedCalls.length, 2);
  assert.deepEqual(providerResult.items.map((item) => item.shortcode), ["REEL222"]);
});

test("hikerapi chunk pagination", async () => {
  const { provider, recordedCalls } = buildFakeProvider(HikerApiProvider, [HIKERAPI_CHUNK, [[], null]]);
  const providerResult = await provider.run("hashtag", "vietnam", 10);
  assert.equal(recordedCalls[0][1], "https://api.hikerapi.com/v1/hashtag/medias/top/chunk");
  assert.equal(recordedCalls[0][2].headers["x-access-key"], "test-key");
  assert.equal(recordedCalls[1][2].params.max_id, "WyIzMzBmIl0=");
  assert.deepEqual(providerResult.items.map((item) => item.shortcode), ["HK1", "HK2"]);
  assert.equal(providerResult.items[0].view_count, 9000);
});

test("hikerapi profile resolves user id", async () => {
  const { provider, recordedCalls } = buildFakeProvider(HikerApiProvider, [{ pk: "787132", username: "natgeo" }, [HIKERAPI_CHUNK[0], null]]);
  const providerResult = await provider.run("profile_posts", "natgeo", 5);
  assert.ok(recordedCalls[1][1].endsWith("/v1/user/clips/chunk"));
  assert.equal(recordedCalls[1][2].params.user_id, "787132");
  assert.equal(providerResult.items.length, 2);
});

test("splitChunkResponse variants", () => {
  assert.deepEqual(splitChunkResponse([[1, 2], "next"]), [[1, 2], "next"]);
  assert.deepEqual(splitChunkResponse([{ code: "x" }]), [[{ code: "x" }], null]);
  assert.deepEqual(splitChunkResponse({ items: [1], next_page_id: "n" }), [[1], "n"]);
});

test("sendRequest builds query string, JSON body and raises on HTTP errors", async (testContext) => {
  const sentRequests = [];
  testContext.mock.method(globalThis, "fetch", async (requestUrl, requestInit) => {
    sentRequests.push([String(requestUrl), requestInit]);
    if (sentRequests.length === 2) {
      return new Response("quota exceeded", { status: 429 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  const provider = new HikerApiProvider("test-key");
  assert.deepEqual(await provider.sendRequest("POST", "https://example.test/a", { params: { name: "phở", skip: null }, json: { x: 1 } }), { ok: true });
  assert.equal(sentRequests[0][0], "https://example.test/a?name=ph%E1%BB%9F");
  assert.equal(sentRequests[0][1].body, '{"x":1}');
  await assert.rejects(provider.sendRequest("GET", "https://example.test/b"), /hikerapi HTTP 429: quota exceeded/);
});
