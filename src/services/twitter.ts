import axios from "axios";

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

export interface NormalizedTweet {
  id: string;
  url: string;
  text: string;
  createdAt: string;
  user: {
    name: string;
    handle: string;
    verified: boolean;
    avatar: string | null;
  };
  likes: number;
  replies: number;
  photos: { url: string; width: number; height: number }[];
  video: { poster: string | null; src: string; isGif: boolean } | null;
  article: {
    title: string;
    preview: string;
    coverImage: string | null;
    url: string;
  } | null;
}

/** Token the syndication endpoint expects (mirrors react-tweet's derivation). */
function syndicationToken(id: string): string {
  return ((Number(id) / 1e15) * Math.PI)
    .toString(36)
    .replace(/(0+|\.)/g, "");
}

interface SyndicationUrlEntity {
  url: string;
  expanded_url?: string;
  display_url?: string;
}

interface SyndicationMediaDetail {
  type: string; // "photo" | "video" | "animated_gif"
  media_url_https: string;
  original_info?: { width: number; height: number };
  video_info?: {
    variants?: { content_type: string; url: string; bitrate?: number }[];
  };
}

interface SyndicationResponse {
  __typename?: string;
  text?: string;
  created_at?: string;
  favorite_count?: number;
  conversation_count?: number;
  entities?: {
    urls?: SyndicationUrlEntity[];
    media?: { url: string }[];
  };
  user?: {
    name: string;
    screen_name: string;
    is_blue_verified?: boolean;
    verified?: boolean;
    profile_image_url_https?: string;
  };
  mediaDetails?: SyndicationMediaDetail[];
  article?: {
    title?: string;
    preview_text?: string;
    rest_id?: string;
    cover_media?: { media_info?: { original_img_url?: string } };
  };
}

const isArticleUrl = (url?: string) => /\/i\/article\//.test(url ?? "");

/** Decode the handful of HTML entities the syndication API leaves in text. */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'");
}

export async function fetchTweet(id: string): Promise<NormalizedTweet | null> {
  const token = syndicationToken(id);
  const { data } = await axios.get<SyndicationResponse>(SYNDICATION_URL, {
    params: { id, token, lang: "en" },
    timeout: 10_000,
    // The endpoint requires a browser-like UA, otherwise it 403s.
    headers: { "User-Agent": "Mozilla/5.0" },
  });

  if (!data || !data.user || data.__typename === "TweetTombstone") {
    return null;
  }

  const urlEntities = data.entities?.urls ?? [];

  // Build display text: swap external t.co links for their display form, drop
  // the article's own link (rendered as a card), and remove media links (the
  // tweet's own photo/video, rendered inline) entirely.
  let text = data.text ?? "";
  for (const u of urlEntities) {
    text = text
      .split(u.url)
      .join(isArticleUrl(u.expanded_url) ? "" : u.display_url ?? u.url);
  }
  for (const m of data.entities?.media ?? []) {
    text = text.split(m.url).join("");
  }
  text = decodeEntities(text).trim();

  const photos = (data.mediaDetails ?? [])
    .filter((m) => m.type === "photo")
    .map((m) => ({
      url: m.media_url_https,
      width: m.original_info?.width ?? 0,
      height: m.original_info?.height ?? 0,
    }));

  let video: NormalizedTweet["video"] = null;
  const videoMedia = (data.mediaDetails ?? []).find(
    (m) => m.type === "video" || m.type === "animated_gif"
  );
  if (videoMedia?.video_info?.variants) {
    const mp4 = videoMedia.video_info.variants
      .filter((v) => v.content_type === "video/mp4" && v.url)
      .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))[0];
    if (mp4) {
      video = {
        poster: videoMedia.media_url_https ?? null,
        src: mp4.url,
        isGif: videoMedia.type === "animated_gif",
      };
    }
  }

  let article: NormalizedTweet["article"] = null;
  if (data.article) {
    const articleUrl =
      urlEntities.find((u) => isArticleUrl(u.expanded_url))?.expanded_url ??
      (data.article.rest_id
        ? `https://x.com/i/article/${data.article.rest_id}`
        : `https://x.com/i/status/${id}`);
    article = {
      title: data.article.title ?? "",
      preview: data.article.preview_text ?? "",
      coverImage: data.article.cover_media?.media_info?.original_img_url ?? null,
      url: articleUrl.replace(/^http:/, "https:"),
    };
  }

  return {
    id,
    url: `https://x.com/${data.user.screen_name}/status/${id}`,
    text,
    createdAt: data.created_at ?? "",
    user: {
      name: data.user.name,
      handle: data.user.screen_name,
      verified: Boolean(data.user.is_blue_verified || data.user.verified),
      avatar:
        data.user.profile_image_url_https?.replace("_normal", "_200x200") ??
        null,
    },
    likes: data.favorite_count ?? 0,
    replies: data.conversation_count ?? 0,
    photos,
    video,
    article,
  };
}
