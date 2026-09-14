export const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

export function byteSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(2)} MB`;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let text = '';
  for (let offset = 0; offset < bytes.length; offset += 32768) text += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return btoa(text);
}

export async function saveBytes(bytes: Uint8Array, name: string, mime = 'application/octet-stream'): Promise<void> {
  if (window.mapDesktop) {
    await window.mapDesktop.saveFile({ name, base64: bytesToBase64(bytes) });
    return;
  }
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes).buffer], { type: mime }));
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = name; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
