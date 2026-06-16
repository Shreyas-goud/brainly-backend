"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchLinkPreview = fetchLinkPreview;
const axios_1 = __importDefault(require("axios"));
const config_1 = require("../config");
const safeFetch_1 = require("./safeFetch");
const TIMEOUT_MS = 8000;
// Stop streaming once we've seen </head> or hit this byte cap.
// OG meta tags live in <head> which is always under 100KB even on
// the heaviest pages (Instagram is ~5MB total but <head> is ~20KB).
const MAX_HEAD_BYTES = 100000;
// Full Chromium header set — passes most Cloudflare/bot-detection checks.
const BROWSER_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
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
const GITHUB_REPO_RE = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/?#\s]+)/i;
const INSTAGRAM_POST_RE = /instagram\.com\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/i;
/**
 * Decode numeric HTML entities (&#x1f4bb; → 💻, &#128187; → 💻) and named
 * entities (&amp; &lt; etc.). Instagram oEmbed returns captions with entities
 * encoded — we decode before storing so MongoDB / frontend never see raw entities.
 */
function decodeHtmlEntities(text) {
    return text
        .replace(/&#x([0-9a-fA-F]+);/gi, (_, hex) => {
        try {
            return String.fromCodePoint(parseInt(hex, 16));
        }
        catch (_a) {
            return _;
        }
    })
        .replace(/&#(\d+);/g, (_, dec) => {
        try {
            return String.fromCodePoint(parseInt(dec, 10));
        }
        catch (_a) {
            return _;
        }
    })
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;|&#39;/g, "'");
}
function getHostname(url) {
    try {
        return new URL(url).hostname;
    }
    catch (_a) {
        return "";
    }
}
function resolveUrl(base, target) {
    try {
        return new URL(target, base).href;
    }
    catch (_a) {
        return target;
    }
}
/**
 * Two-pass regex that finds a meta tag value regardless of attribute order.
 * Covers both `property` (OG) and `name` (Twitter/standard) variants.
 */
function extractMeta(html, prop) {
    let m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']*?)["']`, "i"));
    if (m)
        return m[1].trim() || null;
    m = html.match(new RegExp(`<meta[^>]+content=["']([^"']*?)["'][^>]+(?:property|name)=["']${prop}["']`, "i"));
    return m ? (m[1].trim() || null) : null;
}
function parseOg(html, pageUrl) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l;
    // Stop at </head> — everything after is body content we don't need.
    const headEnd = html.indexOf("</head>");
    const head = headEnd !== -1 ? html.slice(0, headEnd) : html;
    const rawTitle = (_e = (_b = (_a = extractMeta(head, "og:title")) !== null && _a !== void 0 ? _a : extractMeta(head, "twitter:title")) !== null && _b !== void 0 ? _b : (_d = (_c = head.match(/<title[^>]*>([^<]+)<\/title>/i)) === null || _c === void 0 ? void 0 : _c[1]) === null || _d === void 0 ? void 0 : _d.trim()) !== null && _e !== void 0 ? _e : null;
    const title = rawTitle ? decodeHtmlEntities(rawTitle) : null;
    const rawDescription = (_h = (_g = (_f = extractMeta(head, "og:description")) !== null && _f !== void 0 ? _f : extractMeta(head, "twitter:description")) !== null && _g !== void 0 ? _g : extractMeta(head, "description")) !== null && _h !== void 0 ? _h : null;
    const description = rawDescription ? decodeHtmlEntities(rawDescription) : null;
    let image = (_l = (_k = (_j = extractMeta(head, "og:image")) !== null && _j !== void 0 ? _j : extractMeta(head, "twitter:image")) !== null && _k !== void 0 ? _k : extractMeta(head, "twitter:image:src")) !== null && _l !== void 0 ? _l : null;
    if (image)
        image = resolveUrl(pageUrl, image);
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
function fetchHtmlHead(url) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a;
        const response = yield axios_1.default.get(url, Object.assign({ responseType: "stream", timeout: TIMEOUT_MS, validateStatus: () => true, maxRedirects: 5, headers: BROWSER_HEADERS }, safeFetch_1.safeAgents));
        // Only bother with HTML responses.
        const ct = (_a = response.headers["content-type"]) !== null && _a !== void 0 ? _a : "";
        if (!ct.includes("text/html") && !ct.includes("application/xhtml")) {
            response.data.destroy();
            return null;
        }
        return new Promise((resolve) => {
            const stream = response.data;
            const chunks = [];
            let bytesRead = 0;
            let settled = false;
            function finish(result) {
                if (settled)
                    return;
                settled = true;
                try {
                    stream.destroy();
                }
                catch ( /* already gone */_a) { /* already gone */ }
                resolve(result);
            }
            stream.on("data", (chunk) => {
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
    });
}
function fetchGitHubRepo(owner, repo) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a, _b, _c, _d;
        const headers = {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        };
        if (config_1.GITHUB_TOKEN)
            headers["Authorization"] = `Bearer ${config_1.GITHUB_TOKEN}`;
        const { data, status } = yield axios_1.default.get(`https://api.github.com/repos/${owner}/${repo}`, Object.assign({ timeout: TIMEOUT_MS, headers, validateStatus: () => true }, safeFetch_1.safeAgents));
        if (status !== 200)
            return null;
        return {
            title: (_a = data.full_name) !== null && _a !== void 0 ? _a : null,
            description: (_b = data.description) !== null && _b !== void 0 ? _b : null,
            image: (_d = (_c = data.owner) === null || _c === void 0 ? void 0 : _c.avatar_url) !== null && _d !== void 0 ? _d : null,
            favicon: "https://www.google.com/s2/favicons?domain=github.com&sz=64",
        };
    });
}
/**
 * Instagram oEmbed — Graph API v18.
 *
 * Requires INSTAGRAM_APP_ID + INSTAGRAM_CLIENT_TOKEN in env (free Facebook App,
 * no user OAuth, no App Review needed for oEmbed). Returns the post thumbnail,
 * author username, and caption. Falls back gracefully to null if unconfigured
 * or the post is private/deleted — frontend shows the branded gradient card.
 */
function fetchInstagramOembed(url) {
    return __awaiter(this, void 0, void 0, function* () {
        if (!config_1.INSTAGRAM_APP_ID || !config_1.INSTAGRAM_CLIENT_TOKEN)
            return null;
        const accessToken = `${config_1.INSTAGRAM_APP_ID}|${config_1.INSTAGRAM_CLIENT_TOKEN}`;
        const endpoint = `https://graph.facebook.com/v18.0/instagram_oembed` +
            `?url=${encodeURIComponent(url)}&access_token=${accessToken}&fields=thumbnail_url,author_name,title`;
        const { data, status } = yield axios_1.default.get(endpoint, Object.assign({ timeout: TIMEOUT_MS, validateStatus: () => true }, safeFetch_1.safeAgents));
        if (status !== 200 || !data.thumbnail_url)
            return null;
        return {
            title: data.author_name ? `@${decodeHtmlEntities(data.author_name)}` : "Instagram",
            description: data.title ? decodeHtmlEntities(data.title) : null,
            // Store the post URL, not the CDN URL. CDN URLs contain an expiry token
            // (`oe=` hex timestamp) and become 403 within hours. The frontend proxy
            // endpoint re-fetches a fresh CDN URL on demand.
            image: url,
            favicon: "https://www.google.com/s2/favicons?domain=instagram.com&sz=64",
        };
    });
}
function fetchLinkPreview(url) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            // GitHub: structured API beats scraping.
            const githubMatch = url.match(GITHUB_REPO_RE);
            if (githubMatch) {
                const result = yield fetchGitHubRepo(githubMatch[1], githubMatch[2]);
                if (result)
                    return result;
                // Fall through to OG scraping if API fails (rate-limited / private repo).
            }
            // Instagram: their pages serve a JS-only shell — OG tags are injected
            // at runtime and invisible to server-side fetches. oEmbed is the only
            // reliable path; if unconfigured we return null and the frontend shows
            // the branded gradient card instead.
            if (INSTAGRAM_POST_RE.test(url)) {
                return yield fetchInstagramOembed(url);
            }
            // Everything else: stream the response <head> and parse OG meta tags.
            const html = yield fetchHtmlHead(url);
            if (!html)
                return null;
            const og = parseOg(html, url);
            // Don't store empty ogData — frontend falls back to MinimalFallback.
            if (!og.title && !og.image)
                return null;
            return og;
        }
        catch (_a) {
            return null;
        }
    });
}
