import { env } from "../env";

export type Period =
  | "overall"
  | "7day"
  | "1month"
  | "3month"
  | "6month"
  | "12month";

// Helper to get largest image from array
function getLargestImage(
  images?: Array<{ "#text": string; size: string }>,
): string | null {
  if (!images || images.length === 0) return null;
  const sizes = ["mega", "extralarge", "large", "medium", "small"];
  for (const size of sizes) {
    const img = images.find((i) => i.size === size && i["#text"]);
    if (img) return img["#text"];
  }
  return images.find((i) => i["#text"])?.["#text"] ?? null;
}

// Helper to get artist name from track
function getArtistName(
  artist: string | { "#text": string } | { name: string },
): string {
  if (typeof artist === "string") return artist;
  if ("#text" in artist) return artist["#text"];
  if ("name" in artist) return artist.name;
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

    const data = (await response.json()) as T & {
      error?: number;
      message?: string;
    };
    if (data.error) {
      throw new Error(data.message || `Last.fm error ${data.error}`);
    }

    return data;
  }

  async getNowPlaying(username: string) {
    const response = await this.apiRequest<any>("user.getRecentTracks", {
      user: username,
      limit: 1,
    });
    const track = response.recenttracks?.track?.[0];

    if (!track) return null;

    const isPlaying = track["@attr"]?.nowplaying === "true";
    return {
      isPlaying,
      track: {
        name: track.name,
        artist: getArtistName(track.artist),
        album: track.album?.["#text"] ?? null,
        url: track.url,
        image: getLargestImage(track.image),
        playedAt: isPlaying ? null : (track.date?.["#text"] ?? null),
      },
    };
  }

  async getRecentTracks(username: string, limit = 10) {
    const response = await this.apiRequest<any>("user.getRecentTracks", {
      user: username,
      limit,
    });

    const tracks = (response.recenttracks?.track ?? []).map((t: any) => ({
      name: t.name,
      artist: getArtistName(t.artist),
      album: t.album?.["#text"] ?? null,
      url: t.url,
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
    const response = await this.apiRequest<any>("user.getInfo", {
      user: username,
    });
    const user = response.user;

    return {
      name: user.name,
      realName: user.realname ?? null,
      url: user.url,
      image: getLargestImage(user.image),
      country: user.country ?? null,
      playcount: Number.parseInt(user.playcount, 10),
      artistCount: user.artist_count
        ? Number.parseInt(user.artist_count, 10)
        : null,
      trackCount: user.track_count
        ? Number.parseInt(user.track_count, 10)
        : null,
      albumCount: user.album_count
        ? Number.parseInt(user.album_count, 10)
        : null,
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
    const response = await this.apiRequest<any>("user.getTopArtists", {
      user: username,
      period,
      limit,
    });

    const artists = (response.topartists?.artist ?? []).map((a: any) => ({
      rank: Number.parseInt(a["@attr"]?.rank, 10),
      name: a.name,
      playcount: Number.parseInt(a.playcount, 10),
      url: a.url,
      image: getLargestImage(a.image),
    }));

    return {
      user: response.topartists?.["@attr"]?.user,
      period,
      artists,
    };
  }

  async getTopTracks(username: string, period: Period = "overall", limit = 10) {
    const response = await this.apiRequest<any>("user.getTopTracks", {
      user: username,
      period,
      limit,
    });

    const tracks = (response.toptracks?.track ?? []).map((t: any) => ({
      rank: Number.parseInt(t["@attr"]?.rank, 10),
      name: t.name,
      artist: t.artist?.name ?? getArtistName(t.artist),
      playcount: Number.parseInt(t.playcount, 10),
      url: t.url,
    }));

    return {
      user: response.toptracks?.["@attr"]?.user,
      period,
      tracks,
    };
  }

  async getTopAlbums(username: string, period: Period = "overall", limit = 10) {
    const response = await this.apiRequest<any>("user.getTopAlbums", {
      user: username,
      period,
      limit,
    });

    const albums = (response.topalbums?.album ?? []).map((a: any) => ({
      rank: Number.parseInt(a["@attr"]?.rank, 10),
      name: a.name,
      artist: a.artist?.name ?? getArtistName(a.artist),
      playcount: Number.parseInt(a.playcount, 10),
      url: a.url,
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
