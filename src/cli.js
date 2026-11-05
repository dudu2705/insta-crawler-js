#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { captureMediaWithBrowser, saveLoginSession } from "./browser-capture.js";
import { providerHashtagFetcher, runHashtagBatch } from "./hashtag-batch.js";
import { CAPABILITIES, CapabilityNotSupportedError, PROVIDER_CLASSES } from "./providers/index.js";
import { DEFAULT_SESSIONS_DIRECTORY, SessionPool, TARGET_KINDS, buildTargetUrl } from "./session-pool.js";

const SHORTCODE_PATTERN = /instagram\.com\/(?:[\w.]+\/)?(?:p|reel|reels)\/([\w-]+)/;
const DEFAULT_BATCH_HASHTAGS = "balayage,haircolor,copperhair,curlyhair,hairtok,bondrepair";
const BATCH_METHODS = ["socialcrawl", "hikerapi", "apify"];
const ENRICH_MODES = ["browser", "none"];

class UsageError extends Error {}

function normalizeShortcode(postReference) {
  const urlMatch = SHORTCODE_PATTERN.exec(postReference);
  return urlMatch ? urlMatch[1] : postReference.replace(/^\/+|\/+$/g, "");
}

function normalizeUsername(profileReference) {
  return profileReference.replace(/\/+$/, "").split("/").at(-1).replace(/^@+/, "");
}

function log(message) {
  console.error(message);
}

function printJson(payload) {
  console.log(JSON.stringify(payload, null, 2));
}

function pad(number) {
  return String(number).padStart(2, "0");
}

function localTimestamp(includeSeconds) {
  const now = new Date();
  const datePart = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const timePart = `${pad(now.getHours())}${pad(now.getMinutes())}${includeSeconds ? pad(now.getSeconds()) : ""}`;
  return `${datePart}_${timePart}`;
}

function slugifyNamePart(namePart) {
  return String(namePart).replace(/[^\p{L}\p{N}_]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

function writeJsonFile(outputPath, payload) {
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(payload, null, 2));
}

function saveResult(payload, options, ...nameParts) {
  let outputPath = options.output;
  if (!outputPath) {
    const stemParts = [];
    for (const namePart of nameParts) {
      if (namePart) {
        stemParts.push(slugifyNamePart(namePart));
      }
    }
    outputPath = path.join("results", `${stemParts.join("_")}_${localTimestamp(true)}.json`);
  }
  writeJsonFile(outputPath, payload);
  log(`saved to ${outputPath}`);
  if (options.print) {
    printJson(payload);
  }
}

function requireChoice(optionName, optionValue, allowedValues) {
  if (!allowedValues.includes(optionValue)) {
    throw new UsageError(`${optionName} must be one of: ${allowedValues.join(", ")} (got ${optionValue === undefined ? "nothing" : `'${optionValue}'`})`);
  }
}

function toInteger(optionName, optionValue) {
  const parsedValue = Number(optionValue);
  if (!Number.isInteger(parsedValue)) {
    throw new UsageError(`${optionName} must be an integer`);
  }
  return parsedValue;
}

function toNumber(optionName, optionValue) {
  const parsedValue = Number(optionValue);
  if (Number.isNaN(parsedValue)) {
    throw new UsageError(`${optionName} must be a number`);
  }
  return parsedValue;
}

function countFilledMediaFields(itemDict) {
  const checkedFields = ["caption", "owner_username", "like_count", "comment_count", "view_count", "taken_at"];
  let filledCount = 0;
  for (const fieldName of checkedFields) {
    const fieldValue = itemDict[fieldName];
    const isEmpty = fieldValue === null || fieldValue === undefined || fieldValue === "" || (Array.isArray(fieldValue) && fieldValue.length === 0);
    if (!isEmpty) {
      filledCount += 1;
    }
  }
  return filledCount / checkedFields.length;
}

function buildProvider(providerName) {
  try {
    return new PROVIDER_CLASSES[providerName]();
  } catch (setupError) {
    throw new UsageError(setupError.message);
  }
}

function normalizeProviderTarget(capability, targetValue) {
  if (targetValue && capability === "post") {
    return normalizeShortcode(targetValue);
  }
  if (targetValue && capability === "profile_posts") {
    return normalizeUsername(targetValue);
  }
  return targetValue ?? null;
}

async function commandLoginBrowser(positionals, options) {
  const [sessionName] = positionals;
  if (!sessionName) {
    throw new UsageError("login-browser needs a session name");
  }
  const sessionPool = new SessionPool(options["sessions-dir"]);
  await saveLoginSession(sessionPool.sessionPath(sessionName), options.proxy);
  sessionPool.register(sessionName, options.proxy);
  log(`saved session ${sessionName}`);
}

async function commandSessions(positionals, options) {
  printJson(new SessionPool(options["sessions-dir"]).summary());
}

function countWhere(mediaItems, predicate) {
  let matchCount = 0;
  for (const media of mediaItems) {
    if (predicate(media)) {
      matchCount += 1;
    }
  }
  return matchCount;
}

async function commandBrowserAuth(positionals, options) {
  const [kind, value] = positionals;
  requireChoice("kind", kind, TARGET_KINDS);
  requireChoice("--enrich", options.enrich, ENRICH_MODES);
  const sessionPool = new SessionPool(options["sessions-dir"]);
  const sessionState = options.session ? sessionPool.sessionStates.get(options.session) : sessionPool.pickSession(options["ignore-cooldown"]);
  if (!sessionState) {
    const waitMinutes = sessionPool.minutesUntilNextAvailable();
    if (waitMinutes === null) {
      throw new UsageError("No saved sessions. Run `login-browser <name>` first.");
    }
    throw new UsageError(`All sessions are cooling down after a challenge (24h). Next one is free in ~${waitMinutes} min. Use --session <name> to force one.`);
  }
  const targetUrl = buildTargetUrl(kind, value);
  log(`using session ${sessionState.session_name} -> ${targetUrl}`);
  const enrichLimit = toInteger("--enrich-limit", options["enrich-limit"]);
  const { mediaItems, captureReport } = await captureMediaWithBrowser(targetUrl, {
    proxyUrl: options.proxy || sessionState.proxy_url,
    scrollRounds: toInteger("--scrolls", options.scrolls),
    headless: !options.headed,
    loadMedia: options["load-media"],
    storageStatePath: sessionPool.sessionPath(sessionState.session_name),
    enrichPostsInBrowser: options.enrich === "browser" ? enrichLimit : 0,
  });
  const hitChallenge = captureReport.challenge || captureReport.login_wall;
  sessionPool.recordUse(sessionState.session_name, hitChallenge, `${kind}:${mediaItems.length} items${hitChallenge ? " CHALLENGE" : ""}`);
  if (hitChallenge) {
    log(`session ${sessionState.session_name} hit a challenge/login wall, cooled down for 24h. Open it with \`login-browser ${sessionState.session_name}\` to resolve.`);
  }
  log(`browser-auth ${kind}: ${mediaItems.length} items from ${captureReport.json_responses} JSON responses`);
  if (options.enrich === "browser") {
    log(`  browser enrichment: ${JSON.stringify(captureReport.browser_enrichment ?? null)}`);
  }
  const total = mediaItems.length;
  log(
    `  filled -> likes: ${countWhere(mediaItems, (media) => media.like_count !== null)}/${total} | `
    + `comments: ${countWhere(mediaItems, (media) => media.comment_count !== null)}/${total} | `
    + `views: ${countWhere(mediaItems, (media) => media.view_count !== null)}/${total} | `
    + `videos: ${countWhere(mediaItems, (media) => media.media_type === "video")}`,
  );
  if (options["show-fields"]) {
    log("  metric fields Instagram sent (non_null/seen, example):");
    for (const [fieldPath, fieldStatistics] of Object.entries(captureReport.metric_fields_seen ?? {}).slice(0, 15)) {
      log(`    ${fieldPath.padEnd(40)} ${fieldStatistics.non_null}/${fieldStatistics.media_nodes}  ${fieldStatistics.example}`);
    }
  }
  saveResult({ report: captureReport, media: mediaItems }, options, "browser_auth", kind, value);
}

async function commandProvider(positionals, options) {
  const [providerName, capability, target] = positionals;
  requireChoice("provider", providerName, Object.keys(PROVIDER_CLASSES));
  requireChoice("capability", capability, CAPABILITIES);
  const providerResult = await buildProvider(providerName).run(capability, normalizeProviderTarget(capability, target), toInteger("--limit", options.limit));
  log(`${providerResult.providerName} ${providerResult.capability}: ${providerResult.items.length} items, ${providerResult.durationSeconds}s, ${providerResult.costNote}`);
  saveResult(providerResult.toDict(options.raw), options, providerResult.providerName, providerResult.capability, providerResult.target);
}

async function commandCompare(positionals, options) {
  const [capability, target] = positionals;
  requireChoice("capability", capability, CAPABILITIES);
  const providerNames = options.providers ? options.providers.split(",") : Object.keys(PROVIDER_CLASSES);
  const targetValue = normalizeProviderTarget(capability, target);
  const limit = toInteger("--limit", options.limit);
  const comparisonRows = [];
  for (const providerName of providerNames) {
    try {
      const providerResult = await buildProvider(providerName).run(capability, targetValue, limit);
      const resultDict = providerResult.toDict(options.raw);
      const itemDicts = resultDict.items;
      let coverageTotal = 0;
      for (const itemDict of itemDicts) {
        coverageTotal += countFilledMediaFields(itemDict);
      }
      comparisonRows.push({
        provider: providerName,
        status: "ok",
        items: itemDicts.length,
        field_coverage: itemDicts.length ? Math.round((coverageTotal / itemDicts.length) * 100) / 100 : 0,
        seconds: providerResult.durationSeconds,
        cost: providerResult.costNote,
        result: resultDict,
      });
    } catch (providerError) {
      if (providerError instanceof CapabilityNotSupportedError) {
        comparisonRows.push({ provider: providerName, status: "not supported", detail: providerError.message });
      } else {
        comparisonRows.push({ provider: providerName, status: "error", detail: `${providerError.name}: ${providerError.message}`.slice(0, 300) });
      }
    }
  }
  log(`\n== compare ${capability} ${targetValue || ""} ==`);
  for (const comparisonRow of comparisonRows) {
    if (comparisonRow.status === "ok") {
      log(`  ${comparisonRow.provider.padEnd(12)} ok    items=${String(comparisonRow.items).padEnd(4)} coverage=${String(comparisonRow.field_coverage).padEnd(5)} ${comparisonRow.seconds}s  ${comparisonRow.cost}`);
    } else {
      log(`  ${comparisonRow.provider.padEnd(12)} ${comparisonRow.status.padEnd(14)} ${comparisonRow.detail}`);
    }
  }
  writeJsonFile(options.output, comparisonRows);
  log(`full results saved to ${options.output}`);
}

async function commandHashtagBatch(positionals, options) {
  requireChoice("--method", options.method, BATCH_METHODS);
  const hashtags = [];
  for (const hashtag of options.hashtags.split(",")) {
    if (hashtag.trim()) {
      hashtags.push(hashtag.trim().replace(/^#+/, ""));
    }
  }
  const rankings = [];
  for (const ranking of options.rankings.split(",")) {
    rankings.push(ranking.trim());
  }
  const hashtagFetcher = providerHashtagFetcher(buildProvider(options.method));
  log(`\n== hashtag-batch via ${options.method}: ${hashtags.length} hashtags x ${rankings.join(",")} ==`);
  const collection = await runHashtagBatch(options.method, hashtagFetcher, hashtags, {
    rankings,
    limitPerQuery: toInteger("--limit", options.limit),
    pauseSeconds: toNumber("--pause", options.pause),
    log,
  });
  const outputPath = options.output || path.join("results", `hashtags_${options.method}_${localTimestamp(false)}.json`);
  writeJsonFile(outputPath, collection);
  const summary = collection.summary;
  log(
    `\n${summary.total_posts} unique posts | likes ${summary.total_likes} | comments ${summary.total_comments} | `
    + `with views ${summary.posts_with_views} | with timestamp ${summary.posts_with_timestamp} | `
    + `partial=${collection.metadata.partial} | ${collection.metadata.duration_seconds}s`,
  );
  let rankIndex = 1;
  for (const topPost of summary.top_posts.slice(0, 5)) {
    log(`  ${rankIndex}. ${String(topPost.engagement_per_hour).padStart(10)}/h  @${topPost.owner}  ${topPost.url}  ${JSON.stringify(topPost.hashtags)}`);
    rankIndex += 1;
  }
  log(`saved to ${outputPath}`);
}

const OUTPUT_OPTIONS = {
  output: { type: "string" },
  print: { type: "boolean", default: false },
};

const COMMANDS = {
  "login-browser": {
    usage: "login-browser <session_name> [--proxy url] [--sessions-dir sessions]",
    help: "Open a browser, log in manually, save the session",
    options: { proxy: { type: "string" }, "sessions-dir": { type: "string", default: DEFAULT_SESSIONS_DIRECTORY } },
    handler: commandLoginBrowser,
  },
  sessions: {
    usage: "sessions [--sessions-dir sessions]",
    help: "Show session pool status",
    options: { "sessions-dir": { type: "string", default: DEFAULT_SESSIONS_DIRECTORY } },
    handler: commandSessions,
  },
  "browser-auth": {
    usage: `browser-auth <${TARGET_KINDS.join("|")}> [value] [--session name] [--scrolls 3] [--headed] [--load-media] [--ignore-cooldown] [--enrich browser|none] [--enrich-limit 24] [--show-fields] [--proxy url] [--output file] [--print]`,
    help: "Crawl with a saved logged-in session",
    options: {
      session: { type: "string" },
      "sessions-dir": { type: "string", default: DEFAULT_SESSIONS_DIRECTORY },
      scrolls: { type: "string", default: "3" },
      headed: { type: "boolean", default: false },
      "load-media": { type: "boolean", default: false },
      "ignore-cooldown": { type: "boolean", default: false },
      enrich: { type: "string", default: "none" },
      "enrich-limit": { type: "string", default: "24" },
      "show-fields": { type: "boolean", default: false },
      proxy: { type: "string" },
      ...OUTPUT_OPTIONS,
    },
    handler: commandBrowserAuth,
  },
  provider: {
    usage: `provider <${Object.keys(PROVIDER_CLASSES).join("|")}> <${CAPABILITIES.join("|")}> [target] [--limit 20] [--raw] [--output file] [--print]`,
    help: "Call one 3rd-party provider",
    options: { limit: { type: "string", default: "20" }, raw: { type: "boolean", default: false }, ...OUTPUT_OPTIONS },
    handler: commandProvider,
  },
  compare: {
    usage: `compare <${CAPABILITIES.join("|")}> [target] [--providers a,b] [--limit 20] [--raw] [--output compare.json]`,
    help: "Same request across providers, side by side",
    options: { providers: { type: "string" }, limit: { type: "string", default: "20" }, raw: { type: "boolean", default: false }, output: { type: "string", default: "compare.json" } },
    handler: commandCompare,
  },
  "hashtag-batch": {
    usage: `hashtag-batch --method <${BATCH_METHODS.join("|")}> [--hashtags a,b] [--rankings top,recent] [--limit 30] [--pause 2] [--output file]`,
    help: "For each hashtag, fetch top (+ recent where supported), dedupe, rank by engagement/hour",
    options: {
      method: { type: "string" },
      hashtags: { type: "string", default: DEFAULT_BATCH_HASHTAGS },
      rankings: { type: "string", default: "top,recent" },
      limit: { type: "string", default: "30" },
      pause: { type: "string", default: "2" },
      output: { type: "string" },
    },
    handler: commandHashtagBatch,
  },
};

function printUsage() {
  const usageLines = ["usage: node src/cli.js <command> [options]", ""];
  for (const [commandName, command] of Object.entries(COMMANDS)) {
    usageLines.push(`  ${commandName.padEnd(14)} ${command.help}`);
  }
  usageLines.push("", "Run `node src/cli.js <command> --help` for a command's options.");
  log(usageLines.join("\n"));
}

async function main() {
  if (existsSync(".env")) {
    process.loadEnvFile(".env");
  }
  const [commandName, ...commandArguments] = process.argv.slice(2);
  const command = COMMANDS[commandName];
  if (!command) {
    printUsage();
    process.exit(commandName && commandName !== "--help" && commandName !== "-h" ? 2 : 0);
  }
  if (commandArguments.includes("--help") || commandArguments.includes("-h")) {
    log(`usage: node src/cli.js ${command.usage}`);
    return;
  }
  try {
    const { values, positionals } = parseArgs({ args: commandArguments, options: command.options, allowPositionals: true, strict: true });
    await command.handler(positionals, values);
  } catch (commandError) {
    if (commandError instanceof UsageError || commandError.code?.startsWith("ERR_PARSE_ARGS")) {
      log(`error: ${commandError.message}\nusage: node src/cli.js ${command.usage}`);
      process.exit(2);
    }
    throw commandError;
  }
}

await main();
