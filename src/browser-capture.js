import { mkdirSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";

import { extractEmbeddedJsonBlobs, isPlainObject, walkJson } from "./json-tools.js";
import { isEmptyValue } from "./models.js";
import { findMediaNodes, looksLikeMediaNode } from "./parsers.js";

const CAPTURED_URL_FRAGMENTS = ["/graphql/query", "/api/graphql", "/api/v1/"];
const BLOCKED_RESOURCE_TYPES = new Set(["image", "media", "font"]);
const CHALLENGE_URL_FRAGMENTS = ["/challenge/", "/accounts/suspended", "/accounts/disabled", "/checkpoint/"];
const METRIC_FIELD_PATTERN = /count|play|view/i;

async function loadPlaywright() {
  try {
    const { chromium } = await import("patchright");
    return { chromium, engineName: "patchright" };
  } catch {
    const { chromium } = await import("playwright");
    return { chromium, engineName: "playwright" };
  }
}

async function launchChromium(chromium, launchOptions) {
  try {
    return await chromium.launch(launchOptions);
  } catch (launchError) {
    if (!String(launchError).includes("Executable doesn't exist")) {
      throw launchError;
    }
    try {
      return await chromium.launch({ channel: "chrome", ...launchOptions });
    } catch {
      throw new Error("No browser found. Run `npx patchright install chromium`, or install Google Chrome.", { cause: launchError });
    }
  }
}

// Chromium ignores credentials inside the proxy server URL; Playwright needs them as separate fields.
export function buildProxyOption(proxyUrl) {
  const parsedProxy = new URL(proxyUrl);
  const proxyOption = { server: `${parsedProxy.protocol}//${parsedProxy.host}` };
  if (parsedProxy.username) {
    proxyOption.username = decodeURIComponent(parsedProxy.username);
    proxyOption.password = decodeURIComponent(parsedProxy.password);
  }
  return proxyOption;
}

function urlHasAnyFragment(url, fragments) {
  for (const fragment of fragments) {
    if (url.includes(fragment)) {
      return true;
    }
  }
  return false;
}

function randomIntegerBetween(minimum, maximum) {
  return minimum + Math.floor(Math.random() * (maximum - minimum + 1));
}

export async function captureMediaWithBrowser(pageUrl, { proxyUrl = null, scrollRounds = 2, headless = true, storageStatePath = null, enrichPostsInBrowser = 0, loadMedia = false } = {}) {
  const { chromium, engineName } = await loadPlaywright();
  const capturedPayloads = [];
  const pendingResponseReads = [];
  const captureReport = {
    engine: engineName,
    logged_in_session: storageStatePath,
    json_responses: 0,
    final_url: null,
    login_wall: false,
    challenge: false,
  };

  const launchOptions = { headless };
  if (proxyUrl) {
    launchOptions.proxy = buildProxyOption(proxyUrl);
  }
  const browser = await launchChromium(chromium, launchOptions);
  try {
    const contextOptions = { locale: "en-US", viewport: { width: 1366, height: 900 } };
    if (storageStatePath) {
      contextOptions.storageState = storageStatePath;
    }
    const browserContext = await browser.newContext(contextOptions);
    if (!loadMedia) {
      await browserContext.route("**/*", (route) => {
        if (BLOCKED_RESOURCE_TYPES.has(route.request().resourceType())) {
          return route.abort();
        }
        return route.continue();
      });
    }
    const page = await browserContext.newPage();
    page.on("response", (response) => {
      if (!urlHasAnyFragment(response.url(), CAPTURED_URL_FRAGMENTS)) {
        return;
      }
      pendingResponseReads.push(response.json().then((payload) => {
        capturedPayloads.push(payload);
        captureReport.json_responses += 1;
      }, () => {}));
    });
    await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(4_000);
    for (let scrollIndex = 0; scrollIndex < scrollRounds; scrollIndex += 1) {
      await page.mouse.wheel(0, 2_500);
      await page.waitForTimeout(2_000);
    }
    captureReport.final_url = page.url();
    captureReport.login_wall = page.url().includes("/accounts/login");
    captureReport.challenge = urlHasAnyFragment(page.url(), CHALLENGE_URL_FRAGMENTS);
    await Promise.allSettled(pendingResponseReads);
    capturedPayloads.push(...extractEmbeddedJsonBlobs(await page.content()));

    if (enrichPostsInBrowser && !captureReport.challenge && !captureReport.login_wall) {
      const gridShortcodes = new Set();
      for (const capturedPayload of capturedPayloads) {
        for (const media of findMediaNodes(capturedPayload, "grid")) {
          gridShortcodes.add(media.shortcode);
        }
      }
      const shortcodesToVisit = [...gridShortcodes].slice(0, enrichPostsInBrowser);
      captureReport.browser_enrichment = { requested: shortcodesToVisit.length, visited: 0, stopped_reason: null };
      for (const shortcode of shortcodesToVisit) {
        await page.goto(`https://www.instagram.com/p/${shortcode}/`, { waitUntil: "domcontentloaded", timeout: 45_000 });
        await page.waitForTimeout(randomIntegerBetween(2_500, 4_500));
        if (page.url().includes("/accounts/login") || urlHasAnyFragment(page.url(), CHALLENGE_URL_FRAGMENTS)) {
          captureReport.challenge = true;
          captureReport.browser_enrichment.stopped_reason = `challenge or login wall at ${page.url()}`;
          break;
        }
        capturedPayloads.push(...extractEmbeddedJsonBlobs(await page.content()));
        captureReport.browser_enrichment.visited += 1;
      }
      await Promise.allSettled(pendingResponseReads);
    }
    if (storageStatePath && !captureReport.challenge && !captureReport.login_wall) {
      await browserContext.storageState({ path: storageStatePath });
    }
  } finally {
    await browser.close();
  }

  const collectedMedia = new Map();
  const sourceLabel = `browser_${engineName}_${storageStatePath ? "logged_in" : "logged_out"}`;
  for (const capturedPayload of capturedPayloads) {
    for (const media of findMediaNodes(capturedPayload, sourceLabel)) {
      const existingMedia = collectedMedia.get(media.shortcode);
      collectedMedia.set(media.shortcode, existingMedia ? mergeMedia(existingMedia, media) : media);
    }
  }
  captureReport.payloads_inspected = capturedPayloads.length;
  captureReport.metric_fields_seen = probeMetricFields(capturedPayloads);
  return { mediaItems: [...collectedMedia.values()], captureReport };
}

export function mergeMedia(primaryMedia, secondaryMedia) {
  for (const [fieldName, fieldValue] of Object.entries(secondaryMedia)) {
    if (isEmptyValue(primaryMedia[fieldName]) && !isEmptyValue(fieldValue)) {
      primaryMedia[fieldName] = fieldValue;
    }
  }
  return primaryMedia;
}

export function probeMetricFields(capturedPayloads) {
  const fieldStatistics = new Map();

  function record(fieldPath, fieldValue) {
    if (typeof fieldValue === "object" && fieldValue !== null) {
      return;
    }
    if (!fieldStatistics.has(fieldPath)) {
      fieldStatistics.set(fieldPath, { media_nodes: 0, non_null: 0, example: null });
    }
    const statistics = fieldStatistics.get(fieldPath);
    statistics.media_nodes += 1;
    if (fieldValue !== null && fieldValue !== undefined) {
      statistics.non_null += 1;
      if (statistics.example === null) {
        statistics.example = fieldValue;
      }
    }
  }

  for (const capturedPayload of capturedPayloads) {
    for (const jsonObject of walkJson(capturedPayload)) {
      if (!looksLikeMediaNode(jsonObject)) {
        continue;
      }
      for (const [fieldName, fieldValue] of Object.entries(jsonObject)) {
        if (METRIC_FIELD_PATTERN.test(fieldName)) {
          record(fieldName, fieldValue);
        }
        if (isPlainObject(fieldValue)) {
          for (const [childName, childValue] of Object.entries(fieldValue)) {
            if (METRIC_FIELD_PATTERN.test(childName)) {
              record(`${fieldName}.${childName}`, childValue);
            }
          }
        }
      }
    }
  }
  const sortedEntries = [...fieldStatistics.entries()].sort((left, right) => right[1].non_null - left[1].non_null);
  return Object.fromEntries(sortedEntries);
}

export async function saveLoginSession(storageStatePath, proxyUrl = null) {
  const { chromium } = await loadPlaywright();
  mkdirSync(path.dirname(storageStatePath), { recursive: true });
  const launchOptions = { headless: false };
  if (proxyUrl) {
    launchOptions.proxy = buildProxyOption(proxyUrl);
  }
  const browser = await launchChromium(chromium, launchOptions);
  try {
    const browserContext = await browser.newContext({ locale: "en-US", viewport: { width: 1366, height: 900 } });
    const page = await browserContext.newPage();
    await page.goto("https://www.instagram.com/accounts/login/", { waitUntil: "domcontentloaded" });
    const terminal = createInterface({ input: process.stdin, output: process.stderr });
    await terminal.question("Log in manually in the browser window (finish any verification), then press Enter here... ");
    terminal.close();
    await browserContext.storageState({ path: storageStatePath });
  } finally {
    await browser.close();
  }
}
