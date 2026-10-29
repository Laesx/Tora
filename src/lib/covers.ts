/**
 * Downscale AniList CDN cover URLs to keep WebView2 decoded RGBA image bitmap memory low:
 * - "medium" (230x325, ~299 KB RGBA) for small thumbnails (table rows, compact cards, command palette, selectors)
 * - "large" (460x650, ~1.19 MB RGBA) for poster grid cards & detail drawer instead of "extraLarge" (1000x1500, ~6 MB RGBA)
 */
export function getOptimizedCoverUrl(
  url: string | null | undefined,
  size: "medium" | "large" = "medium"
): string {
  if (!url) return "";
  if (url.includes("/media/anime/cover/")) {
    if (size === "medium") {
      return url
        .replace("/media/anime/cover/extraLarge/", "/media/anime/cover/medium/")
        .replace("/media/anime/cover/large/", "/media/anime/cover/medium/");
    }
    return url.replace(
      "/media/anime/cover/extraLarge/",
      "/media/anime/cover/large/"
    );
  }
  return url;
}
