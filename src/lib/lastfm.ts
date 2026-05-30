import { z } from "zod";
import { env } from "../env";

export type Period =
  | "overall"
  | "7day"
  | "1month"
  | "3month"
  | "6month"
  | "12month";

const LastFMImageSchema = z.looseObject({
    "#text": z.string(),
    size: z.string(),
  });

const ArtistNameSchema = z.union([
  z.string(),
  z.looseObject({
      "#text": z.string(),
    }),
  z.looseObject({
      name: z.string(),
    }),
]);

const LastFMErrorSchema = z.looseObject({
    error: z.number().optional(),
    message: z.string().optional(),
  });

const RecentTrackSchema = z.looseObject({
    "@attr": z
      .looseObject({
        nowplaying: z.string().optional(),
      })
      .optional(),
    album: z
      .looseObject({
        "#text": z.string().optional(),
      })
      .optional(),
    artist: z.unknown(),
    date: z
      .looseObject({
        "#text": z.string().optional(),
      })
      .optional(),
    image: z.array(LastFMImageSchema).optional(),
    name: z.string().optional(),
    url: z.string().optional(),
  });

const RecentTracksResponseSchema = z.looseObject({
    recenttracks: z
      .looseObject({
        "@attr": z
          .looseObject({
            total: z.string().optional(),
            user: z.string().optional(),
          })
          .optional(),
        track: z.array(RecentTrackSchema).optional(),
      })
      .optional(),
  });

const UserInfoResponseSchema = z.looseObject({
    user: z
      .looseObject({
        album_count: z.string().optional(),
        artist_count: z.string().optional(),
        country: z.string().optional(),
        image: z.array(LastFMImageSchema).optional(),
        name: z.string().optional(),
        playcount: z.string().optional(),
        realname: z.string().optional(),
        registered: z
          .looseObject({
            unixtime: z.string().optional(),
          })
          .optional(),
        track_count: z.string().optional(),
        url: z.string().optional(),
      }),
  });

const TopArtistSchema = z.looseObject({
    "@attr": z
      .looseObject({
        rank: z.string().optional(),
      })
      .optional(),
    image: z.array(LastFMImageSchema).optional(),
    name: z.string().optional(),
    playcount: z.string().optional(),
    url: z.string().optional(),
  });

const TopArtistsResponseSchema = z.looseObject({
    topartists: z
      .looseObject({
        "@attr": z
          .looseObject({
            user: z.string().optional(),
          })
          .optional(),
        artist: z.array(TopArtistSchema).optional(),
      })
      .optional(),
  });

const TopTrackSchema = z.looseObject({
    "@attr": z
      .looseObject({
        rank: z.string().optional(),
      })
      .optional(),
    artist: z.unknown(),
    name: z.string().optional(),
    playcount: z.string().optional(),
    url: z.string().optional(),
  });

const TopTracksResponseSchema = z.looseObject({
    toptracks: z
      .looseObject({
        "@attr": z
          .looseObject({
            user: z.string().optional(),
          })
          .optional(),
        track: z.array(TopTrackSchema).optional(),
      })
      .optional(),
  });

const TopAlbumSchema = z.looseObject({
    "@attr": z
      .looseObject({
        rank: z.string().optional(),
      })
      .optional(),
    artist: z.unknown(),
    image: z.array(LastFMImageSchema).optional(),
    name: z.string().optional(),
    playcount: z.string().optional(),
    url: z.string().optional(),
  });

const TopAlbumsResponseSchema = z.looseObject({
    topalbums: z
      .looseObject({
        "@attr": z
          .looseObject({
            user: z.string().optional(),
          })
          .optional(),
        album: z.array(TopAlbumSchema).optional(),
      })
      .optional(),
  });

function parseIntOrNull(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function parseIntOrZero(value: string | undefined): number {
  return parseIntOrNull(value) ?? 0;
}

function getLargestImage(images?: z.infer<typeof LastFMImageSchema>[]): string | null {
  if (!images?.length) return null;
  const sizes = ["mega", "extralarge", "large", "medium", "small"];
  for (const size of sizes) {
    const img = images.find((i) => i.size === size && i["#text"]);
    if (img) return img["#text"];
  }
  return images.find((i) => i["#text"])?.["#text"] ?? null;
}

function getArtistName(artist: unknown): string {
  const parsed = ArtistNameSchema.safeParse(artist);
  if (!parsed.success) return "Unknown Artist";

  if (typeof parsed.data === "string") return parsed.data;
  if ("#text" in parsed.data && typeof parsed.data["#text"] === "string") {
    return parsed.data["#text"];
  }
  if ("name" in parsed.data && typeof parsed.data.name === "string") {
    return parsed.data.name;
  }
  return "Unknown Artist";
}

export class LastFMClient {
  private readonly apiBase = "https://ws.audioscrobbler.com/2.0";

  private getApiKey(): string {
    const apiKey = env.LASTFM_API_KEY;
    if (!apiKey) {
      throw new Error("LASTFM_API_KEY environment variable is not set");
    }
    return apiKey;
  }

  private async apiRequest<T>(
    method: string,
    params: Record<string, string | number>,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const url = new URL(this.apiBase);
    url.searchParams.set("method", method);
    url.searchParams.set("api_key", this.getApiKey());
    url.searchParams.set("format", "json");

    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, String(value));
    }

    const response = await fetch(url.toString());
    if (!response.ok) {
      throw new Error(`Last.fm API error: ${response.status}`);
    }

    const data = await response.json();
    const errorBody = LastFMErrorSchema.safeParse(data);
    if (errorBody.success && errorBody.data.error) {
      throw new Error(
        errorBody.data.message || `Last.fm error ${errorBody.data.error}`,
      );
    }

    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      throw new Error("Last.fm returned an unexpected response shape");
    }

    return parsed.data;
  }

  async getNowPlaying(username: string) {
    const response = await this.apiRequest(
      "user.getRecentTracks",
      {
        user: username,
        limit: 1,
      },
      RecentTracksResponseSchema,
    );
    const track = response.recenttracks?.track?.[0];

    if (!track) return null;

    const isPlaying = track["@attr"]?.nowplaying === "true";
    return {
      isPlaying,
      track: {
        name: track.name ?? "Unknown Track",
        artist: getArtistName(track.artist),
        album: track.album?.["#text"] ?? null,
        url: track.url ?? null,
        image: getLargestImage(track.image),
        playedAt: isPlaying ? null : (track.date?.["#text"] ?? null),
      },
    };
  }

  async getRecentTracks(username: string, limit = 10) {
    const response = await this.apiRequest(
      "user.getRecentTracks",
      {
        user: username,
        limit,
      },
      RecentTracksResponseSchema,
    );

    const tracks = (response.recenttracks?.track ?? []).map((t) => ({
      name: t.name ?? "Unknown Track",
      artist: getArtistName(t.artist),
      album: t.album?.["#text"] ?? null,
      url: t.url ?? null,
      isPlaying: t["@attr"]?.nowplaying === "true",
      playedAt: t.date?.["#text"] ?? null,
    }));

    return {
      user: response.recenttracks?.["@attr"]?.user,
      totalScrobbles: response.recenttracks?.["@attr"]?.total,
      tracks,
    };
  }

  async getUserInfo(username: string) {
    const response = await this.apiRequest(
      "user.getInfo",
      {
        user: username,
      },
      UserInfoResponseSchema,
    );
    const user = response.user;

    return {
      name: user.name ?? username,
      realName: user.realname ?? null,
      url: user.url ?? null,
      image: getLargestImage(user.image),
      country: user.country ?? null,
      playcount: parseIntOrZero(user.playcount),
      artistCount: parseIntOrNull(user.artist_count),
      trackCount: parseIntOrNull(user.track_count),
      albumCount: parseIntOrNull(user.album_count),
      registered: user.registered?.unixtime
        ? new Date(
            Number.parseInt(user.registered.unixtime, 10) * 1000,
          ).toISOString()
        : null,
    };
  }

  async getTopArtists(
    username: string,
    period: Period = "overall",
    limit = 10,
  ) {
    const response = await this.apiRequest(
      "user.getTopArtists",
      {
        user: username,
        period,
        limit,
      },
      TopArtistsResponseSchema,
    );

    const artists = (response.topartists?.artist ?? []).map((a) => ({
      rank: parseIntOrZero(a["@attr"]?.rank),
      name: a.name ?? "Unknown Artist",
      playcount: parseIntOrZero(a.playcount),
      url: a.url ?? null,
      image: getLargestImage(a.image),
    }));

    return {
      user: response.topartists?.["@attr"]?.user,
      period,
      artists,
    };
  }

  async getTopTracks(username: string, period: Period = "overall", limit = 10) {
    const response = await this.apiRequest(
      "user.getTopTracks",
      {
        user: username,
        period,
        limit,
      },
      TopTracksResponseSchema,
    );

    const tracks = (response.toptracks?.track ?? []).map((t) => ({
      rank: parseIntOrZero(t["@attr"]?.rank),
      name: t.name ?? "Unknown Track",
      artist: getArtistName(t.artist),
      playcount: parseIntOrZero(t.playcount),
      url: t.url ?? null,
    }));

    return {
      user: response.toptracks?.["@attr"]?.user,
      period,
      tracks,
    };
  }

  async getTopAlbums(username: string, period: Period = "overall", limit = 10) {
    const response = await this.apiRequest(
      "user.getTopAlbums",
      {
        user: username,
        period,
        limit,
      },
      TopAlbumsResponseSchema,
    );

    const albums = (response.topalbums?.album ?? []).map((a) => ({
      rank: parseIntOrZero(a["@attr"]?.rank),
      name: a.name ?? "Unknown Album",
      artist: getArtistName(a.artist),
      playcount: parseIntOrZero(a.playcount),
      url: a.url ?? null,
      image: getLargestImage(a.image),
    }));

    return {
      user: response.topalbums?.["@attr"]?.user,
      period,
      albums,
    };
  }
}

export const lastFMClient = new LastFMClient();
