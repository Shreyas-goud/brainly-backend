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
const express_1 = __importDefault(require("express"));
const axios_1 = __importDefault(require("axios"));
const mongoose_1 = __importDefault(require("mongoose"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const cors_1 = __importDefault(require("cors"));
const db_1 = require("./db");
const config_1 = require("./config");
const middleware_1 = require("./middleware");
const utils_1 = require("./utils");
const validation_1 = require("./validation");
const youtube_1 = require("./services/youtube");
const twitter_1 = require("./services/twitter");
const linkPreview_1 = require("./services/linkPreview");
const security_1 = require("./security");
const app = (0, express_1.default)();
app.set("trust proxy", 1);
const MAX_PLAYLIST_ITEMS = 500;
// Legacy share links carry no channel scope → treat them as "everything".
const ALL_CHANNELS = [...db_1.CONTENT_SOURCE_TYPES];
// Small in-memory cache for tweet lookups (tweets are effectively immutable).
const TWEET_TTL_MS = 60 * 60 * 1000;
const tweetCache = new Map();
function isZodError(error) {
    return (typeof error === "object" &&
        error !== null &&
        "name" in error &&
        error.name === "ZodError");
}
function isDuplicateKeyError(error) {
    return (typeof error === "object" &&
        error !== null &&
        error.code === 11000);
}
/** Resolve tag names to ids, creating tags on demand. Shared by content + playlist. */
function resolveTagIds(userId, tagNames) {
    return __awaiter(this, void 0, void 0, function* () {
        if (!(tagNames === null || tagNames === void 0 ? void 0 : tagNames.length))
            return [];
        const tagIds = [];
        for (const raw of tagNames) {
            const name = raw.trim().toLowerCase();
            if (!name)
                continue;
            const tag = yield db_1.TagModel.findOneAndUpdate({ name, userId }, { $setOnInsert: { name, userId } }, { upsert: true, new: true });
            tagIds.push(tag._id);
        }
        return tagIds;
    });
}
// --- Global middleware ---------------------------------------------------
app.use(security_1.securityHeaders);
app.use((0, cors_1.default)({
    origin(origin, callback) {
        // Allow same-origin / non-browser callers (no Origin header).
        if (!origin || config_1.CORS_ORIGINS.includes(origin)) {
            return callback(null, true);
        }
        callback(new Error(`Origin ${origin} not allowed by CORS`));
    },
}));
app.use(express_1.default.json({ limit: "100kb" }));
const authLimiter = (0, security_1.createRateLimiter)({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: "Too many attempts. Please wait a few minutes and try again.",
});
const writeLimiter = (0, security_1.createRateLimiter)({ windowMs: 60 * 1000, max: 60 });
// --- Health --------------------------------------------------------------
app.get("/healthz", (_req, res) => {
    const dbReady = mongoose_1.default.connection.readyState === 1;
    res.status(dbReady ? 200 : 503).json({
        status: dbReady ? "ok" : "degraded",
        db: dbReady ? "connected" : "disconnected",
    });
});
// --- Tweets (public, used by dashboard + share view) ---------------------
app.get("/api/v1/tweet/:id", (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { id } = req.params;
    if (!/^\d{5,25}$/.test(id)) {
        return res.status(400).json({ message: "Invalid tweet id" });
    }
    try {
        const cached = tweetCache.get(id);
        if (cached && Date.now() - cached.at < TWEET_TTL_MS) {
            if (!cached.data) {
                return res.status(404).json({ message: "Tweet not found" });
            }
            return res.json(cached.data);
        }
        const tweet = yield (0, twitter_1.fetchTweet)(id);
        tweetCache.set(id, { data: tweet, at: Date.now() });
        if (!tweet) {
            return res.status(404).json({ message: "Tweet not found" });
        }
        res.json(tweet);
    }
    catch (err) {
        console.error("[tweet:get]", err);
        res.status(502).json({ message: "Failed to fetch tweet" });
    }
}));
// --- Reddit post proxy -------------------------------------------------------
//
// reddit.com/.json endpoints do not set Access-Control-Allow-Origin, so
// browser fetch is CORS-blocked. We proxy server-side and return only the
// fields the RedditCard component needs.
const REDDIT_POST_RE_PROXY = /reddit\.com\/r\/[^/]+\/comments\/([A-Za-z0-9]+)/i;
app.get("/api/v1/reddit", middleware_1.userMiddleware, writeLimiter, (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s;
    const { url } = req.query;
    if (!url || !REDDIT_POST_RE_PROXY.test(url)) {
        return res.status(400).json({ message: "Invalid Reddit post URL" });
    }
    try {
        const jsonUrl = url.replace(/\?.*$/, "").replace(/\/$/, "") + ".json";
        const { data, status } = yield axios_1.default.get(jsonUrl, {
            timeout: 8000,
            validateStatus: () => true,
            params: { raw_json: 1, limit: 1 },
            headers: {
                "User-Agent": "Brainlyy/1.0 (personal knowledge app)",
                Accept: "application/json",
            },
        });
        if (status !== 200 || !Array.isArray(data)) {
            return res.status(502).json({ message: "Failed to fetch Reddit post" });
        }
        const post = (_d = (_c = (_b = (_a = data[0]) === null || _a === void 0 ? void 0 : _a.data) === null || _b === void 0 ? void 0 : _b.children) === null || _c === void 0 ? void 0 : _c[0]) === null || _d === void 0 ? void 0 : _d.data;
        if (!post)
            return res.status(404).json({ message: "Post not found" });
        // Prefer the higher-res preview image over the small thumbnail.
        const previewImage = (_k = (_j = (_h = (_g = (_f = (_e = post.preview) === null || _e === void 0 ? void 0 : _e.images) === null || _f === void 0 ? void 0 : _f[0]) === null || _g === void 0 ? void 0 : _g.source) === null || _h === void 0 ? void 0 : _h.url) === null || _j === void 0 ? void 0 : _j.replace(/&amp;/g, "&")) !== null && _k !== void 0 ? _k : null;
        const thumbnail = typeof post.thumbnail === "string" &&
            post.thumbnail.startsWith("http")
            ? post.thumbnail
            : null;
        res.json({
            title: (_l = post.title) !== null && _l !== void 0 ? _l : null,
            subreddit: (_m = post.subreddit) !== null && _m !== void 0 ? _m : null,
            author: (_o = post.author) !== null && _o !== void 0 ? _o : null,
            score: (_p = post.score) !== null && _p !== void 0 ? _p : 0,
            num_comments: (_q = post.num_comments) !== null && _q !== void 0 ? _q : 0,
            flair: (_r = post.link_flair_text) !== null && _r !== void 0 ? _r : null,
            created_utc: (_s = post.created_utc) !== null && _s !== void 0 ? _s : null,
            image: previewImage !== null && previewImage !== void 0 ? previewImage : thumbnail,
            selftext: post.selftext
                ? post.selftext.slice(0, 300)
                : null,
            is_self: Boolean(post.is_self),
        });
    }
    catch (err) {
        console.error("[reddit:get]", err);
        res.status(502).json({ message: "Failed to fetch Reddit post" });
    }
}));
// --- Instagram image proxy --------------------------------------------------
//
// Problem: Instagram oEmbed returns CDN URLs like:
//   https://scontent-lax3-1.cdninstagram.com/v/t51...?oe=XXXXXXXX
// The `oe=` param is a hex-encoded Unix expiry timestamp. These URLs expire
// in hours. Storing them in MongoDB means they're dead by the next page load.
//
// Solution: store the INSTAGRAM POST URL (never expires) in ogData.image.
// This endpoint re-calls oEmbed on-demand to get a fresh CDN URL, then
// proxies the image server-side (bypasses browser Referer restrictions too).
// Results are cached in memory for 30 minutes so repeated views are instant.
const INSTAGRAM_POST_RE_PROXY = /instagram\.com\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/i;
const instagramThumbCache = new Map();
const INSTAGRAM_THUMB_TTL_MS = 30 * 60 * 1000;
const CDN_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    Referer: "https://www.instagram.com/",
    Origin: "https://www.instagram.com",
};
app.get("/api/v1/proxy-instagram", writeLimiter, (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    var _a;
    const postUrl = typeof req.query.postUrl === "string" ? req.query.postUrl : "";
    if (!postUrl || !INSTAGRAM_POST_RE_PROXY.test(postUrl)) {
        return res.status(400).end();
    }
    if (!config_1.INSTAGRAM_APP_ID || !config_1.INSTAGRAM_CLIENT_TOKEN) {
        return res.status(503).end();
    }
    // Resolve: cache hit → use existing CDN URL, else re-fetch oEmbed.
    let cdnUrl = null;
    const cached = instagramThumbCache.get(postUrl);
    if (cached && Date.now() - cached.at < INSTAGRAM_THUMB_TTL_MS) {
        cdnUrl = cached.cdnUrl;
    }
    else {
        try {
            const accessToken = `${config_1.INSTAGRAM_APP_ID}|${config_1.INSTAGRAM_CLIENT_TOKEN}`;
            const { data, status } = yield axios_1.default.get(`https://graph.facebook.com/v18.0/instagram_oembed` +
                `?url=${encodeURIComponent(postUrl)}&access_token=${accessToken}&fields=thumbnail_url`, { timeout: 8000, validateStatus: () => true });
            if (status === 200 && data.thumbnail_url) {
                cdnUrl = data.thumbnail_url;
                instagramThumbCache.set(postUrl, { cdnUrl, at: Date.now() });
            }
        }
        catch ( /* fall through → 404 */_b) { /* fall through → 404 */ }
    }
    if (!cdnUrl)
        return res.status(404).end();
    // Proxy the (now-fresh) CDN URL server-side — bypasses browser Referer block.
    try {
        const upstream = yield axios_1.default.get(cdnUrl, {
            responseType: "stream",
            timeout: 8000,
            validateStatus: () => true,
            headers: CDN_HEADERS,
        });
        if (upstream.status !== 200)
            return res.status(upstream.status).end();
        const ct = (_a = upstream.headers["content-type"]) !== null && _a !== void 0 ? _a : "image/jpeg";
        res.setHeader("Content-Type", ct);
        // Cache in browser for 30 min — matches our in-memory TTL.
        res.setHeader("Cache-Control", "public, max-age=1800");
        res.setHeader("Access-Control-Allow-Origin", "*");
        upstream.data.pipe(res);
    }
    catch (_c) {
        res.status(502).end();
    }
}));
// --- Link preview (lazy backfill for old content) ------------------------
app.get("/api/v1/link-preview", middleware_1.userMiddleware, writeLimiter, (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { url } = req.query;
    if (!url) {
        return res.status(400).json({ message: "url query param is required" });
    }
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch (_a) {
        return res.status(400).json({ message: "Invalid URL" });
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return res.status(400).json({ message: "Only http/https URLs are supported" });
    }
    try {
        const ogData = yield (0, linkPreview_1.fetchLinkPreview)(url);
        if (!ogData) {
            return res.status(502).json({ message: "Could not fetch preview" });
        }
        // Backfill the stored content so future page loads get it for free.
        db_1.ContentModel.updateOne({ userId: req.userId, link: url, ogData: null }, { $set: { ogData: Object.assign(Object.assign({}, ogData), { fetchedAt: new Date() }) } }).catch(() => { });
        res.json(ogData);
    }
    catch (err) {
        console.error("[link-preview]", err);
        res.status(502).json({ message: "Could not fetch preview" });
    }
}));
// --- Auth ----------------------------------------------------------------
app.post("/api/v1/signup", authLimiter, (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const parsed = validation_1.signupSchema.parse(req.body);
        const existingUser = yield db_1.UserModel.findOne({ email: parsed.email });
        if (existingUser) {
            return res.status(409).json({ message: "User already exists" });
        }
        const hashedPassword = yield bcryptjs_1.default.hash(parsed.password, 10);
        yield db_1.UserModel.create({
            email: parsed.email,
            password: hashedPassword,
        });
        res.status(201).json({ message: "User signed up successfully" });
    }
    catch (err) {
        if (isZodError(err)) {
            return res.status(400).json({ errors: err.issues });
        }
        if (isDuplicateKeyError(err)) {
            return res.status(409).json({ message: "User already exists" });
        }
        console.error("[signup]", err);
        res.status(500).json({ message: "Internal server error" });
    }
}));
app.post("/api/v1/signin", authLimiter, (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const parsed = validation_1.signinSchema.parse(req.body);
        const user = yield db_1.UserModel.findOne({ email: parsed.email });
        if (!user) {
            return res.status(401).json({ message: "Invalid credentials" });
        }
        const isPasswordValid = yield bcryptjs_1.default.compare(parsed.password, user.password);
        if (!isPasswordValid) {
            return res.status(401).json({ message: "Invalid credentials" });
        }
        const token = jsonwebtoken_1.default.sign({ id: user._id }, config_1.JWT_SECRET, { expiresIn: "7d" });
        res.json({ token });
    }
    catch (err) {
        if (isZodError(err)) {
            return res.status(400).json({ errors: err.issues });
        }
        console.error("[signin]", err);
        res.status(500).json({ message: "Internal server error" });
    }
}));
// --- Brains --------------------------------------------------------------
// Idempotently ensure a channel brain exists. Called whenever content lands in
// a channel so "has content" can never disagree with "is configured".
function ensureBrain(userId, channel) {
    return __awaiter(this, void 0, void 0, function* () {
        yield db_1.BrainModel.updateOne({ userId, channel }, { $setOnInsert: { userId, channel } }, { upsert: true });
    });
}
// --- Content -------------------------------------------------------------
app.post("/api/v1/content", middleware_1.userMiddleware, writeLimiter, (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const parsed = validation_1.contentSchema.parse(req.body);
        const tagIds = yield resolveTagIds(req.userId, parsed.tags);
        const saved = yield db_1.ContentModel.create({
            title: parsed.title,
            link: parsed.link,
            sourceType: parsed.sourceType,
            userId: req.userId,
            tags: tagIds,
        });
        res.status(201).json({ message: "Content added" });
        // Configuring a channel = it now has a brain. Fire-and-forget.
        ensureBrain(req.userId, parsed.sourceType).catch(() => { });
        // Fire-and-forget OG preview fetch. Never delays the response.
        // YouTube/X have their own rich renderers so skip them here.
        if (parsed.sourceType !== "youtube" && parsed.sourceType !== "x") {
            (0, linkPreview_1.fetchLinkPreview)(parsed.link)
                .then((ogData) => {
                if (ogData) {
                    return db_1.ContentModel.updateOne({ _id: saved._id }, { $set: { ogData: Object.assign(Object.assign({}, ogData), { fetchedAt: new Date() }) } });
                }
            })
                .catch(() => { });
        }
    }
    catch (err) {
        if (isZodError(err)) {
            return res.status(400).json({ errors: err.issues });
        }
        if (isDuplicateKeyError(err)) {
            return res
                .status(409)
                .json({ message: "This link is already in your brain." });
        }
        console.error("[content:create]", err);
        res.status(500).json({ message: "Internal server error" });
    }
}));
app.post("/api/v1/content/playlist", middleware_1.userMiddleware, writeLimiter, (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    var _a, _b, _c, _d, _e, _f;
    try {
        const parsed = validation_1.playlistSchema.parse(req.body);
        const playlistIdMatch = parsed.playlistUrl.match(/[&?]list=([^&]+)/);
        if (!playlistIdMatch) {
            return res
                .status(400)
                .json({ message: "Invalid YouTube playlist URL" });
        }
        const playlistId = playlistIdMatch[1];
        const [meta, items] = yield Promise.all([
            (0, youtube_1.getPlaylistMeta)(playlistId),
            (0, youtube_1.getPlaylistItems)(playlistId, MAX_PLAYLIST_ITEMS),
        ]);
        if (items.length === 0) {
            return res
                .status(404)
                .json({ message: "No videos found for that playlist." });
        }
        const tagIds = yield resolveTagIds(req.userId, parsed.tags);
        const title = (_b = (_a = parsed.title) !== null && _a !== void 0 ? _a : meta === null || meta === void 0 ? void 0 : meta.title) !== null && _b !== void 0 ? _b : "Untitled playlist";
        const canonicalUrl = `https://www.youtube.com/playlist?list=${playlistId}`;
        // Upsert the collection (re-importing the same playlist updates it).
        const collection = yield db_1.CollectionModel.findOneAndUpdate({ userId: req.userId, source: "youtube", externalId: playlistId }, {
            $set: {
                title,
                url: canonicalUrl,
                thumbnail: (_d = (_c = meta === null || meta === void 0 ? void 0 : meta.thumbnail) !== null && _c !== void 0 ? _c : items[0].thumbnail) !== null && _d !== void 0 ? _d : null,
                channelTitle: (_f = (_e = meta === null || meta === void 0 ? void 0 : meta.channelTitle) !== null && _e !== void 0 ? _e : items[0].channelTitle) !== null && _f !== void 0 ? _f : null,
                itemCount: items.length,
                tags: tagIds,
            },
        }, { upsert: true, new: true });
        // Upsert each video. Existing loose items with the same link are *adopted*
        // into the collection rather than duplicated.
        const seen = new Set();
        const ops = [];
        for (const item of items) {
            const link = `https://www.youtube.com/watch?v=${item.videoId}`;
            if (seen.has(link))
                continue;
            seen.add(link);
            ops.push({
                updateOne: {
                    filter: { userId: req.userId, link },
                    update: {
                        $set: {
                            title: item.title,
                            sourceType: "youtube",
                            collectionId: collection._id,
                            thumbnail: item.thumbnail,
                            channelTitle: item.channelTitle,
                            position: item.position,
                        },
                        $setOnInsert: { tags: [] },
                    },
                    upsert: true,
                },
            });
        }
        if (ops.length)
            yield db_1.ContentModel.bulkWrite(ops, { ordered: false });
        // Playlists always belong to the YouTube channel — ensure its brain.
        ensureBrain(req.userId, "youtube").catch(() => { });
        res.status(201).json({
            message: `Imported "${title}" with ${ops.length} video${ops.length === 1 ? "" : "s"}.`,
            collectionId: collection._id,
        });
    }
    catch (err) {
        if (isZodError(err)) {
            return res.status(400).json({ errors: err.issues });
        }
        if (err instanceof Error && err.message === "YOUTUBE_API_KEY_MISSING") {
            return res
                .status(503)
                .json({ message: "Playlist import is not configured on this server." });
        }
        console.error("[content:playlist]", err);
        res.status(500).json({ message: "Internal server error" });
    }
}));
app.get("/api/v1/content/counts", middleware_1.userMiddleware, (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const agg = yield db_1.ContentModel.aggregate([
            {
                $match: {
                    userId: new mongoose_1.default.Types.ObjectId(req.userId),
                    collectionId: null,
                },
            },
            { $group: { _id: "$sourceType", count: { $sum: 1 } } },
        ]);
        const counts = {};
        for (const { _id, count } of agg) {
            if (_id)
                counts[_id] = count;
        }
        res.json({ counts });
    }
    catch (err) {
        console.error("[content:counts]", err);
        res.status(500).json({ message: "Internal server error" });
    }
}));
app.get("/api/v1/content", middleware_1.userMiddleware, (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const { limit, cursor } = validation_1.contentQuerySchema.parse(req.query);
        // Only top-level items — anything inside a collection shows within it.
        const filter = {
            userId: req.userId,
            collectionId: null,
        };
        if (cursor) {
            // Keyset pagination: items strictly "older" than the cursor.
            filter._id = { $lt: new mongoose_1.default.Types.ObjectId(cursor) };
        }
        // Fetch one extra to determine whether another page exists.
        const items = yield db_1.ContentModel.find(filter)
            .sort({ _id: -1 })
            .limit(limit + 1)
            .populate("tags");
        const hasMore = items.length > limit;
        const content = hasMore ? items.slice(0, limit) : items;
        const nextCursor = hasMore ? String(content[content.length - 1]._id) : null;
        res.json({ content, nextCursor, hasMore });
    }
    catch (err) {
        if (isZodError(err)) {
            return res.status(400).json({ errors: err.issues });
        }
        console.error("[content:list]", err);
        res.status(500).json({ message: "Internal server error" });
    }
}));
app.delete("/api/v1/content", middleware_1.userMiddleware, (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    var _a;
    try {
        const { contentId, contentIds } = ((_a = req.body) !== null && _a !== void 0 ? _a : {});
        // Accept a single id (legacy) or an array (bulk delete).
        const requested = Array.isArray(contentIds)
            ? contentIds
            : contentId
                ? [contentId]
                : [];
        if (requested.length === 0) {
            return res
                .status(400)
                .json({ message: "A contentId or contentIds array is required" });
        }
        if (requested.length > 500) {
            return res
                .status(400)
                .json({ message: "Too many items in one request (max 500)" });
        }
        const ids = requested.filter((id) => mongoose_1.default.Types.ObjectId.isValid(id));
        if (ids.length === 0) {
            return res.status(400).json({ message: "No valid content ids provided" });
        }
        const result = yield db_1.ContentModel.deleteMany({
            _id: { $in: ids },
            userId: req.userId,
        });
        if (result.deletedCount === 0) {
            return res.status(404).json({ message: "Content not found" });
        }
        res.json({ message: "Content deleted", deletedCount: result.deletedCount });
    }
    catch (err) {
        console.error("[content:delete]", err);
        res.status(500).json({ message: "Internal server error" });
    }
}));
// --- Collections (playlists) --------------------------------------------
app.get("/api/v1/collections", middleware_1.userMiddleware, (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const collections = yield db_1.CollectionModel.find({ userId: req.userId })
            .sort({ _id: -1 })
            .populate("tags");
        res.json({ collections });
    }
    catch (err) {
        console.error("[collections:list]", err);
        res.status(500).json({ message: "Internal server error" });
    }
}));
app.get("/api/v1/collections/:id", middleware_1.userMiddleware, (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const { id } = req.params;
        if (!mongoose_1.default.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid collection id" });
        }
        const collection = yield db_1.CollectionModel.findOne({
            _id: id,
            userId: req.userId,
        }).populate("tags");
        if (!collection) {
            return res.status(404).json({ message: "Collection not found" });
        }
        const items = yield db_1.ContentModel.find({
            userId: req.userId,
            collectionId: id,
        }).sort({ position: 1, _id: 1 });
        res.json({ collection, items });
    }
    catch (err) {
        console.error("[collections:get]", err);
        res.status(500).json({ message: "Internal server error" });
    }
}));
app.delete("/api/v1/collections/:id", middleware_1.userMiddleware, (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const { id } = req.params;
        if (!mongoose_1.default.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid collection id" });
        }
        const result = yield db_1.CollectionModel.deleteOne({
            _id: id,
            userId: req.userId,
        });
        if (result.deletedCount === 0) {
            return res.status(404).json({ message: "Collection not found" });
        }
        // Cascade: remove the playlist's videos too.
        yield db_1.ContentModel.deleteMany({ userId: req.userId, collectionId: id });
        res.json({ message: "Collection deleted" });
    }
    catch (err) {
        console.error("[collections:delete]", err);
        res.status(500).json({ message: "Internal server error" });
    }
}));
// --- Brain management ----------------------------------------------------
// List the user's channel brains, backfilling one for every channel that
// already has content so pre-existing data shows up as Configured.
app.get("/api/v1/brains", middleware_1.userMiddleware, (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const channelsWithContent = (yield db_1.ContentModel.distinct("sourceType", {
            userId: req.userId,
            sourceType: { $ne: null },
        }));
        if (channelsWithContent.length) {
            yield db_1.BrainModel.bulkWrite(channelsWithContent.map((channel) => ({
                updateOne: {
                    filter: { userId: req.userId, channel },
                    update: { $setOnInsert: { userId: req.userId, channel } },
                    upsert: true,
                },
            })), { ordered: false });
        }
        const brains = yield db_1.BrainModel.find({ userId: req.userId }).sort({
            createdAt: 1,
        });
        res.json({ brains });
    }
    catch (err) {
        console.error("[brains:list]", err);
        res.status(500).json({ message: "Internal server error" });
    }
}));
// Create (or return the existing) brain for a channel.
app.post("/api/v1/brains", middleware_1.userMiddleware, (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const parsed = validation_1.brainCreateSchema.parse(req.body);
        const brain = yield db_1.BrainModel.findOneAndUpdate({ userId: req.userId, channel: parsed.channel }, Object.assign({ $setOnInsert: { userId: req.userId, channel: parsed.channel } }, (parsed.name !== undefined || parsed.description !== undefined
            ? {
                $set: Object.assign(Object.assign({}, (parsed.name !== undefined ? { name: parsed.name } : {})), (parsed.description !== undefined
                    ? { description: parsed.description }
                    : {})),
            }
            : {})), { upsert: true, new: true });
        res.status(201).json({ brain });
    }
    catch (err) {
        if (isZodError(err))
            return res.status(400).json({ errors: err.issues });
        console.error("[brains:create]", err);
        res.status(500).json({ message: "Internal server error" });
    }
}));
// Edit a brain's name / description.
app.patch("/api/v1/brains/:channel", middleware_1.userMiddleware, (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const parsed = validation_1.brainUpdateSchema.parse(req.body);
        const brain = yield db_1.BrainModel.findOneAndUpdate({ userId: req.userId, channel: req.params.channel }, { $set: parsed }, { new: true });
        if (!brain)
            return res.status(404).json({ message: "Brain not found" });
        res.json({ brain });
    }
    catch (err) {
        if (isZodError(err))
            return res.status(400).json({ errors: err.issues });
        console.error("[brains:update]", err);
        res.status(500).json({ message: "Internal server error" });
    }
}));
// Delete a brain *and* the channel's content (deleting a brain wipes its
// knowledge — so a channel can never be "Not Configured" yet still hold items).
app.delete("/api/v1/brains/:channel", middleware_1.userMiddleware, (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const channel = req.params.channel;
        yield db_1.BrainModel.deleteOne({ userId: req.userId, channel });
        if (channel === "youtube") {
            const collections = yield db_1.CollectionModel.find({
                userId: req.userId,
                source: "youtube",
            }).select("_id");
            const ids = collections.map((c) => c._id);
            if (ids.length) {
                yield db_1.CollectionModel.deleteMany({ _id: { $in: ids } });
                yield db_1.ContentModel.deleteMany({
                    userId: req.userId,
                    collectionId: { $in: ids },
                });
            }
        }
        yield db_1.ContentModel.deleteMany({ userId: req.userId, sourceType: channel });
        res.json({ message: "Brain deleted" });
    }
    catch (err) {
        console.error("[brains:delete]", err);
        res.status(500).json({ message: "Internal server error" });
    }
}));
// --- Sharing -------------------------------------------------------------
// Build the share content filter for a channel set, honoring legacy records
// that predate `sourceType` (old `type: "twitter"|"youtube"`).
function shareContentFilter(userId, channels) {
    const or = [{ sourceType: { $in: channels } }];
    const legacyTypes = [];
    if (channels.includes("youtube"))
        legacyTypes.push("youtube");
    if (channels.includes("x"))
        legacyTypes.push("twitter");
    if (legacyTypes.length) {
        or.push({ sourceType: null, type: { $in: legacyTypes } });
    }
    return { userId, collectionId: null, $or: or };
}
// Create (or return the existing) share link for a channel selection. Idempotent
// on the selection, so the same channels always yield the same stable link.
app.post("/api/v1/brain/share", middleware_1.userMiddleware, (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const parsed = validation_1.shareSchema.parse(req.body);
        const channels = Array.from(new Set(parsed.channels)).sort();
        const channelKey = channels.join(",");
        let link = yield db_1.ShareLinkModel.findOne({
            userId: req.userId,
            channelKey,
        });
        if (!link) {
            link = yield db_1.ShareLinkModel.create({
                userId: req.userId,
                hash: (0, utils_1.random)(10),
                channels,
                channelKey,
            });
        }
        res.json({ hash: link.hash, channels: link.channels });
    }
    catch (err) {
        if (isZodError(err))
            return res.status(400).json({ errors: err.issues });
        console.error("[brain:share]", err);
        res.status(500).json({ message: "Internal server error" });
    }
}));
// List the user's active share links (for the manage / revoke UI).
app.get("/api/v1/brain/shares", middleware_1.userMiddleware, (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const links = yield db_1.ShareLinkModel.find({ userId: req.userId }).sort({
            createdAt: -1,
        });
        res.json({
            shares: links.map((l) => ({
                hash: l.hash,
                channels: l.channels,
                createdAt: l.createdAt,
            })),
        });
    }
    catch (err) {
        console.error("[brain:shares]", err);
        res.status(500).json({ message: "Internal server error" });
    }
}));
// Revoke one share link.
app.delete("/api/v1/brain/share/:hash", middleware_1.userMiddleware, (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        yield db_1.ShareLinkModel.deleteOne({
            userId: req.userId,
            hash: req.params.hash,
        });
        res.json({ message: "Share link revoked" });
    }
    catch (err) {
        console.error("[brain:share:delete]", err);
        res.status(500).json({ message: "Internal server error" });
    }
}));
// Public read of a shared brain — scoped to the link's selected channels.
// Falls back to the legacy LinkModel (shares everything) for old links.
app.get("/api/v1/brain/:shareLink", (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const hash = req.params.shareLink;
        const share = yield db_1.ShareLinkModel.findOne({ hash });
        const legacy = share ? null : yield db_1.LinkModel.findOne({ hash });
        if (!share && !legacy) {
            return res.status(404).json({ message: "Invalid share link" });
        }
        const userId = (share !== null && share !== void 0 ? share : legacy).userId;
        // Legacy links have no channel scope → expose everything.
        const channels = share ? share.channels : ALL_CHANNELS;
        const includesYouTube = channels.includes("youtube");
        const [content, collections, collectionItems, user] = yield Promise.all([
            db_1.ContentModel.find(shareContentFilter(userId, channels))
                .sort({ _id: -1 })
                .populate("tags"),
            includesYouTube
                ? db_1.CollectionModel.find({ userId }).sort({ _id: -1 }).populate("tags")
                : Promise.resolve([]),
            includesYouTube
                ? db_1.ContentModel.find({ userId, collectionId: { $ne: null } }).sort({
                    position: 1,
                    _id: 1,
                })
                : Promise.resolve([]),
            db_1.UserModel.findById(userId),
        ]);
        if (!user) {
            return res.status(404).json({ message: "User not found" });
        }
        res.json({
            email: user.email,
            channels,
            content,
            collections,
            collectionItems,
        });
    }
    catch (err) {
        console.error("[brain:get]", err);
        res.status(500).json({ message: "Internal server error" });
    }
}));
// --- Boot ----------------------------------------------------------------
function start() {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            yield (0, db_1.connectDB)();
            console.log("MongoDB connected");
            app.listen(config_1.PORT, () => {
                console.log(`Server listening on port ${config_1.PORT} (${config_1.NODE_ENV})`);
            });
        }
        catch (err) {
            console.error("Failed to start server:", err);
            process.exit(1);
        }
    });
}
start();
