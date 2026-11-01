// Resolves a picks article (Action Network, Covers, Rotowire, …) to plain text
// plus the site it came from. The site is the source — picks are credited to
// "Covers", never to the individual writers bylined inside the article.
//
// These sites server-render their picks, so a plain GET carries everything; no
// headless browser needed. If a site starts blocking us (or moves the content
// behind client-side JS) we fall back to the r.jina.ai reader. Like
// fxtwitter.ts, every failure degrades to "no text" rather than throwing, so
// the caller still writes an inbox row.

const TIMEOUT_MS = 12000;

// A long article strips to ~25k chars. This bounds a pathological page without
// truncating any real one.
const MAX_TEXT_CHARS = 60_000;

// Below this the fetch almost certainly got a bot wall or a JS shell.
const MIN_TEXT_CHARS = 800;

// A desktop browser UA — some CDNs serve a stripped page or a 403 to unknown ones.
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

export interface ResolvedArticle {
  text: string | null;
  /** og:site_name ("Covers.com"), else the bare hostname ("covers"). */
  siteName: string | null;
  /** Hostname label alone ("actionnetwork") — a second key for source matching. */
  hostLabel: string | null;
  title: string | null;
  publishedAt: string | null;
  permalink: string;
  error: string | null;
}

/**
 * Only public http(s) pages. The function is authenticated, but it still
 * shouldn't be talked into fetching localhost or a raw IP on someone's behalf.
 */
function checkUrl(raw: string): URL | string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "Not a valid URL";
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return "Only http(s) links are supported";
  const host = u.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ||
    host.includes(":") || host.startsWith("[")
  ) {
    return "That host isn't allowed";
  }
  return u;
}

/** "www.actionnetwork.com" → "actionnetwork". */
function hostLabelOf(u: URL): string {
  const parts = u.hostname.toLowerCase().replace(/^www\./, "").split(".");
  return parts.length > 1 ? parts[parts.length - 2] : parts[0];
}

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal, redirect: "follow" });
  } finally {
    clearTimeout(timer);
  }
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“",
  ndash: "–", mdash: "—", hellip: "…", frac12: "½",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return NAMED_ENTITIES[e.toLowerCase()] ?? m;
  });
}

function metaContent(html: string, prop: string): string | null {
  // Attribute order varies by site (property before content, or after).
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${prop}["'][^>]*>`,
    "i",
  );
  const tag = html.match(re)?.[0];
  const content = tag?.match(/content=["']([^"']*)["']/i)?.[1];
  return content ? decodeEntities(content).trim() : null;
}

/**
 * HTML → readable text that keeps the structure the model needs: one line per
 * paragraph/heading/list item, and table cells joined with " | " so a Covers
 * row reads "Baker Mayfield | Under 224.5 passing yards | Geoff Clark".
 */
export function htmlToText(html: string): string {
  let s = html.match(/<body\b[\s\S]*<\/body>/i)?.[0] ?? html;

  // Everything above the headline is site chrome. Covers builds its promo
  // menus from plain divs, not <nav>, so tag stripping alone leaves ~400 lines
  // of "DraftKings Promo Code" ahead of the article. With exactly one <h1>,
  // start there; with zero or several the page isn't shaped like an article,
  // so keep the whole body rather than risk cutting picks.
  const h1s = [...s.matchAll(/<h1\b/gi)];
  if (h1s.length === 1) s = s.slice(h1s[0].index);

  // Chrome and widgets, not article content. <header> goes too — the title
  // comes from og:title instead.
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  for (const tag of ["script", "style", "noscript", "svg", "iframe", "template", "nav", "footer", "header", "form", "aside"]) {
    s = s.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}>`, "gi"), " ");
  }

  s = s
    .replace(/<\/(td|th)>/gi, " | ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|li|ul|ol|h[1-6]|tr|table|section|article|blockquote|figure|figcaption|dt|dd)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  s = decodeEntities(s);

  const lines: string[] = [];
  for (const raw of s.split("\n")) {
    const line = raw.replace(/\s+/g, " ").replace(/(\s*\|\s*)+$/, "").trim();
    // Skip blanks and the immediate repeats that responsive layouts produce
    // (mobile + desktop copies of the same widget).
    if (line && line !== lines[lines.length - 1]) lines.push(line);
  }
  return lines.join("\n");
}

/** r.jina.ai renders the page and returns it as markdown. Free, unauthenticated, rate-limited. */
async function fetchViaReader(url: string): Promise<string | null> {
  try {
    const res = await fetchWithTimeout(`https://r.jina.ai/${url}`, {
      headers: { Accept: "text/plain" },
    });
    if (!res.ok) return null;
    const text = (await res.text()).trim();
    return text.length >= MIN_TEXT_CHARS ? text : null;
  } catch {
    return null;
  }
}

export async function resolveArticle(rawUrl: string): Promise<ResolvedArticle> {
  const checked = checkUrl(rawUrl.trim());
  const empty: ResolvedArticle = {
    text: null,
    siteName: null,
    hostLabel: null,
    title: null,
    publishedAt: null,
    permalink: rawUrl,
    error: null,
  };
  if (typeof checked === "string") return { ...empty, error: checked };

  const url = checked;
  const hostLabel = hostLabelOf(url);
  const base: ResolvedArticle = { ...empty, siteName: hostLabel, hostLabel, permalink: url.href };

  let directError: string | null = null;
  try {
    const res = await fetchWithTimeout(url.href, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" },
    });
    if (!res.ok) {
      directError = `HTTP ${res.status}`;
    } else {
      const html = await res.text();
      const text = htmlToText(html);
      const article: ResolvedArticle = {
        ...base,
        siteName: metaContent(html, "og:site_name") ?? hostLabel,
        title: metaContent(html, "og:title") ??
          (decodeEntities(html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? "").trim() || null),
        publishedAt: metaContent(html, "article:published_time") ??
          html.match(/"datePublished"\s*:\s*"([^"]+)"/)?.[1] ?? null,
        permalink: metaContent(html, "og:url") ?? url.href,
      };
      if (text.length >= MIN_TEXT_CHARS) {
        return { ...article, text: text.slice(0, MAX_TEXT_CHARS) };
      }
      directError = "page had almost no readable text";
      Object.assign(base, article);
    }
  } catch (e) {
    directError = e instanceof Error ? e.message : String(e);
  }

  const readerText = await fetchViaReader(url.href);
  if (readerText) return { ...base, text: readerText.slice(0, MAX_TEXT_CHARS) };

  return { ...base, error: `Couldn't read the article (${directError}; reader fallback failed too)` };
}
