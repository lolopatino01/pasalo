// Archivos que llegaron desde "Compartir → Pasalo" (Android).
export async function takeSharedFiles(): Promise<File[]> {
  const params = new URLSearchParams(location.search);
  if (!params.has('compartido')) return [];
  history.replaceState(null, '', '/');
  try {
    const cache = await caches.open('pasalo-share');
    const files: File[] = [];
    for (const req of await cache.keys()) {
      const res = await cache.match(req);
      if (!res) continue;
      const blob = await res.blob();
      const name = decodeURIComponent(res.headers.get('x-name') || 'archivo');
      files.push(new File([blob], name, { type: res.headers.get('content-type') || blob.type }));
    }
    await caches.delete('pasalo-share');
    return files;
  } catch {
    return [];
  }
}
