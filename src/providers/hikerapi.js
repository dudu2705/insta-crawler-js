import { isPlainObject } from "../json-tools.js";
import { findMediaNodes } from "../parsers.js";
import { InstagramDataProvider, ProviderResult } from "./base.js";

const HIKERAPI_BASE_URL = "https://api.hikerapi.com";

export function splitChunkResponse(chunkResponse) {
  if (Array.isArray(chunkResponse) && chunkResponse.length === 2 && Array.isArray(chunkResponse[0])) {
    const nextCursor = typeof chunkResponse[1] === "string" ? chunkResponse[1] : null;
    return [chunkResponse[0], nextCursor];
  }
  if (Array.isArray(chunkResponse)) {
    return [chunkResponse, null];
  }
  if (isPlainObject(chunkResponse)) {
    for (const listKey of ["items", "medias", "response"]) {
      if (Array.isArray(chunkResponse[listKey])) {
        return [chunkResponse[listKey], chunkResponse.next_page_id || chunkResponse.end_cursor || null];
      }
    }
    return [[chunkResponse], null];
  }
  return [[], null];
}

export class HikerApiProvider extends InstagramDataProvider {
  static providerName = "hikerapi";
  static apiKeyEnvironmentVariable = "HIKERAPI_KEY";
  static supportedCapabilities = ["hashtag", "search", "profile_posts", "post"];

  get(endpointPath, queryParameters) {
    return this.sendRequest("GET", `${HIKERAPI_BASE_URL}${endpointPath}`, { params: queryParameters, headers: { "x-access-key": this.apiKey, accept: "application/json" } });
  }

  async collectChunks(endpointPath, queryParameters, cursorParameter, capability, target, limit) {
    const providerResult = new ProviderResult({ providerName: this.providerName, capability, target });
    const currentParameters = { ...queryParameters };
    let requestCount = 0;
    while (providerResult.items.length < limit && requestCount < 10) {
      const chunkResponse = await this.get(endpointPath, { ...currentParameters });
      requestCount += 1;
      providerResult.rawResponses.push(chunkResponse);
      const [mediaRows, nextCursor] = splitChunkResponse(chunkResponse);
      for (const mediaRow of mediaRows) {
        providerResult.items.push(...findMediaNodes(mediaRow, `provider_hikerapi_${capability}`));
      }
      providerResult.nextCursor = nextCursor;
      if (!nextCursor || !mediaRows.length) {
        break;
      }
      currentParameters[cursorParameter] = nextCursor;
    }
    providerResult.items = providerResult.items.slice(0, limit);
    providerResult.costNote = `${requestCount} requests (~$1 per 1k, 4xx also billed)`;
    return providerResult;
  }

  fetchHashtag(hashtagName, limit) {
    return this.collectChunks("/v1/hashtag/medias/top/chunk", { name: hashtagName.replace(/^#+/, "") }, "max_id", "hashtag", hashtagName, limit);
  }

  async fetchSearch(query, limit) {
    const hashtagMatches = await this.get("/v1/search/hashtags", { query });
    const hashtagRows = Array.isArray(hashtagMatches) ? hashtagMatches : hashtagMatches.results || [];
    if (!hashtagRows.length) {
      return new ProviderResult({ providerName: this.providerName, capability: "search", target: query, rawResponses: [hashtagMatches], costNote: "1 request" });
    }
    const bestHashtagName = hashtagRows[0].name;
    const providerResult = await this.fetchHashtag(bestHashtagName, limit);
    providerResult.capability = "search";
    providerResult.target = `${query} -> #${bestHashtagName}`;
    providerResult.rawResponses.unshift(hashtagMatches);
    return providerResult;
  }

  async fetchProfilePosts(username, limit) {
    const userPayload = await this.get("/v1/user/by/username", { username: username.replace(/^@+/, "") });
    const userId = userPayload.pk || userPayload.id;
    const providerResult = await this.collectChunks("/v1/user/clips/chunk", { user_id: userId }, "end_cursor", "profile_posts", username, limit);
    providerResult.rawResponses.unshift(userPayload);
    return providerResult;
  }

  async fetchPost(shortcode) {
    const mediaPayload = await this.get("/v1/media/by/code", { code: shortcode });
    return new ProviderResult({
      providerName: this.providerName,
      capability: "post",
      target: shortcode,
      items: findMediaNodes(mediaPayload, "provider_hikerapi_post"),
      rawResponses: [mediaPayload],
      costNote: "1 request",
    });
  }
}
