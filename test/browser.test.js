import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { buildProxyOption, mergeMedia, probeMetricFields } from "../src/browser-capture.js";
import { createMedia } from "../src/models.js";
import { SessionPool, buildTargetUrl } from "../src/session-pool.js";

test("target urls", () => {
  assert.equal(buildTargetUrl("hashtag", "#phởhànội"), "https://www.instagram.com/popular/ph%E1%BB%9Fh%C3%A0n%E1%BB%99i/");
  assert.equal(buildTargetUrl("explore", null), "https://www.instagram.com/explore/");
  assert.equal(buildTargetUrl("search", "ăn vặt"), "https://www.instagram.com/explore/search/keyword/?q=%C4%83n%20v%E1%BA%B7t");
  assert.throws(() => buildTargetUrl("hashtag", null));
});

test("proxy credentials are split out of the URL", () => {
  assert.deepEqual(buildProxyOption("http://user:p%40ss@1.2.3.4:8080"), { server: "http://1.2.3.4:8080", username: "user", password: "p@ss" });
  assert.deepEqual(buildProxyOption("socks5://host:1080"), { server: "socks5://host:1080" });
});

test("session pool rotation and cooldown", () => {
  const sessionsDirectory = mkdtempSync(path.join(tmpdir(), "insta-sessions-"));
  for (const sessionName of ["burner_a", "burner_b"]) {
    writeFileSync(path.join(sessionsDirectory, `${sessionName}.json`), "{}");
  }
  const sessionPool = new SessionPool(sessionsDirectory);
  const firstSession = sessionPool.pickSession();
  sessionPool.recordUse(firstSession.session_name, false);
  const secondSession = sessionPool.pickSession();
  assert.notEqual(secondSession.session_name, firstSession.session_name);
  sessionPool.recordUse(secondSession.session_name, true);
  assert.equal(sessionPool.pickSession().session_name, firstSession.session_name);
  sessionPool.recordUse(firstSession.session_name, true);
  assert.equal(sessionPool.pickSession(), null);
  assert.equal(sessionPool.minutesUntilNextAvailable(), 24 * 60);
  const reloadedPool = new SessionPool(sessionsDirectory);
  const challengedState = reloadedPool.sessionStates.get(secondSession.session_name);
  assert.ok(challengedState.challenges === 1 && challengedState.disabled_until > 0);
  assert.notEqual(reloadedPool.pickSession(true), null);
});

test("session pool reads the Python pool_state.json format", () => {
  const sessionsDirectory = mkdtempSync(path.join(tmpdir(), "insta-sessions-"));
  writeFileSync(path.join(sessionsDirectory, "burner_a.json"), "{}");
  writeFileSync(path.join(sessionsDirectory, "pool_state.json"), JSON.stringify({
    burner_a: { session_name: "burner_a", proxy_url: null, last_used_at: 1, uses: 8, challenges: 1, disabled_until: 2, notes: ["hashtag:44 items"] },
  }));
  const summaryRows = new SessionPool(sessionsDirectory).summary();
  assert.deepEqual(summaryRows, [{ session: "burner_a", proxy: false, uses: 8, challenges: 1, available: true, cooldown_left_minutes: 0 }]);
});

test("browser merge and metric probe", () => {
  const gridCopy = createMedia({ shortcode: "R1", url: "u", like_count: 862, comment_count: 65 });
  const detailCopy = createMedia({ shortcode: "R1", url: "u", view_count: 40000, media_type: "video" });
  const mergedMedia = mergeMedia(gridCopy, detailCopy);
  assert.deepEqual([mergedMedia.like_count, mergedMedia.comment_count, mergedMedia.view_count, mergedMedia.media_type], [862, 65, 40000, "video"]);
  const capturedPayloads = [{ data: { items: [
    { code: "R1", like_count: 862, comment_count: 65, fb_play_count: null, clips_metadata: { view_count_new: 40000 } },
    { code: "R2", like_count: 10, comment_count: 1, fb_play_count: 5 },
  ] } }];
  const fieldStatistics = probeMetricFields(capturedPayloads);
  assert.deepEqual(fieldStatistics["clips_metadata.view_count_new"], { media_nodes: 1, non_null: 1, example: 40000 });
  assert.ok(fieldStatistics.fb_play_count.non_null === 1 && fieldStatistics.fb_play_count.media_nodes === 2);
});
