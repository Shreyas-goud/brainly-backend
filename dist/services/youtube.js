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
exports.getPlaylistMeta = getPlaylistMeta;
exports.getPlaylistItems = getPlaylistItems;
const axios_1 = __importDefault(require("axios"));
const config_1 = require("../config");
const PLAYLIST_ITEMS_URL = "https://www.googleapis.com/youtube/v3/playlistItems";
const PLAYLISTS_URL = "https://www.googleapis.com/youtube/v3/playlists";
/** Highest-resolution thumbnail available, in descending preference. */
function pickThumbnail(thumbs) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k;
    return ((_k = (_h = (_f = (_d = (_b = (_a = thumbs === null || thumbs === void 0 ? void 0 : thumbs.maxres) === null || _a === void 0 ? void 0 : _a.url) !== null && _b !== void 0 ? _b : (_c = thumbs === null || thumbs === void 0 ? void 0 : thumbs.standard) === null || _c === void 0 ? void 0 : _c.url) !== null && _d !== void 0 ? _d : (_e = thumbs === null || thumbs === void 0 ? void 0 : thumbs.high) === null || _e === void 0 ? void 0 : _e.url) !== null && _f !== void 0 ? _f : (_g = thumbs === null || thumbs === void 0 ? void 0 : thumbs.medium) === null || _g === void 0 ? void 0 : _g.url) !== null && _h !== void 0 ? _h : (_j = thumbs === null || thumbs === void 0 ? void 0 : thumbs.default) === null || _j === void 0 ? void 0 : _j.url) !== null && _k !== void 0 ? _k : null);
}
function requireKey() {
    if (!config_1.YOUTUBE_API_KEY)
        throw new Error("YOUTUBE_API_KEY_MISSING");
    return config_1.YOUTUBE_API_KEY;
}
/** Playlist-level metadata (title, cover, count) used to build the Collection. */
function getPlaylistMeta(playlistId) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a, _b;
        const key = requireKey();
        const response = yield axios_1.default.get(PLAYLISTS_URL, {
            params: { part: "snippet,contentDetails", id: playlistId, key },
            timeout: 15000,
        });
        const item = (_a = response.data.items) === null || _a === void 0 ? void 0 : _a[0];
        if (!item)
            return null;
        return {
            title: item.snippet.title,
            description: item.snippet.description,
            thumbnail: pickThumbnail(item.snippet.thumbnails),
            itemCount: item.contentDetails.itemCount,
            channelTitle: (_b = item.snippet.channelTitle) !== null && _b !== void 0 ? _b : null,
        };
    });
}
function getPlaylistItems(playlistId_1) {
    return __awaiter(this, arguments, void 0, function* (playlistId, maxItems = 500) {
        var _a, _b;
        const key = requireKey();
        const allItems = [];
        let nextPageToken = undefined;
        do {
            const params = {
                part: "snippet",
                playlistId,
                key,
                maxResults: 50,
                pageToken: nextPageToken,
            };
            const response = yield axios_1.default.get(PLAYLIST_ITEMS_URL, { params, timeout: 15000 });
            const data = response.data;
            for (const { snippet } of data.items) {
                // Private/deleted videos can lack resourceId — skip them defensively.
                const videoId = (_a = snippet.resourceId) === null || _a === void 0 ? void 0 : _a.videoId;
                if (!videoId)
                    continue;
                allItems.push({
                    title: snippet.title,
                    videoId,
                    thumbnail: pickThumbnail(snippet.thumbnails),
                    position: snippet.position,
                    channelTitle: (_b = snippet.videoOwnerChannelTitle) !== null && _b !== void 0 ? _b : null,
                });
                if (allItems.length >= maxItems)
                    return allItems;
            }
            nextPageToken = data.nextPageToken;
        } while (nextPageToken);
        return allItems;
    });
}
