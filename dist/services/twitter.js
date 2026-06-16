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
exports.fetchTweet = fetchTweet;
const axios_1 = __importDefault(require("axios"));
/**
 * Fetches public tweet data from Twitter/X's syndication endpoint — the same
 * no-auth source that the official embed widget and Vercel's react-tweet use.
 * We proxy it server-side so the browser avoids CORS, and so we can normalize
 * and cache the (unofficial, occasionally-changing) response shape in one place.
 *
 * Crucially, this exposes X Article data (cover image, title, preview) that the
 * iframe embed silently drops.
 */
const SYNDICATION_URL = "https://cdn.syndication.twimg.com/tweet-result";
/** Token the syndication endpoint expects (mirrors react-tweet's derivation). */
function syndicationToken(id) {
    return ((Number(id) / 1e15) * Math.PI)
        .toString(36)
        .replace(/(0+|\.)/g, "");
}
const isArticleUrl = (url) => /\/i\/article\//.test(url !== null && url !== void 0 ? url : "");
/** Decode the handful of HTML entities the syndication API leaves in text. */
function decodeEntities(s) {
    return s
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#0?39;/g, "'")
        .replace(/&#x27;/gi, "'");
}
function fetchTweet(id) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x;
        const token = syndicationToken(id);
        const { data } = yield axios_1.default.get(SYNDICATION_URL, {
            params: { id, token, lang: "en" },
            timeout: 10000,
            // The endpoint requires a browser-like UA, otherwise it 403s.
            headers: { "User-Agent": "Mozilla/5.0" },
        });
        if (!data || !data.user || data.__typename === "TweetTombstone") {
            return null;
        }
        const urlEntities = (_b = (_a = data.entities) === null || _a === void 0 ? void 0 : _a.urls) !== null && _b !== void 0 ? _b : [];
        // Build display text: swap external t.co links for their display form, drop
        // the article's own link (rendered as a card), and remove media links (the
        // tweet's own photo/video, rendered inline) entirely.
        let text = (_c = data.text) !== null && _c !== void 0 ? _c : "";
        for (const u of urlEntities) {
            text = text
                .split(u.url)
                .join(isArticleUrl(u.expanded_url) ? "" : (_d = u.display_url) !== null && _d !== void 0 ? _d : u.url);
        }
        for (const m of (_f = (_e = data.entities) === null || _e === void 0 ? void 0 : _e.media) !== null && _f !== void 0 ? _f : []) {
            text = text.split(m.url).join("");
        }
        text = decodeEntities(text).trim();
        const photos = ((_g = data.mediaDetails) !== null && _g !== void 0 ? _g : [])
            .filter((m) => m.type === "photo")
            .map((m) => {
            var _a, _b, _c, _d;
            return ({
                url: m.media_url_https,
                width: (_b = (_a = m.original_info) === null || _a === void 0 ? void 0 : _a.width) !== null && _b !== void 0 ? _b : 0,
                height: (_d = (_c = m.original_info) === null || _c === void 0 ? void 0 : _c.height) !== null && _d !== void 0 ? _d : 0,
            });
        });
        let video = null;
        const videoMedia = ((_h = data.mediaDetails) !== null && _h !== void 0 ? _h : []).find((m) => m.type === "video" || m.type === "animated_gif");
        if ((_j = videoMedia === null || videoMedia === void 0 ? void 0 : videoMedia.video_info) === null || _j === void 0 ? void 0 : _j.variants) {
            const mp4 = videoMedia.video_info.variants
                .filter((v) => v.content_type === "video/mp4" && v.url)
                .sort((a, b) => { var _a, _b; return ((_a = b.bitrate) !== null && _a !== void 0 ? _a : 0) - ((_b = a.bitrate) !== null && _b !== void 0 ? _b : 0); })[0];
            if (mp4) {
                video = {
                    poster: (_k = videoMedia.media_url_https) !== null && _k !== void 0 ? _k : null,
                    src: mp4.url,
                    isGif: videoMedia.type === "animated_gif",
                };
            }
        }
        let article = null;
        if (data.article) {
            const articleUrl = (_m = (_l = urlEntities.find((u) => isArticleUrl(u.expanded_url))) === null || _l === void 0 ? void 0 : _l.expanded_url) !== null && _m !== void 0 ? _m : (data.article.rest_id
                ? `https://x.com/i/article/${data.article.rest_id}`
                : `https://x.com/i/status/${id}`);
            article = {
                title: (_o = data.article.title) !== null && _o !== void 0 ? _o : "",
                preview: (_p = data.article.preview_text) !== null && _p !== void 0 ? _p : "",
                coverImage: (_s = (_r = (_q = data.article.cover_media) === null || _q === void 0 ? void 0 : _q.media_info) === null || _r === void 0 ? void 0 : _r.original_img_url) !== null && _s !== void 0 ? _s : null,
                url: articleUrl.replace(/^http:/, "https:"),
            };
        }
        return {
            id,
            url: `https://x.com/${data.user.screen_name}/status/${id}`,
            text,
            createdAt: (_t = data.created_at) !== null && _t !== void 0 ? _t : "",
            user: {
                name: data.user.name,
                handle: data.user.screen_name,
                verified: Boolean(data.user.is_blue_verified || data.user.verified),
                avatar: (_v = (_u = data.user.profile_image_url_https) === null || _u === void 0 ? void 0 : _u.replace("_normal", "_200x200")) !== null && _v !== void 0 ? _v : null,
            },
            likes: (_w = data.favorite_count) !== null && _w !== void 0 ? _w : 0,
            replies: (_x = data.conversation_count) !== null && _x !== void 0 ? _x : 0,
            photos,
            video,
            article,
        };
    });
}
