import express from "express";
import axios from "axios";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import cors from "cors";
import {
  UserModel,
  ContentModel,
  CollectionModel,
  LinkModel,
  BrainModel,
  ShareLinkModel,
  TagModel,
  CONTENT_SOURCE_TYPES,
  connectDB,
} from "./db";
import {
  JWT_SECRET,
  PORT,
  CORS_ORIGINS,
  NODE_ENV,
  INSTAGRAM_APP_ID,
  INSTAGRAM_CLIENT_TOKEN,
} from "./config";
import { userMiddleware } from "./middleware";
import { random } from "./utils";
import {
  signupSchema,
  signinSchema,
  contentSchema,
  playlistSchema,
  contentQuerySchema,
  brainCreateSchema,
  brainUpdateSchema,
  shareSchema,
} from "./validation";
import { getPlaylistItems, getPlaylistMeta } from "./services/youtube";
import { fetchTweet, type NormalizedTweet } from "./services/twitter";
import { fetchLinkPreview } from "./services/linkPreview";
import { safeAgents } from "./services/safeFetch";
import { IncomingMessage } from "http";
import { securityHeaders, createRateLimiter } from "./security";

const app = express();
app.set("trust proxy", 1);

const MAX_PLAYLIST_ITEMS = 500;

// Legacy share links carry no channel scope → treat them as "everything".
const ALL_CHANNELS: string[] = [...CONTENT_SOURCE_TYPES];

// Small in-memory cache for tweet lookups (tweets are effectively immutable).
const TWEET_TTL_MS = 60 * 60 * 1000;
const tweetCache = new Map<
  string,
  { data: NormalizedTweet | null; at: number }
>();

function isZodError(error: unknown): error is { name: string; issues: unknown } {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: string }).name === "ZodError"
  );
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: number }).code === 11000
  );
}

/** Resolve tag names to ids, creating tags on demand. Shared by content + playlist. */
async function resolveTagIds(
  userId: string,
  tagNames?: string[]
): Promise<mongoose.Types.ObjectId[]> {
  if (!tagNames?.length) return [];
  const tagIds: mongoose.Types.ObjectId[] = [];
  for (const raw of tagNames) {
    const name = raw.trim().toLowerCase();
    if (!name) continue;
    const tag = await TagModel.findOneAndUpdate(
      { name, userId },
      { $setOnInsert: { name, userId } },
      { upsert: true, new: true }
    );
    tagIds.push(tag._id);
  }
  return tagIds;
}

// --- Global middleware ---------------------------------------------------

app.use(securityHeaders);
app.use(
  cors({
    origin(origin, callback) {
      // Allow same-origin / non-browser callers (no Origin header).
      if (!origin || CORS_ORIGINS.includes(origin)) {
        return callback(null, true);
      }
      callback(new Error(`Origin ${origin} not allowed by CORS`));
    },
  })
);
app.use(express.json({ limit: "100kb" }));

const authLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: "Too many attempts. Please wait a few minutes and try again.",
});
const writeLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 60 });

// --- Health --------------------------------------------------------------

app.get("/healthz", (_req, res) => {
  const dbReady = mongoose.connection.readyState === 1;
  res.status(dbReady ? 200 : 503).json({
    status: dbReady ? "ok" : "degraded",
    db: dbReady ? "connected" : "disconnected",
  });
});

// --- Tweets (public, used by dashboard + share view) ---------------------

app.get("/api/v1/tweet/:id", async (req, res) => {
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

    const tweet = await fetchTweet(id);
    tweetCache.set(id, { data: tweet, at: Date.now() });
    if (!tweet) {
      return res.status(404).json({ message: "Tweet not found" });
    }
    res.json(tweet);
  } catch (err) {
    console.error("[tweet:get]", err);
    res.status(502).json({ message: "Failed to fetch tweet" });
  }
});

// --- Reddit post proxy -------------------------------------------------------
//
// reddit.com/.json endpoints do not set Access-Control-Allow-Origin, so
// browser fetch is CORS-blocked. We proxy server-side and return only the
// fields the RedditCard component needs.

const REDDIT_POST_RE_PROXY =
  /reddit\.com\/r\/[^/]+\/comments\/([A-Za-z0-9]+)/i;

app.get("/api/v1/reddit", userMiddleware, writeLimiter, async (req, res) => {
  const { url } = req.query as { url?: string };
  if (!url || !REDDIT_POST_RE_PROXY.test(url)) {
    return res.status(400).json({ message: "Invalid Reddit post URL" });
  }

  try {
    const jsonUrl =
      url.replace(/\?.*$/, "").replace(/\/$/, "") + ".json";
    const { data, status } = await axios.get(jsonUrl, {
      timeout: 8000,
      validateStatus: () => true,
      params: { raw_json: 1, limit: 1 },
      headers: {
        "User-Agent": "Brainlyy/1.0 (personal knowledge app)",
        Accept: "application/json",
      },
      // The reddit regex matches `reddit.com/...` anywhere in the string, so a
      // crafted URL could embed an internal host. The guard blocks that.
      ...safeAgents,
    });

    if (status !== 200 || !Array.isArray(data)) {
      return res.status(502).json({ message: "Failed to fetch Reddit post" });
    }

    const post = data[0]?.data?.children?.[0]?.data;
    if (!post) return res.status(404).json({ message: "Post not found" });

    // Prefer the higher-res preview image over the small thumbnail.
    const previewImage =
      (post.preview?.images?.[0]?.source?.url as string | undefined)?.replace(
        /&amp;/g,
        "&"
      ) ?? null;
    const thumbnail =
      typeof post.thumbnail === "string" &&
      post.thumbnail.startsWith("http")
        ? post.thumbnail
        : null;

    res.json({
      title: post.title ?? null,
      subreddit: post.subreddit ?? null,
      author: post.author ?? null,
      score: post.score ?? 0,
      num_comments: post.num_comments ?? 0,
      flair: post.link_flair_text ?? null,
      created_utc: post.created_utc ?? null,
      image: previewImage ?? thumbnail,
      selftext: post.selftext
        ? (post.selftext as string).slice(0, 300)
        : null,
      is_self: Boolean(post.is_self),
    });
  } catch (err) {
    console.error("[reddit:get]", err);
    res.status(502).json({ message: "Failed to fetch Reddit post" });
  }
});

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

const INSTAGRAM_POST_RE_PROXY =
  /instagram\.com\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/i;

const instagramThumbCache = new Map<
  string,
  { cdnUrl: string; at: number }
>();
const INSTAGRAM_THUMB_TTL_MS = 30 * 60 * 1000;

const CDN_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  Referer: "https://www.instagram.com/",
  Origin: "https://www.instagram.com",
};

app.get("/api/v1/proxy-instagram", userMiddleware, writeLimiter, async (req, res) => {
  const postUrl =
    typeof req.query.postUrl === "string" ? req.query.postUrl : "";
  if (!postUrl || !INSTAGRAM_POST_RE_PROXY.test(postUrl)) {
    return res.status(400).end();
  }
  if (!INSTAGRAM_APP_ID || !INSTAGRAM_CLIENT_TOKEN) {
    return res.status(503).end();
  }

  // Resolve: cache hit → use existing CDN URL, else re-fetch oEmbed.
  let cdnUrl: string | null = null;
  const cached = instagramThumbCache.get(postUrl);
  if (cached && Date.now() - cached.at < INSTAGRAM_THUMB_TTL_MS) {
    cdnUrl = cached.cdnUrl;
  } else {
    try {
      const accessToken = `${INSTAGRAM_APP_ID}|${INSTAGRAM_CLIENT_TOKEN}`;
      const { data, status } = await axios.get(
        `https://graph.facebook.com/v18.0/instagram_oembed` +
          `?url=${encodeURIComponent(postUrl)}&access_token=${accessToken}&fields=thumbnail_url`,
        { timeout: 8000, validateStatus: () => true, ...safeAgents }
      );
      if (status === 200 && data.thumbnail_url) {
        cdnUrl = data.thumbnail_url as string;
        instagramThumbCache.set(postUrl, { cdnUrl, at: Date.now() });
      }
    } catch { /* fall through → 404 */ }
  }

  if (!cdnUrl) return res.status(404).end();

  // Proxy the (now-fresh) CDN URL server-side — bypasses browser Referer block.
  try {
    const upstream = await axios.get<IncomingMessage>(cdnUrl, {
      responseType: "stream",
      timeout: 8000,
      validateStatus: () => true,
      headers: CDN_HEADERS,
      ...safeAgents,
    });
    if (upstream.status !== 200) return res.status(upstream.status).end();

    const ct =
      (upstream.headers["content-type"] as string | undefined) ?? "image/jpeg";
    res.setHeader("Content-Type", ct);
    // Cache in browser for 30 min — matches our in-memory TTL.
    res.setHeader("Cache-Control", "public, max-age=1800");
    res.setHeader("Access-Control-Allow-Origin", "*");
    (upstream.data as IncomingMessage).pipe(res);
  } catch {
    res.status(502).end();
  }
});

// --- Link preview (lazy backfill for old content) ------------------------

app.get("/api/v1/link-preview", userMiddleware, writeLimiter, async (req, res) => {
  const { url } = req.query as { url?: string };
  if (!url) {
    return res.status(400).json({ message: "url query param is required" });
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return res.status(400).json({ message: "Invalid URL" });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return res.status(400).json({ message: "Only http/https URLs are supported" });
  }
  try {
    const ogData = await fetchLinkPreview(url);
    if (!ogData) {
      return res.status(502).json({ message: "Could not fetch preview" });
    }
    // Backfill the stored content so future page loads get it for free.
    ContentModel.updateOne(
      { userId: req.userId, link: url, ogData: null },
      { $set: { ogData: { ...ogData, fetchedAt: new Date() } } }
    ).catch(() => {});

    res.json(ogData);
  } catch (err) {
    console.error("[link-preview]", err);
    res.status(502).json({ message: "Could not fetch preview" });
  }
});

// --- Auth ----------------------------------------------------------------

app.post("/api/v1/signup", authLimiter, async (req, res) => {
  try {
    const parsed = signupSchema.parse(req.body);
    const existingUser = await UserModel.findOne({ email: parsed.email });
    if (existingUser) {
      return res.status(409).json({ message: "User already exists" });
    }
    const hashedPassword = await bcrypt.hash(parsed.password, 10);
    await UserModel.create({
      email: parsed.email,
      password: hashedPassword,
    });
    res.status(201).json({ message: "User signed up successfully" });
  } catch (err) {
    if (isZodError(err)) {
      return res.status(400).json({ errors: err.issues });
    }
    if (isDuplicateKeyError(err)) {
      return res.status(409).json({ message: "User already exists" });
    }
    console.error("[signup]", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

app.post("/api/v1/signin", authLimiter, async (req, res) => {
  try {
    const parsed = signinSchema.parse(req.body);
    const user = await UserModel.findOne({ email: parsed.email });
    if (!user) {
      return res.status(401).json({ message: "Invalid credentials" });
    }
    const isPasswordValid = await bcrypt.compare(
      parsed.password,
      user.password
    );
    if (!isPasswordValid) {
      return res.status(401).json({ message: "Invalid credentials" });
    }
    const token = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: "7d" });
    res.json({ token });
  } catch (err) {
    if (isZodError(err)) {
      return res.status(400).json({ errors: err.issues });
    }
    console.error("[signin]", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

// --- Brains --------------------------------------------------------------

// Idempotently ensure a channel brain exists. Called whenever content lands in
// a channel so "has content" can never disagree with "is configured".
async function ensureBrain(userId: string, channel: string): Promise<void> {
  await BrainModel.updateOne(
    { userId, channel },
    { $setOnInsert: { userId, channel } },
    { upsert: true }
  );
}

// --- Content -------------------------------------------------------------

app.post("/api/v1/content", userMiddleware, writeLimiter, async (req, res) => {
  try {
    const parsed = contentSchema.parse(req.body);
    const tagIds = await resolveTagIds(req.userId!, parsed.tags);

    const saved = await ContentModel.create({
      title: parsed.title,
      link: parsed.link,
      sourceType: parsed.sourceType,
      userId: req.userId,
      tags: tagIds,
    });

    res.status(201).json({ message: "Content added" });

    // Configuring a channel = it now has a brain. Fire-and-forget.
    ensureBrain(req.userId!, parsed.sourceType).catch(() => {});

    // Fire-and-forget OG preview fetch. Never delays the response.
    // YouTube/X have their own rich renderers so skip them here.
    if (parsed.sourceType !== "youtube" && parsed.sourceType !== "x") {
      fetchLinkPreview(parsed.link)
        .then((ogData) => {
          if (ogData) {
            return ContentModel.updateOne(
              { _id: saved._id },
              { $set: { ogData: { ...ogData, fetchedAt: new Date() } } }
            );
          }
        })
        .catch(() => {});
    }
  } catch (err) {
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
});

app.post(
  "/api/v1/content/playlist",
  userMiddleware,
  writeLimiter,
  async (req, res) => {
    try {
      const parsed = playlistSchema.parse(req.body);

      const playlistIdMatch = parsed.playlistUrl.match(/[&?]list=([^&]+)/);
      if (!playlistIdMatch) {
        return res
          .status(400)
          .json({ message: "Invalid YouTube playlist URL" });
      }
      const playlistId = playlistIdMatch[1];

      const [meta, items] = await Promise.all([
        getPlaylistMeta(playlistId),
        getPlaylistItems(playlistId, MAX_PLAYLIST_ITEMS),
      ]);
      if (items.length === 0) {
        return res
          .status(404)
          .json({ message: "No videos found for that playlist." });
      }

      const tagIds = await resolveTagIds(req.userId!, parsed.tags);
      const title = parsed.title ?? meta?.title ?? "Untitled playlist";
      const canonicalUrl = `https://www.youtube.com/playlist?list=${playlistId}`;

      // Upsert the collection (re-importing the same playlist updates it).
      const collection = await CollectionModel.findOneAndUpdate(
        { userId: req.userId, source: "youtube", externalId: playlistId },
        {
          $set: {
            title,
            url: canonicalUrl,
            thumbnail: meta?.thumbnail ?? items[0].thumbnail ?? null,
            channelTitle: meta?.channelTitle ?? items[0].channelTitle ?? null,
            itemCount: items.length,
            tags: tagIds,
          },
        },
        { upsert: true, new: true }
      );

      // Upsert each video. Existing loose items with the same link are *adopted*
      // into the collection rather than duplicated.
      const seen = new Set<string>();
      const ops = [];
      for (const item of items) {
        const link = `https://www.youtube.com/watch?v=${item.videoId}`;
        if (seen.has(link)) continue;
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
      if (ops.length) await ContentModel.bulkWrite(ops, { ordered: false });

      // Playlists always belong to the YouTube channel — ensure its brain.
      ensureBrain(req.userId!, "youtube").catch(() => {});

      res.status(201).json({
        message: `Imported "${title}" with ${ops.length} video${
          ops.length === 1 ? "" : "s"
        }.`,
        collectionId: collection._id,
      });
    } catch (err) {
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
  }
);

app.get("/api/v1/content/counts", userMiddleware, async (req, res) => {
  try {
    const agg = await ContentModel.aggregate([
      {
        $match: {
          userId: new mongoose.Types.ObjectId(req.userId!),
          collectionId: null,
        },
      },
      { $group: { _id: "$sourceType", count: { $sum: 1 } } },
    ]);
    const counts: Record<string, number> = {};
    for (const { _id, count } of agg) {
      if (_id) counts[_id] = count;
    }
    res.json({ counts });
  } catch (err) {
    console.error("[content:counts]", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

app.get("/api/v1/content", userMiddleware, async (req, res) => {
  try {
    const { limit, cursor } = contentQuerySchema.parse(req.query);

    // Only top-level items — anything inside a collection shows within it.
    const filter: Record<string, unknown> = {
      userId: req.userId,
      collectionId: null,
    };
    if (cursor) {
      // Keyset pagination: items strictly "older" than the cursor.
      filter._id = { $lt: new mongoose.Types.ObjectId(cursor) };
    }

    // Fetch one extra to determine whether another page exists.
    const items = await ContentModel.find(filter)
      .sort({ _id: -1 })
      .limit(limit + 1)
      .populate("tags");

    const hasMore = items.length > limit;
    const content = hasMore ? items.slice(0, limit) : items;
    const nextCursor = hasMore ? String(content[content.length - 1]._id) : null;

    res.json({ content, nextCursor, hasMore });
  } catch (err) {
    if (isZodError(err)) {
      return res.status(400).json({ errors: err.issues });
    }
    console.error("[content:list]", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

app.delete("/api/v1/content", userMiddleware, async (req, res) => {
  try {
    const { contentId, contentIds } = (req.body ?? {}) as {
      contentId?: string;
      contentIds?: string[];
    };
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
    const ids = requested.filter((id) =>
      mongoose.Types.ObjectId.isValid(id)
    );
    if (ids.length === 0) {
      return res.status(400).json({ message: "No valid content ids provided" });
    }
    const result = await ContentModel.deleteMany({
      _id: { $in: ids },
      userId: req.userId,
    });
    if (result.deletedCount === 0) {
      return res.status(404).json({ message: "Content not found" });
    }
    res.json({ message: "Content deleted", deletedCount: result.deletedCount });
  } catch (err) {
    console.error("[content:delete]", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

// --- Collections (playlists) --------------------------------------------

app.get("/api/v1/collections", userMiddleware, async (req, res) => {
  try {
    const collections = await CollectionModel.find({ userId: req.userId })
      .sort({ _id: -1 })
      .populate("tags");
    res.json({ collections });
  } catch (err) {
    console.error("[collections:list]", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

app.get("/api/v1/collections/:id", userMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid collection id" });
    }
    const collection = await CollectionModel.findOne({
      _id: id,
      userId: req.userId,
    }).populate("tags");
    if (!collection) {
      return res.status(404).json({ message: "Collection not found" });
    }
    const items = await ContentModel.find({
      userId: req.userId,
      collectionId: id,
    }).sort({ position: 1, _id: 1 });
    res.json({ collection, items });
  } catch (err) {
    console.error("[collections:get]", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

app.delete("/api/v1/collections/:id", userMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid collection id" });
    }
    const result = await CollectionModel.deleteOne({
      _id: id,
      userId: req.userId,
    });
    if (result.deletedCount === 0) {
      return res.status(404).json({ message: "Collection not found" });
    }
    // Cascade: remove the playlist's videos too.
    await ContentModel.deleteMany({ userId: req.userId, collectionId: id });
    res.json({ message: "Collection deleted" });
  } catch (err) {
    console.error("[collections:delete]", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

// --- Brain management ----------------------------------------------------

// List the user's channel brains, backfilling one for every channel that
// already has content so pre-existing data shows up as Configured.
app.get("/api/v1/brains", userMiddleware, async (req, res) => {
  try {
    const channelsWithContent = (await ContentModel.distinct("sourceType", {
      userId: req.userId,
      sourceType: { $ne: null },
    })) as string[];
    if (channelsWithContent.length) {
      await BrainModel.bulkWrite(
        channelsWithContent.map((channel) => ({
          updateOne: {
            filter: { userId: req.userId, channel },
            update: { $setOnInsert: { userId: req.userId, channel } },
            upsert: true,
          },
        })),
        { ordered: false }
      );
    }
    const brains = await BrainModel.find({ userId: req.userId }).sort({
      createdAt: 1,
    });
    res.json({ brains });
  } catch (err) {
    console.error("[brains:list]", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Create (or return the existing) brain for a channel.
app.post("/api/v1/brains", userMiddleware, async (req, res) => {
  try {
    const parsed = brainCreateSchema.parse(req.body);
    const brain = await BrainModel.findOneAndUpdate(
      { userId: req.userId, channel: parsed.channel },
      {
        $setOnInsert: { userId: req.userId, channel: parsed.channel },
        ...(parsed.name !== undefined || parsed.description !== undefined
          ? {
              $set: {
                ...(parsed.name !== undefined ? { name: parsed.name } : {}),
                ...(parsed.description !== undefined
                  ? { description: parsed.description }
                  : {}),
              },
            }
          : {}),
      },
      { upsert: true, new: true }
    );
    res.status(201).json({ brain });
  } catch (err) {
    if (isZodError(err)) return res.status(400).json({ errors: err.issues });
    console.error("[brains:create]", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Edit a brain's name / description.
app.patch("/api/v1/brains/:channel", userMiddleware, async (req, res) => {
  try {
    const parsed = brainUpdateSchema.parse(req.body);
    const brain = await BrainModel.findOneAndUpdate(
      { userId: req.userId, channel: req.params.channel },
      { $set: parsed },
      { new: true }
    );
    if (!brain) return res.status(404).json({ message: "Brain not found" });
    res.json({ brain });
  } catch (err) {
    if (isZodError(err)) return res.status(400).json({ errors: err.issues });
    console.error("[brains:update]", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Delete a brain *and* the channel's content (deleting a brain wipes its
// knowledge — so a channel can never be "Not Configured" yet still hold items).
app.delete("/api/v1/brains/:channel", userMiddleware, async (req, res) => {
  try {
    const channel = req.params.channel;
    await BrainModel.deleteOne({ userId: req.userId, channel });
    if (channel === "youtube") {
      const collections = await CollectionModel.find({
        userId: req.userId,
        source: "youtube",
      }).select("_id");
      const ids = collections.map((c) => c._id);
      if (ids.length) {
        await CollectionModel.deleteMany({ _id: { $in: ids } });
        await ContentModel.deleteMany({
          userId: req.userId,
          collectionId: { $in: ids },
        });
      }
    }
    await ContentModel.deleteMany({ userId: req.userId, sourceType: channel });
    res.json({ message: "Brain deleted" });
  } catch (err) {
    console.error("[brains:delete]", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

// --- Sharing -------------------------------------------------------------

// Build the share content filter for a channel set, honoring legacy records
// that predate `sourceType` (old `type: "twitter"|"youtube"`).
function shareContentFilter(userId: unknown, channels: string[]) {
  const or: Record<string, unknown>[] = [{ sourceType: { $in: channels } }];
  const legacyTypes: string[] = [];
  if (channels.includes("youtube")) legacyTypes.push("youtube");
  if (channels.includes("x")) legacyTypes.push("twitter");
  if (legacyTypes.length) {
    or.push({ sourceType: null, type: { $in: legacyTypes } });
  }
  return { userId, collectionId: null, $or: or };
}

// Create (or return the existing) share link for a channel selection. Idempotent
// on the selection, so the same channels always yield the same stable link.
app.post("/api/v1/brain/share", userMiddleware, async (req, res) => {
  try {
    const parsed = shareSchema.parse(req.body);
    const channels = Array.from(new Set(parsed.channels)).sort();
    const channelKey = channels.join(",");

    let link = await ShareLinkModel.findOne({
      userId: req.userId,
      channelKey,
    });
    if (!link) {
      link = await ShareLinkModel.create({
        userId: req.userId,
        hash: random(10),
        channels,
        channelKey,
      });
    }
    res.json({ hash: link.hash, channels: link.channels });
  } catch (err) {
    if (isZodError(err)) return res.status(400).json({ errors: err.issues });
    console.error("[brain:share]", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

// List the user's active share links (for the manage / revoke UI).
app.get("/api/v1/brain/shares", userMiddleware, async (req, res) => {
  try {
    const links = await ShareLinkModel.find({ userId: req.userId }).sort({
      createdAt: -1,
    });
    res.json({
      shares: links.map((l) => ({
        hash: l.hash,
        channels: l.channels,
        createdAt: l.createdAt,
      })),
    });
  } catch (err) {
    console.error("[brain:shares]", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Revoke one share link.
app.delete("/api/v1/brain/share/:hash", userMiddleware, async (req, res) => {
  try {
    await ShareLinkModel.deleteOne({
      userId: req.userId,
      hash: req.params.hash,
    });
    res.json({ message: "Share link revoked" });
  } catch (err) {
    console.error("[brain:share:delete]", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Public read of a shared brain — scoped to the link's selected channels.
// Falls back to the legacy LinkModel (shares everything) for old links.
app.get("/api/v1/brain/:shareLink", async (req, res) => {
  try {
    const hash = req.params.shareLink;
    const share = await ShareLinkModel.findOne({ hash });
    const legacy = share ? null : await LinkModel.findOne({ hash });
    if (!share && !legacy) {
      return res.status(404).json({ message: "Invalid share link" });
    }

    const userId = (share ?? legacy)!.userId;
    // Legacy links have no channel scope → expose everything.
    const channels = share ? share.channels : ALL_CHANNELS;
    const includesYouTube = channels.includes("youtube");

    const [content, collections, collectionItems, user] = await Promise.all([
      ContentModel.find(shareContentFilter(userId, channels))
        .sort({ _id: -1 })
        .populate("tags"),
      includesYouTube
        ? CollectionModel.find({ userId }).sort({ _id: -1 }).populate("tags")
        : Promise.resolve([]),
      includesYouTube
        ? ContentModel.find({ userId, collectionId: { $ne: null } }).sort({
            position: 1,
            _id: 1,
          })
        : Promise.resolve([]),
      // Existence check only — never load (or expose) the owner's email/hash
      // on a public, unauthenticated endpoint.
      UserModel.findById(userId).select("_id"),
    ]);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    res.json({
      channels,
      content,
      collections,
      collectionItems,
    });
  } catch (err) {
    console.error("[brain:get]", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

// --- Boot ----------------------------------------------------------------

async function start() {
  try {
    await connectDB();
    console.log("MongoDB connected");
    app.listen(PORT, () => {
      console.log(`Server listening on port ${PORT} (${NODE_ENV})`);
    });
  } catch (err) {
    console.error("Failed to start server:", err);
    process.exit(1);
  }
}

start();
