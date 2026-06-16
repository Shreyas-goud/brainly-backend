import axios from "axios";
import { IncomingMessage } from "http";
import { GITHUB_TOKEN, INSTAGRAM_APP_ID, INSTAGRAM_CLIENT_TOKEN } from "../config";

export interface OgData {
  title: string | null;
  description: string | null;
  image: string | null;
  favicon: string | null;
}

const TIMEOUT_MS = 8000;
// Stop streaming once we've seen </head> or hit this byte cap.
// OG meta tags live in <head> which is always under 100KB even on
// the heaviest pages (Instagram is ~5MB total but <head> is ~20KB).
const MAX_HEAD_BYTES = 100_000;

// Full Chromium header set — passes most Cloudflare/bot-detection checks.
const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Cache-Control": "no-cache",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "sec-ch-ua": '"Chromium";v="125", "Not/A)Brand";v="8"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"macOS"',
  "Upgrade-Insecure-Requests": "1",
};

const GITHUB_REPO_RE =
  /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/?#\s]+)/i;

const INSTAGRAM_POST_RE =
  /instagram\.com\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/i;

/**
 * Decode numeric HTML entities (&#x1f4bb; → 💻, &#128187; → 💻) and named
 * entities (&amp; &lt; etc.). Instagram oEmbed returns captions with entities
 * encoded — we decode before storing so MongoDB / frontend never see raw entities.
 */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/gi, (_, hex) => {
      try { return String.fromCodePoint(parseInt(hex, 16)); } catch { return _; }
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      try { return String.fromCodePoint(parseInt(dec, 10)); } catch { return _; }
    })
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'");
}

function getHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function resolveUrl(base: string, target: string): string {
  try {
    return new URL(target, base).href;
  } catch {
    return target;
  }
}

/**
 * Two-pass regex that finds a meta tag value regardless of attribute order.
 * Covers both `property` (OG) and `name` (Twitter/standard) variants.
 */
function extractMeta(html: string, prop: string): string | null {
  let m = html.match(
    new RegExp(
      `<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']*?)["']`,
      "i"
    )
  );
  if (m) return m[1].trim() || null;
  m = html.match(
    new RegExp(
      `<meta[^>]+content=["']([^"']*?)["'][^>]+(?:property|name)=["']${prop}["']`,
      "i"
    )
  );
  return m ? (m[1].trim() || null) : null;
}

function parseOg(html: string, pageUrl: string): OgData {
  // Stop at </head> — everything after is body content we don't need.
  const headEnd = html.indexOf("</head>");
  const head = headEnd !== -1 ? html.slice(0, headEnd) : html;

  const rawTitle =
    extractMeta(head, "og:title") ??
    extractMeta(head, "twitter:title") ??
    head.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim() ??
    null;
  const title = rawTitle ? decodeHtmlEntities(rawTitle) : null;

  const rawDescription =
    extractMeta(head, "og:description") ??
    extractMeta(head, "twitter:description") ??
    extractMeta(head, "description") ??
    null;
  const description = rawDescription ? decodeHtmlEntities(rawDescription) : null;

  let image =
    extractMeta(head, "og:image") ??
    extractMeta(head, "twitter:image") ??
    extractMeta(head, "twitter:image:src") ??
    null;

  if (image) image = resolveUrl(pageUrl, image);

  const hostname = getHostname(pageUrl);
  const favicon = hostname
    ? `https://www.google.com/s2/favicons?domain=${hostname}&sz=64`
    : null;

  return { title, description, image, favicon };
}

/**
 * Stream the HTTP response and stop the moment we see </head> or hit
 * MAX_HEAD_BYTES. This is the key fix for large SPA pages (Instagram,
 * Reddit, etc.) that would otherwise time-out or exceed content limits
 * when buffered in full.
 */
async function fetchHtmlHead(url: string): Promise<string | null> {
  const response = await axios.get<IncomingMessage>(url, {
    responseType: "stream",
    timeout: TIMEOUT_MS,
    validateStatus: () => true, // never throw based on status code
    maxRedirects: 5,
    headers: BROWSER_HEADERS,
  });

  // Only bother with HTML responses.
  const ct = (response.headers["content-type"] as string | undefined) ?? "";
  if (!ct.includes("text/html") && !ct.includes("application/xhtml")) {
    response.data.destroy();
    return null;
  }

  return new Promise<string | null>((resolve) => {
    const stream = response.data as IncomingMessage;
    const chunks: Buffer[] = [];
    let bytesRead = 0;
    let settled = false;

    function finish(result: string | null) {
      if (settled) return;
      settled = true;
      try { stream.destroy(); } catch { /* already gone */ }
      resolve(result);
    }

    stream.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      bytesRead += chunk.length;
      // Check if we've seen the end of <head> so we can stop early.
      const partial = Buffer.concat(chunks).toString("utf8");
      if (partial.includes("</head>") || bytesRead >= MAX_HEAD_BYTES) {
        finish(partial);
      }
    });

    stream.on("end", () => {
      finish(Buffer.concat(chunks).toString("utf8") || null);
    });

    stream.on("error", () => {
      // Return whatever we managed to collect before the error.
      const partial = Buffer.concat(chunks).toString("utf8");
      finish(partial || null);
    });

    // Hard deadline — if the server is just slow to start sending we give up.
    setTimeout(() => {
      const partial = Buffer.concat(chunks).toString("utf8");
      finish(partial || null);
    }, TIMEOUT_MS);
  });
}

async function fetchGitHubRepo(
  owner: string,
  repo: string
): Promise<OgData | null> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (GITHUB_TOKEN) headers["Authorization"] = `Bearer ${GITHUB_TOKEN}`;

  const { data, status } = await axios.get(
    `https://api.github.com/repos/${owner}/${repo}`,
    { timeout: TIMEOUT_MS, headers, validateStatus: () => true }
  );
  if (status !== 200) return null;

  return {
    title: data.full_name ?? null,
    description: data.description ?? null,
    image: data.owner?.avatar_url ?? null,
    favicon: "https://www.google.com/s2/favicons?domain=github.com&sz=64",
  };
}

/**
 * Instagram oEmbed — Graph API v18.
 *
 * Requires INSTAGRAM_APP_ID + INSTAGRAM_CLIENT_TOKEN in env (free Facebook App,
 * no user OAuth, no App Review needed for oEmbed). Returns the post thumbnail,
 * author username, and caption. Falls back gracefully to null if unconfigured
 * or the post is private/deleted — frontend shows the branded gradient card.
 */
async function fetchInstagramOembed(url: string): Promise<OgData | null> {
  if (!INSTAGRAM_APP_ID || !INSTAGRAM_CLIENT_TOKEN) return null;

  const accessToken = `${INSTAGRAM_APP_ID}|${INSTAGRAM_CLIENT_TOKEN}`;
  const endpoint =
    `https://graph.facebook.com/v18.0/instagram_oembed` +
    `?url=${encodeURIComponent(url)}&access_token=${accessToken}&fields=thumbnail_url,author_name,title`;

  const { data, status } = await axios.get(endpoint, {
    timeout: TIMEOUT_MS,
    validateStatus: () => true,
  });

  if (status !== 200 || !data.thumbnail_url) return null;

  return {
    title: data.author_name ? `@${decodeHtmlEntities(data.author_name)}` : "Instagram",
    description: data.title ? decodeHtmlEntities(data.title) : null,
    // Store the post URL, not the CDN URL. CDN URLs contain an expiry token
    // (`oe=` hex timestamp) and become 403 within hours. The frontend proxy
    // endpoint re-fetches a fresh CDN URL on demand.
    image: url,
    favicon: "https://www.google.com/s2/favicons?domain=instagram.com&sz=64",
  };
}

export async function fetchLinkPreview(url: string): Promise<OgData | null> {
  try {
    // GitHub: structured API beats scraping.
    const githubMatch = url.match(GITHUB_REPO_RE);
    if (githubMatch) {
      const result = await fetchGitHubRepo(githubMatch[1], githubMatch[2]);
      if (result) return result;
      // Fall through to OG scraping if API fails (rate-limited / private repo).
    }

    // Instagram: their pages serve a JS-only shell — OG tags are injected
    // at runtime and invisible to server-side fetches. oEmbed is the only
    // reliable path; if unconfigured we return null and the frontend shows
    // the branded gradient card instead.
    if (INSTAGRAM_POST_RE.test(url)) {
      return await fetchInstagramOembed(url);
    }

    // Everything else: stream the response <head> and parse OG meta tags.
    const html = await fetchHtmlHead(url);
    if (!html) return null;

    const og = parseOg(html, url);

    // Don't store empty ogData — frontend falls back to MinimalFallback.
    if (!og.title && !og.image) return null;

    return og;
  } catch {
    return null;
  }
}
