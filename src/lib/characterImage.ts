// Character portraits come in two shapes: absolute https URLs (Hikka/AniList/
// MAL CDN) and, for pictures the director picked by hand, a relative API path
// ("/api/characters/12/image-file?v=…") served by the local backend. The
// renderer is loaded from file:// (or the Vite dev server), so a relative path
// has to be pointed at the backend explicitly.
export function resolveCharacterImage(url: string | null | undefined, backendPort: number): string | null {
  if (!url) return null
  return url.startsWith('/api/') ? `http://localhost:${backendPort}${url}` : url
}

const MAX_SIDE = 512

// Downsizes a picked / pasted / dropped image to at most 512 px on its long
// side and returns it as a WebP data URL (keeps transparency, stays well under
// the backend's 3 MB limit even for a big original).
export async function imageBlobToDataUrl(blob: Blob): Promise<string> {
  const bitmap = await createImageBitmap(blob)
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height))
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas unavailable')
  ctx.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()
  return canvas.toDataURL('image/webp', 0.9)
}

export function isHttpsUrl(text: string): boolean {
  return /^https:\/\/\S+$/i.test(text.trim())
}
