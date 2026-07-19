/** Title posters are either a local file path or a direct hikka.io CDN URL. */
export function posterSrc(posterPath: string): string {
  return /^https?:\/\//i.test(posterPath) ? posterPath : `file://${posterPath}`
}
