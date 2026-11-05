const SCRIPT_JSON_PATTERN = /<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/g;

export function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function* walkJson(payload) {
  if (isPlainObject(payload)) {
    yield payload;
    for (const childValue of Object.values(payload)) {
      yield* walkJson(childValue);
    }
  } else if (Array.isArray(payload)) {
    for (const childValue of payload) {
      yield* walkJson(childValue);
    }
  }
}

export function extractEmbeddedJsonBlobs(htmlText) {
  const parsedBlobs = [];
  for (const scriptMatch of htmlText.matchAll(SCRIPT_JSON_PATTERN)) {
    try {
      parsedBlobs.push(JSON.parse(scriptMatch[1]));
    } catch {
      continue;
    }
  }
  return parsedBlobs;
}

export function unwrapLoggedOutGate(payload) {
  if (isPlainObject(payload) && "if_not_gated_logged_out" in payload) {
    return payload.if_not_gated_logged_out;
  }
  return payload;
}
