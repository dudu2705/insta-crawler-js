export function utcNowIso() {
  return new Date().toISOString().replace("Z", "+00:00");
}

export function isEmptyValue(value) {
  return value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
}

export function createMedia(fields) {
  return {
    shortcode: fields.shortcode,
    url: fields.url,
    media_type: fields.media_type ?? null,
    caption: fields.caption ?? null,
    owner_username: fields.owner_username ?? null,
    like_count: fields.like_count ?? null,
    comment_count: fields.comment_count ?? null,
    view_count: fields.view_count ?? null,
    taken_at: fields.taken_at ?? null,
    hashtags: fields.hashtags ?? [],
    source_strategy: fields.source_strategy ?? null,
    captured_at: fields.captured_at ?? utcNowIso(),
  };
}
