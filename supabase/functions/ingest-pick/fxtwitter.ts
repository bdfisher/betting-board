// Resolves an x.com/twitter.com permalink to its text + media via FxTwitter,
// a free unauthenticated mirror of the public tweet data. X itself requires a
// paid API key to read a tweet, so this is the only no-cost way to turn a
// shared URL into content.
//
// It's a third-party community service, so every failure path here degrades to
// "no text, no image" rather than throwing — the caller still writes an inbox
// row so the pick is never silently dropped.

const TIMEOUT_MS = 8000;

// Largest image we'll pull down and base64 into the model request.
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

export interface ResolvedTweet {
  text: string | null;
  authorHandle: string | null;
  /** First photo — kept for the inbox row's thumbnail. */
  imageUrl: string | null;
  /** Every photo. Cheat-sheet posts routinely carry 2–4 pages of props. */
  imageUrls: string[];
  permalink: string | null;
  error: string | null;
}

/** Pulls the numeric status id out of any x.com / twitter.com permalink. */
export function parseStatusId(url: string): string | null {
  const m = url.match(/(?:twitter\.com|x\.com)\/[^/]+\/status(?:es)?\/(\d+)/i);
  return m ? m[1] : null;
}

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function resolveTweet(url: string): Promise<ResolvedTweet> {
  const empty: ResolvedTweet = {
    text: null,
    authorHandle: null,
    imageUrl: null,
    imageUrls: [],
    permalink: url,
    error: null,
  };

  const id = parseStatusId(url);
  if (!id) return { ...empty, error: "Not a recognizable tweet URL" };

  try {
    const res = await fetchWithTimeout(`https://api.fxtwitter.com/status/${id}`, TIMEOUT_MS);
    if (!res.ok) return { ...empty, error: `FxTwitter HTTP ${res.status}` };

    const body = await res.json();
    // FxTwitter always returns a { code, message, tweet } envelope.
    if (body?.code !== 200 || !body?.tweet) {
      return { ...empty, error: `FxTwitter: ${body?.message ?? "no tweet"}` };
    }

    const t = body.tweet;
    // media.photos is the convenient list; media.all also carries videos/gifs,
    // which we skip — a pick graphic is always a still.
    //
    // Take ALL photos, not just the first: handicappers post cheat sheets as a
    // carousel ("Passing / Rushing / Receiving / TD Scorers"), and reading only
    // page one silently drops three quarters of the picks.
    const photos: string[] = (
      t.media?.photos?.length
        ? t.media.photos
        : (t.media?.all ?? []).filter((m: { type?: string }) => m?.type === "photo")
    )
      .map((p: { url?: string }) => p?.url)
      .filter(Boolean);

    return {
      text: t.text ?? null,
      authorHandle: t.author?.screen_name ? `@${t.author.screen_name}` : null,
      imageUrl: photos[0] ?? null,
      imageUrls: photos,
      permalink: t.url ?? url,
      error: null,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ...empty, error: `FxTwitter fetch failed: ${msg}` };
  }
}

/**
 * Gemini can't fetch an image from a URL the way some other APIs can — it only
 * takes inline base64 or a Files API handle. So when a tweet carries a photo we
 * have to download the bytes ourselves before handing them to the model.
 */
export async function fetchImageAsBase64(
  url: string,
): Promise<{ data: string; mimeType: string } | null> {
  try {
    const res = await fetchWithTimeout(url, TIMEOUT_MS);
    if (!res.ok) return null;

    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > MAX_IMAGE_BYTES) return null;

    const mimeType = res.headers.get("content-type")?.split(";")[0] || "image/jpeg";
    if (!mimeType.startsWith("image/")) return null;

    return { data: base64Encode(buf), mimeType };
  } catch {
    return null;
  }
}

/**
 * btoa() only takes a binary string, and spreading a multi-MB Uint8Array into
 * String.fromCharCode blows the argument limit — so chunk it.
 */
export function base64Encode(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
