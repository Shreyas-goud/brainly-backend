import mongoose, { model, Schema } from "mongoose";
import { MONGODB_URI } from "./config";

// Fail fast with a clear error instead of hanging, and keep sockets healthy.
// Once the initial connection succeeds, the driver auto-reconnects on transient
// drops on its own.
const CONNECT_OPTIONS: mongoose.ConnectOptions = {
  serverSelectionTimeoutMS: 10_000,
  socketTimeoutMS: 45_000,
};

let listenersAttached = false;

function attachConnectionListeners(): void {
  if (listenersAttached) return;
  listenersAttached = true;

  const c = mongoose.connection;
  // Critical: without an 'error' listener a transient driver error (e.g. a
  // failed SRV re-poll on Atlas) surfaces as an *unhandled* exception and
  // crashes the whole process. With one, it's logged and the driver recovers.
  c.on("error", (err) =>
    console.error("[mongo] connection error:", err?.message ?? err)
  );
  c.on("disconnected", () =>
    console.warn("[mongo] disconnected — driver will attempt to reconnect")
  );
  c.on("reconnected", () => console.log("[mongo] reconnected"));
}

/**
 * Connect with bounded retries + exponential backoff. A cold Atlas cluster or a
 * brief DNS blip on boot should not kill the server — we retry a few times
 * before giving up. The previous version called mongoose.connect() once and
 * propagated the first failure straight to process.exit.
 */
export async function connectDB(maxAttempts = 5): Promise<void> {
  attachConnectionListeners();

  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      await mongoose.connect(MONGODB_URI, CONNECT_OPTIONS);
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt >= maxAttempts) {
        throw new Error(
          `MongoDB connection failed after ${attempt} attempts: ${msg}`
        );
      }
      const delayMs = Math.min(1000 * 2 ** (attempt - 1), 15_000); // 1s,2s,4s,8s…
      console.warn(
        `[mongo] connect attempt ${attempt} failed (${msg}); retrying in ${delayMs}ms`
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

const UserSchema = new Schema(
  {
    email: {
      type: String,
      unique: true,
      required: true,
      lowercase: true,
      trim: true,
    },
    password: { type: String, required: true },
  },
  { timestamps: true }
);

const TagSchema = new Schema(
  {
    name: { type: String, required: true, lowercase: true, trim: true },
    userId: {
      type: mongoose.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true }
);

// One tag name per user. Prevents the upsert race that could create duplicates
// and turns tag lookups into an index hit instead of a collection scan.
TagSchema.index({ userId: 1, name: 1 }, { unique: true });

// A playlist / series / feed — a first-class grouping of content. Source-agnostic
// so the same shape later serves Spotify playlists, article series, RSS, etc.
const CollectionSchema = new Schema(
  {
    userId: { type: mongoose.Types.ObjectId, ref: "User", required: true },
    source: { type: String, required: true }, // "youtube"
    externalId: { type: String, required: true }, // e.g. the YouTube playlistId
    title: { type: String, required: true },
    url: { type: String, required: true },
    thumbnail: { type: String, default: null },
    channelTitle: { type: String, default: null },
    itemCount: { type: Number, default: 0 },
    tags: [{ type: mongoose.Types.ObjectId, ref: "tag" }],
  },
  { timestamps: true }
);

// One collection per (user, source, externalId) — re-importing updates in place.
CollectionSchema.index(
  { userId: 1, source: 1, externalId: 1 },
  { unique: true }
);
CollectionSchema.index({ userId: 1, _id: -1 });

const OgDataSchema = new Schema(
  {
    title: { type: String, default: null },
    description: { type: String, default: null },
    image: { type: String, default: null },
    favicon: { type: String, default: null },
    fetchedAt: { type: Date, default: null },
  },
  { _id: false }
);

export const CONTENT_SOURCE_TYPES = [
  "youtube",
  "instagram",
  "x",
  "reddit",
  "github",
  "email",
  "chat",
  "other",
] as const;

export type ContentSourceType = (typeof CONTENT_SOURCE_TYPES)[number];

const ContentSchema = new Schema(
  {
    title: { type: String, required: true },
    link: { type: String, required: true },
    tags: [{ type: mongoose.Types.ObjectId, ref: "tag" }],
    // Legacy field kept for backward-compat with existing records.
    type: { type: String, default: null },
    // First-class source identifier — drives channel filtering and card rendering.
    sourceType: {
      type: String,
      enum: [...CONTENT_SOURCE_TYPES],
      default: null,
    },
    userId: {
      type: mongoose.Types.ObjectId,
      ref: "User",
      required: true,
    },
    // When set, this item belongs to a collection and is hidden from the
    // top-level feed (it shows inside the collection instead).
    collectionId: {
      type: mongoose.Types.ObjectId,
      ref: "Collections",
      default: null,
    },
    thumbnail: { type: String, default: null },
    channelTitle: { type: String, default: null },
    position: { type: Number, default: 0 },
    // Cached Open Graph / API preview metadata. Populated asynchronously after save.
    ogData: { type: OgDataSchema, default: null },
  },
  { timestamps: true }
);

// A user can't save the same link twice. Also backs keyset pagination ordering.
ContentSchema.index({ userId: 1, link: 1 }, { unique: true });
ContentSchema.index({ userId: 1, _id: -1 });
ContentSchema.index({ collectionId: 1, position: 1 });
// Backs the /content/counts aggregation used by the channel sidebar.
ContentSchema.index({ userId: 1, sourceType: 1 });

const LinkSchema = new Schema(
  {
    hash: { type: String, required: true, unique: true },
    userId: {
      type: mongoose.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },
  },
  { timestamps: true }
);

// A channel-specific "brain" — the user's curated knowledge for one channel.
// Its existence (not content count) is what makes a channel "Configured".
const BrainSchema = new Schema(
  {
    userId: { type: mongoose.Types.ObjectId, ref: "User", required: true },
    channel: { type: String, enum: [...CONTENT_SOURCE_TYPES], required: true },
    name: { type: String, default: "" },
    description: { type: String, default: "" },
  },
  { timestamps: true }
);

// One brain per (user, channel).
BrainSchema.index({ userId: 1, channel: 1 }, { unique: true });

// A channel-scoped share link. Unlike LinkSchema (one-per-user, shares
// everything), several can coexist — one per unique channel selection — and
// each is revocable. `channelKey` (sorted channels joined) makes generation
// idempotent: the same selection always maps to the same link.
const ShareLinkSchema = new Schema(
  {
    userId: { type: mongoose.Types.ObjectId, ref: "User", required: true },
    hash: { type: String, required: true, unique: true },
    channels: [{ type: String, enum: [...CONTENT_SOURCE_TYPES] }],
    channelKey: { type: String, required: true },
  },
  { timestamps: true }
);

// Idempotency: regenerating for the same channel set returns the same hash.
ShareLinkSchema.index({ userId: 1, channelKey: 1 }, { unique: true });

export const UserModel = model("User", UserSchema);
export const TagModel = model("tag", TagSchema);
export const ContentModel = model("Contents", ContentSchema);
export const CollectionModel = model("Collections", CollectionSchema);
export const LinkModel = model("Links", LinkSchema);
export const BrainModel = model("Brains", BrainSchema);
export const ShareLinkModel = model("BrainShares", ShareLinkSchema);
