import axios from "axios";
import { YOUTUBE_API_KEY } from "../config";

const PLAYLIST_ITEMS_URL =
  "https://www.googleapis.com/youtube/v3/playlistItems";
const PLAYLISTS_URL = "https://www.googleapis.com/youtube/v3/playlists";

export interface PlaylistItem {
  title: string;
  videoId: string;
  thumbnail: string | null;
  position: number;
  channelTitle: string | null;
}

export interface PlaylistMeta {
  title: string;
  description: string;
  thumbnail: string | null;
  itemCount: number;
  channelTitle: string | null;
}

interface YouTubeThumbnails {
  default?: { url: string };
  medium?: { url: string };
  high?: { url: string };
  standard?: { url: string };
  maxres?: { url: string };
}

interface PlaylistItemSnippet {
  title: string;
  position: number;
  videoOwnerChannelTitle?: string;
  thumbnails?: YouTubeThumbnails;
  resourceId?: { videoId?: string };
}

interface PlaylistItemsResponse {
  items: { snippet: PlaylistItemSnippet }[];
  nextPageToken?: string;
}

interface PlaylistsResponse {
  items: {
    snippet: {
      title: string;
      description: string;
      channelTitle?: string;
      thumbnails?: YouTubeThumbnails;
    };
    contentDetails: { itemCount: number };
  }[];
}

/** Highest-resolution thumbnail available, in descending preference. */
function pickThumbnail(thumbs?: YouTubeThumbnails): string | null {
  return (
    thumbs?.maxres?.url ??
    thumbs?.standard?.url ??
    thumbs?.high?.url ??
    thumbs?.medium?.url ??
    thumbs?.default?.url ??
    null
  );
}

function requireKey(): string {
  if (!YOUTUBE_API_KEY) throw new Error("YOUTUBE_API_KEY_MISSING");
  return YOUTUBE_API_KEY;
}

/** Playlist-level metadata (title, cover, count) used to build the Collection. */
export async function getPlaylistMeta(
  playlistId: string
): Promise<PlaylistMeta | null> {
  const key = requireKey();
  const response = await axios.get<PlaylistsResponse>(PLAYLISTS_URL, {
    params: { part: "snippet,contentDetails", id: playlistId, key },
    timeout: 15_000,
  });
  const item = response.data.items?.[0];
  if (!item) return null;
  return {
    title: item.snippet.title,
    description: item.snippet.description,
    thumbnail: pickThumbnail(item.snippet.thumbnails),
    itemCount: item.contentDetails.itemCount,
    channelTitle: item.snippet.channelTitle ?? null,
  };
}

export async function getPlaylistItems(
  playlistId: string,
  maxItems = 500
): Promise<PlaylistItem[]> {
  const key = requireKey();
  const allItems: PlaylistItem[] = [];
  let nextPageToken: string | undefined = undefined;

  do {
    const params: Record<string, string | number | undefined> = {
      part: "snippet",
      playlistId,
      key,
      maxResults: 50,
      pageToken: nextPageToken,
    };

    const response = await axios.get<PlaylistItemsResponse>(
      PLAYLIST_ITEMS_URL,
      { params, timeout: 15_000 }
    );
    const data: PlaylistItemsResponse = response.data;

    for (const { snippet } of data.items) {
      // Private/deleted videos can lack resourceId — skip them defensively.
      const videoId = snippet.resourceId?.videoId;
      if (!videoId) continue;
      allItems.push({
        title: snippet.title,
        videoId,
        thumbnail: pickThumbnail(snippet.thumbnails),
        position: snippet.position,
        channelTitle: snippet.videoOwnerChannelTitle ?? null,
      });
      if (allItems.length >= maxItems) return allItems;
    }

    nextPageToken = data.nextPageToken;
  } while (nextPageToken);

  return allItems;
}
