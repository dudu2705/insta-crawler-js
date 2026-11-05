import { setTimeout as sleep } from "node:timers/promises";

import { utcNowIso } from "./models.js";

export const RANKINGS = ["top", "recent"];

export class RankingNotSupportedError extends Error {
  name = "RankingNotSupportedError";
}

function roundTwo(value) {
  return Math.round(value * 100) / 100;
}

function parseIsoTimestamp(timestampText) {
  if (!timestampText) {
    return null;
  }
  const hasTimezone = /(Z|[+-]\d{2}:?\d{2})$/i.test(timestampText);
  const parsedMilliseconds = Date.parse(hasTimezone ? timestampText : `${timestampText}Z`);
  return Number.isNaN(parsedMilliseconds) ? null : parsedMilliseconds;
}

function createBatchItem(media) {
  return { media, hashtag_sources: [], ranking_sources: [], age_hours: null, engagement: 0, engagement_per_hour: 0, views_per_hour: null };
}

function batchItemToDict(batchItem) {
  return {
    ...batchItem.media,
    hashtag_sources: batchItem.hashtag_sources,
    ranking_sources: batchItem.ranking_sources,
    age_hours: batchItem.age_hours,
    engagement: batchItem.engagement,
    engagement_per_hour: batchItem.engagement_per_hour,
    views_per_hour: batchItem.views_per_hour,
  };
}

function scoreItem(batchItem, referenceMilliseconds) {
  const media = batchItem.media;
  batchItem.engagement = (media.like_count || 0) + (media.comment_count || 0);
  const publishedMilliseconds = parseIsoTimestamp(media.taken_at);
  if (publishedMilliseconds === null) {
    return;
  }
  batchItem.age_hours = roundTwo(Math.max((referenceMilliseconds - publishedMilliseconds) / 3_600_000, 0));
  const effectiveAgeHours = Math.max(batchItem.age_hours, 1);
  batchItem.engagement_per_hour = roundTwo(batchItem.engagement / effectiveAgeHours);
  if (media.view_count !== null && media.view_count !== undefined) {
    batchItem.views_per_hour = roundTwo(media.view_count / effectiveAgeHours);
  }
}

function buildSummary(batchItems, hashtags) {
  const perHashtagCounts = {};
  for (const hashtag of hashtags) {
    perHashtagCounts[hashtag] = 0;
  }
  const summary = { total_posts: batchItems.length, posts_per_hashtag: perHashtagCounts, total_likes: 0, total_comments: 0, total_views: 0, posts_with_views: 0, posts_with_timestamp: 0, top_posts: [] };
  for (const batchItem of batchItems) {
    for (const hashtag of hashtags) {
      if (batchItem.hashtag_sources.includes(hashtag)) {
        perHashtagCounts[hashtag] += 1;
      }
    }
    summary.total_likes += batchItem.media.like_count || 0;
    summary.total_comments += batchItem.media.comment_count || 0;
    summary.total_views += batchItem.media.view_count || 0;
    if (batchItem.media.view_count !== null && batchItem.media.view_count !== undefined) {
      summary.posts_with_views += 1;
    }
    if (batchItem.age_hours !== null) {
      summary.posts_with_timestamp += 1;
    }
  }
  for (const batchItem of batchItems.slice(0, 10)) {
    summary.top_posts.push({ url: batchItem.media.url, owner: batchItem.media.owner_username, engagement_per_hour: batchItem.engagement_per_hour, hashtags: batchItem.hashtag_sources });
  }
  return summary;
}

export async function runHashtagBatch(methodName, hashtagFetcher, hashtags, { rankings = RANKINGS, limitPerQuery = 30, pauseSeconds = 2, log = console.log } = {}) {
  const collectedItems = new Map();
  const queryLog = [];
  const startedAt = Date.now();
  for (const hashtag of hashtags) {
    for (const ranking of rankings) {
      const queryStartedAt = Date.now();
      let mediaItems;
      try {
        mediaItems = await hashtagFetcher(hashtag, ranking, limitPerQuery);
      } catch (fetchError) {
        if (fetchError instanceof RankingNotSupportedError) {
          queryLog.push({ hashtag, ranking, status: "skipped", detail: fetchError.message });
          log(`  #${hashtag.padEnd(16)} ${ranking.padEnd(7)} skipped  (${fetchError.message})`);
        } else {
          queryLog.push({ hashtag, ranking, status: "error", detail: `${fetchError.name}: ${fetchError.message}`.slice(0, 300) });
          log(`  #${hashtag.padEnd(16)} ${ranking.padEnd(7)} ERROR    ${fetchError.name}: ${String(fetchError.message).slice(0, 120)}`);
        }
        continue;
      }
      let newCount = 0;
      for (const media of mediaItems) {
        let batchItem = collectedItems.get(media.shortcode);
        if (batchItem === undefined) {
          batchItem = createBatchItem(media);
          collectedItems.set(media.shortcode, batchItem);
          newCount += 1;
        }
        if (!batchItem.hashtag_sources.includes(hashtag)) {
          batchItem.hashtag_sources.push(hashtag);
        }
        if (!batchItem.ranking_sources.includes(ranking)) {
          batchItem.ranking_sources.push(ranking);
        }
      }
      queryLog.push({ hashtag, ranking, status: "ok", results: mediaItems.length, new: newCount, seconds: roundTwo((Date.now() - queryStartedAt) / 1000) });
      log(`  #${hashtag.padEnd(16)} ${ranking.padEnd(7)} ${String(mediaItems.length).padStart(4)} results (${newCount} new)`);
      if (pauseSeconds) {
        await sleep(pauseSeconds * 1000);
      }
    }
  }
  const referenceMilliseconds = Date.now();
  for (const batchItem of collectedItems.values()) {
    scoreItem(batchItem, referenceMilliseconds);
  }
  const sortedItems = [...collectedItems.values()].sort((left, right) => right.engagement_per_hour - left.engagement_per_hour || right.engagement - left.engagement);
  let hasFailedQuery = false;
  for (const queryEntry of queryLog) {
    if (queryEntry.status === "error") {
      hasFailedQuery = true;
    }
  }
  const postDicts = [];
  for (const batchItem of sortedItems) {
    postDicts.push(batchItemToDict(batchItem));
  }
  return {
    metadata: {
      method: methodName,
      hashtags,
      rankings: [...rankings],
      limit_per_query: limitPerQuery,
      fetched_at: utcNowIso(),
      duration_seconds: Math.round((Date.now() - startedAt) / 100) / 10,
      partial: hasFailedQuery,
    },
    queries: queryLog,
    summary: buildSummary(sortedItems, hashtags),
    posts: postDicts,
  };
}

export function providerHashtagFetcher(provider) {
  return async (hashtag, ranking, limit) => {
    const capability = ranking === "top" ? "hashtag" : `hashtag_${ranking}`;
    if (!provider.supportedCapabilities.includes(capability)) {
      throw new RankingNotSupportedError(`${provider.providerName} has no ${ranking} hashtag feed`);
    }
    return (await provider.run(capability, hashtag, limit)).items;
  };
}
