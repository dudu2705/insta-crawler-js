import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const INSTAGRAM_BASE_URL = "https://www.instagram.com";
export const DEFAULT_SESSIONS_DIRECTORY = "sessions";
const POOL_STATE_FILENAME = "pool_state.json";
const COOLDOWN_AFTER_CHALLENGE_SECONDS = 24 * 60 * 60;

export const TARGET_KINDS = ["hashtag", "explore", "reels", "search", "profile", "location"];

export function buildTargetUrl(targetKind, targetValue) {
  if (!TARGET_KINDS.includes(targetKind)) {
    throw new Error(`Unknown target kind ${targetKind}, expected one of ${[...TARGET_KINDS].sort().join(", ")}`);
  }
  if (targetKind !== "explore" && targetKind !== "reels" && !targetValue) {
    throw new Error(`${targetKind} needs a value`);
  }
  switch (targetKind) {
    case "hashtag":
      return `${INSTAGRAM_BASE_URL}/popular/${encodeURIComponent(targetValue.replace(/^#+/, ""))}/`;
    case "explore":
      return `${INSTAGRAM_BASE_URL}/explore/`;
    case "reels":
      return `${INSTAGRAM_BASE_URL}/reels/`;
    case "search":
      return `${INSTAGRAM_BASE_URL}/explore/search/keyword/?q=${encodeURIComponent(targetValue)}`;
    case "profile":
      return `${INSTAGRAM_BASE_URL}/${targetValue.replace(/^@+/, "")}/`;
    case "location":
      return `${INSTAGRAM_BASE_URL}/explore/locations/${targetValue}/`;
  }
}

function nowSeconds() {
  return Date.now() / 1000;
}

function createSessionState(fields) {
  return {
    session_name: fields.session_name,
    proxy_url: fields.proxy_url ?? null,
    last_used_at: fields.last_used_at ?? 0,
    uses: fields.uses ?? 0,
    challenges: fields.challenges ?? 0,
    disabled_until: fields.disabled_until ?? 0,
    notes: fields.notes ?? [],
  };
}

function isSessionAvailable(sessionState, now) {
  return now >= sessionState.disabled_until;
}

export class SessionPool {
  constructor(sessionsDirectory = DEFAULT_SESSIONS_DIRECTORY) {
    this.sessionsDirectory = sessionsDirectory;
    this.statePath = path.join(sessionsDirectory, POOL_STATE_FILENAME);
    this.sessionStates = this.loadStates();
  }

  loadStates() {
    const storedStates = new Map();
    if (existsSync(this.statePath)) {
      for (const stateValues of Object.values(JSON.parse(readFileSync(this.statePath, "utf8")))) {
        storedStates.set(stateValues.session_name, createSessionState(stateValues));
      }
    }
    if (existsSync(this.sessionsDirectory)) {
      for (const fileName of readdirSync(this.sessionsDirectory).sort()) {
        if (!fileName.endsWith(".json") || fileName === POOL_STATE_FILENAME) {
          continue;
        }
        const sessionName = fileName.slice(0, -".json".length);
        if (!storedStates.has(sessionName)) {
          storedStates.set(sessionName, createSessionState({ session_name: sessionName }));
        }
      }
    }
    return storedStates;
  }

  saveStates() {
    mkdirSync(this.sessionsDirectory, { recursive: true });
    writeFileSync(this.statePath, JSON.stringify(Object.fromEntries(this.sessionStates), null, 2));
  }

  sessionPath(sessionName) {
    return path.join(this.sessionsDirectory, `${sessionName}.json`);
  }

  register(sessionName, proxyUrl) {
    if (!this.sessionStates.has(sessionName)) {
      this.sessionStates.set(sessionName, createSessionState({ session_name: sessionName }));
    }
    if (proxyUrl) {
      this.sessionStates.get(sessionName).proxy_url = proxyUrl;
    }
    this.saveStates();
  }

  pickSession(ignoreCooldown = false) {
    const now = nowSeconds();
    let bestState = null;
    for (const sessionState of this.sessionStates.values()) {
      if (!existsSync(this.sessionPath(sessionState.session_name))) {
        continue;
      }
      if (!ignoreCooldown && !isSessionAvailable(sessionState, now)) {
        continue;
      }
      const isLessUsed = bestState === null
        || sessionState.last_used_at < bestState.last_used_at
        || (sessionState.last_used_at === bestState.last_used_at && sessionState.uses < bestState.uses);
      if (isLessUsed) {
        bestState = sessionState;
      }
    }
    return bestState;
  }

  minutesUntilNextAvailable() {
    let earliestSeconds = null;
    for (const sessionState of this.sessionStates.values()) {
      if (!existsSync(this.sessionPath(sessionState.session_name))) {
        continue;
      }
      const availableAt = sessionState.disabled_until;
      if (earliestSeconds === null || availableAt < earliestSeconds) {
        earliestSeconds = availableAt;
      }
    }
    return earliestSeconds === null ? null : Math.max(1, Math.ceil((earliestSeconds - nowSeconds()) / 60));
  }

  recordUse(sessionName, hitChallenge, note = null) {
    const sessionState = this.sessionStates.get(sessionName);
    sessionState.last_used_at = nowSeconds();
    sessionState.uses += 1;
    if (hitChallenge) {
      sessionState.challenges += 1;
      sessionState.disabled_until = nowSeconds() + COOLDOWN_AFTER_CHALLENGE_SECONDS;
    }
    if (note) {
      sessionState.notes = [...sessionState.notes, note].slice(-10);
    }
    this.saveStates();
  }

  summary() {
    const now = nowSeconds();
    const summaryRows = [];
    for (const sessionState of this.sessionStates.values()) {
      summaryRows.push({
        session: sessionState.session_name,
        proxy: Boolean(sessionState.proxy_url),
        uses: sessionState.uses,
        challenges: sessionState.challenges,
        available: isSessionAvailable(sessionState, now),
        cooldown_left_minutes: Math.max(0, Math.round((sessionState.disabled_until - now) / 60)),
      });
    }
    return summaryRows;
  }
}
