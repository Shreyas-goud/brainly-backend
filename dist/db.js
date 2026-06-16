"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ShareLinkModel = exports.BrainModel = exports.LinkModel = exports.CollectionModel = exports.ContentModel = exports.TagModel = exports.UserModel = exports.CONTENT_SOURCE_TYPES = void 0;
exports.connectDB = connectDB;
const mongoose_1 = __importStar(require("mongoose"));
const config_1 = require("./config");
/**
 * Single, awaited connection. The previous version called mongoose.connect()
 * both here (at import time, unguarded) and again in index.ts, which produced
 * an unhandled promise rejection on a bad URI before the real handler ran.
 */
function connectDB() {
    return __awaiter(this, void 0, void 0, function* () {
        yield mongoose_1.default.connect(config_1.MONGODB_URI);
    });
}
const UserSchema = new mongoose_1.Schema({
    email: {
        type: String,
        unique: true,
        required: true,
        lowercase: true,
        trim: true,
    },
    password: { type: String, required: true },
}, { timestamps: true });
const TagSchema = new mongoose_1.Schema({
    name: { type: String, required: true, lowercase: true, trim: true },
    userId: {
        type: mongoose_1.default.Types.ObjectId,
        ref: "User",
        required: true,
    },
}, { timestamps: true });
// One tag name per user. Prevents the upsert race that could create duplicates
// and turns tag lookups into an index hit instead of a collection scan.
TagSchema.index({ userId: 1, name: 1 }, { unique: true });
// A playlist / series / feed — a first-class grouping of content. Source-agnostic
// so the same shape later serves Spotify playlists, article series, RSS, etc.
const CollectionSchema = new mongoose_1.Schema({
    userId: { type: mongoose_1.default.Types.ObjectId, ref: "User", required: true },
    source: { type: String, required: true }, // "youtube"
    externalId: { type: String, required: true }, // e.g. the YouTube playlistId
    title: { type: String, required: true },
    url: { type: String, required: true },
    thumbnail: { type: String, default: null },
    channelTitle: { type: String, default: null },
    itemCount: { type: Number, default: 0 },
    tags: [{ type: mongoose_1.default.Types.ObjectId, ref: "tag" }],
}, { timestamps: true });
// One collection per (user, source, externalId) — re-importing updates in place.
CollectionSchema.index({ userId: 1, source: 1, externalId: 1 }, { unique: true });
CollectionSchema.index({ userId: 1, _id: -1 });
const OgDataSchema = new mongoose_1.Schema({
    title: { type: String, default: null },
    description: { type: String, default: null },
    image: { type: String, default: null },
    favicon: { type: String, default: null },
    fetchedAt: { type: Date, default: null },
}, { _id: false });
exports.CONTENT_SOURCE_TYPES = [
    "youtube",
    "instagram",
    "x",
    "reddit",
    "github",
    "email",
    "chat",
    "other",
];
const ContentSchema = new mongoose_1.Schema({
    title: { type: String, required: true },
    link: { type: String, required: true },
    tags: [{ type: mongoose_1.default.Types.ObjectId, ref: "tag" }],
    // Legacy field kept for backward-compat with existing records.
    type: { type: String, default: null },
    // First-class source identifier — drives channel filtering and card rendering.
    sourceType: {
        type: String,
        enum: [...exports.CONTENT_SOURCE_TYPES],
        default: null,
    },
    userId: {
        type: mongoose_1.default.Types.ObjectId,
        ref: "User",
        required: true,
    },
    // When set, this item belongs to a collection and is hidden from the
    // top-level feed (it shows inside the collection instead).
    collectionId: {
        type: mongoose_1.default.Types.ObjectId,
        ref: "Collections",
        default: null,
    },
    thumbnail: { type: String, default: null },
    channelTitle: { type: String, default: null },
    position: { type: Number, default: 0 },
    // Cached Open Graph / API preview metadata. Populated asynchronously after save.
    ogData: { type: OgDataSchema, default: null },
}, { timestamps: true });
// A user can't save the same link twice. Also backs keyset pagination ordering.
ContentSchema.index({ userId: 1, link: 1 }, { unique: true });
ContentSchema.index({ userId: 1, _id: -1 });
ContentSchema.index({ collectionId: 1, position: 1 });
// Backs the /content/counts aggregation used by the channel sidebar.
ContentSchema.index({ userId: 1, sourceType: 1 });
const LinkSchema = new mongoose_1.Schema({
    hash: { type: String, required: true, unique: true },
    userId: {
        type: mongoose_1.default.Types.ObjectId,
        ref: "User",
        required: true,
        unique: true,
    },
}, { timestamps: true });
// A channel-specific "brain" — the user's curated knowledge for one channel.
// Its existence (not content count) is what makes a channel "Configured".
const BrainSchema = new mongoose_1.Schema({
    userId: { type: mongoose_1.default.Types.ObjectId, ref: "User", required: true },
    channel: { type: String, enum: [...exports.CONTENT_SOURCE_TYPES], required: true },
    name: { type: String, default: "" },
    description: { type: String, default: "" },
}, { timestamps: true });
// One brain per (user, channel).
BrainSchema.index({ userId: 1, channel: 1 }, { unique: true });
// A channel-scoped share link. Unlike LinkSchema (one-per-user, shares
// everything), several can coexist — one per unique channel selection — and
// each is revocable. `channelKey` (sorted channels joined) makes generation
// idempotent: the same selection always maps to the same link.
const ShareLinkSchema = new mongoose_1.Schema({
    userId: { type: mongoose_1.default.Types.ObjectId, ref: "User", required: true },
    hash: { type: String, required: true, unique: true },
    channels: [{ type: String, enum: [...exports.CONTENT_SOURCE_TYPES] }],
    channelKey: { type: String, required: true },
}, { timestamps: true });
// Idempotency: regenerating for the same channel set returns the same hash.
ShareLinkSchema.index({ userId: 1, channelKey: 1 }, { unique: true });
exports.UserModel = (0, mongoose_1.model)("User", UserSchema);
exports.TagModel = (0, mongoose_1.model)("tag", TagSchema);
exports.ContentModel = (0, mongoose_1.model)("Contents", ContentSchema);
exports.CollectionModel = (0, mongoose_1.model)("Collections", CollectionSchema);
exports.LinkModel = (0, mongoose_1.model)("Links", LinkSchema);
exports.BrainModel = (0, mongoose_1.model)("Brains", BrainSchema);
exports.ShareLinkModel = (0, mongoose_1.model)("BrainShares", ShareLinkSchema);
