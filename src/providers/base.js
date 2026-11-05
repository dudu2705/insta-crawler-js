export const CAPABILITIES = ["trending", "hashtag", "hashtag_recent", "search", "profile_posts", "post"];

export class CapabilityNotSupportedError extends Error {
  name = "CapabilityNotSupportedError";
}

export class ProviderRequestError extends Error {
  name = "ProviderRequestError";
}

export class ProviderResult {
  constructor({ providerName, capability, target, items = [], rawResponses = [], costNote = null }) {
    this.providerName = providerName;
    this.capability = capability;
    this.target = target ?? null;
    this.items = items;
    this.rawResponses = rawResponses;
    this.durationSeconds = 0;
    this.costNote = costNote;
    this.nextCursor = null;
  }

  toDict(includeRaw = false) {
    const resultDict = {
      provider: this.providerName,
      capability: this.capability,
      target: this.target,
      item_count: this.items.length,
      duration_seconds: this.durationSeconds,
      cost_note: this.costNote,
      next_cursor: this.nextCursor,
      items: this.items,
    };
    if (includeRaw) {
      resultDict.raw_responses = this.rawResponses;
    }
    return resultDict;
  }
}

function capabilityMethodName(capability) {
  let methodName = "fetch";
  for (const namePart of capability.split("_")) {
    methodName += namePart[0].toUpperCase() + namePart.slice(1);
  }
  return methodName;
}

export class InstagramDataProvider {
  static providerName = "base";
  static apiKeyEnvironmentVariable = "";
  static supportedCapabilities = [];

  constructor(apiKey = null, requestTimeoutSeconds = 120) {
    this.providerName = this.constructor.providerName;
    this.supportedCapabilities = this.constructor.supportedCapabilities;
    this.apiKey = apiKey || process.env[this.constructor.apiKeyEnvironmentVariable];
    if (!this.apiKey) {
      throw new Error(`${this.providerName}: set ${this.constructor.apiKeyEnvironmentVariable} in .env`);
    }
    this.requestTimeoutSeconds = requestTimeoutSeconds;
  }

  async sendRequest(method, url, { params, json, headers } = {}) {
    const requestUrl = new URL(url);
    for (const [parameterName, parameterValue] of Object.entries(params ?? {})) {
      if (parameterValue !== null && parameterValue !== undefined) {
        requestUrl.searchParams.set(parameterName, String(parameterValue));
      }
    }
    const response = await fetch(requestUrl, {
      method,
      headers,
      body: json === undefined ? undefined : JSON.stringify(json),
      signal: AbortSignal.timeout(this.requestTimeoutSeconds * 1000),
    });
    const responseText = await response.text();
    if (response.status >= 400) {
      throw new ProviderRequestError(`${this.providerName} HTTP ${response.status}: ${responseText.slice(0, 300)}`);
    }
    return JSON.parse(responseText);
  }

  async run(capability, target, limit) {
    if (!this.supportedCapabilities.includes(capability)) {
      throw new CapabilityNotSupportedError(`${this.providerName} has no '${capability}' capability`);
    }
    const startedAt = Date.now();
    const providerResult = await this[capabilityMethodName(capability)](target, limit);
    providerResult.durationSeconds = Math.round((Date.now() - startedAt) / 10) / 100;
    return providerResult;
  }
}
