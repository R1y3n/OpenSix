// Native helpers are shipped with a platform-specific extension. Keep the
// Windows names from the original build and use the bare ELF names on Linux.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const windows = process.platform === 'win32';

export function nativeTool(name) {
  const base = name.replace(/\.exe$/, '');
  return windows ? `${base}.exe` : base;
}

export function nativeLibrary(name) {
  const base = name.replace(/\.(dll|so|dylib)$/, '');
  return windows ? `${base}.dll` : `lib${base}.so`;
}

export function resolveNativeTool(name) {
  const tool = nativeTool(name);
  if (process.resourcesPath && existsSync(join(process.resourcesPath, tool))) {
    return join(process.resourcesPath, tool);
  }
  return fileURLToPath(new URL(`./worker/${tool}`, import.meta.url));
}

export function nativeLibraryDirectory() {
  if (process.resourcesPath) return process.resourcesPath;
  return fileURLToPath(new URL('./worker/', import.meta.url));
}
