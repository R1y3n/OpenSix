// Update checking: asks GitHub's release API whether a newer OpenSix release exists. It only reads the public record of
// the latest release. Nothing about the user, the PC or the game is sent.
export const RELEASES_API = 'https://api.github.com/repos/cyberpulse2077/OpenSix/releases/latest';
export const RELEASES_PAGE = 'https://github.com/cyberpulse2077/OpenSix/releases/';
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_NOTES = 4000;

// A release tag or version: three numbers, with an optional leading "v".
export function parseVersion(text) {
  const match = /^v?(\d{1,5})\.(\d{1,5})\.(\d{1,5})$/.exec(String(text ?? '').trim());
  return match ? match.slice(1).map(Number) : null;
}

// -1 when `a` is older than `b`, 0 when they are the same, 1 when newer. null when either is not a version.
export function compareVersions(a, b) {
  const left = parseVersion(a), right = parseVersion(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  return 0;
}

// Turns GitHub's "latest release" record into what the app shows, or throws when the record is not a usable release.
// A release is usable when it is a published, stable release whose page is this project's own release page.
export function interpretRelease(release, current) {
  if (!release || typeof release !== 'object') throw new Error('GitHub sent an unexpected reply.');
  if (release.draft === true || release.prerelease === true) throw new Error('The latest release is not a stable release.');
  const tag = String(release.tag_name ?? '');
  const version = parseVersion(tag)?.join('.');
  if (!version || tag !== 'v' + version) throw new Error('The latest release has an unexpected version.');
  if (release.html_url !== RELEASES_PAGE + 'tag/' + tag) throw new Error('The latest release has an unexpected address.');
  const asset = Array.isArray(release.assets) ? release.assets.find(item => item?.name === 'OpenSix.exe' && item.state === 'uploaded') : null;
  const sha256 = /^sha256:([0-9a-f]{64})$/.exec(String(asset?.digest ?? ''))?.[1] ?? null;
  const newer = compareVersions(version, current);
  if (newer === null) throw new Error('The installed version is not recognized.');
  return {
    status: newer > 0 ? 'available' : 'current',
    current,
    latest: version,
    url: release.html_url,
    notes: typeof release.body === 'string' ? release.body.slice(0, MAX_NOTES) : '',
    published: typeof release.published_at === 'string' ? release.published_at : null,
    asset: asset ? { name: asset.name, size: Number.isSafeInteger(asset.size) ? asset.size : null, sha256 } : null,
  };
}

// Fetches and interprets the latest release. `fetchImpl(url, init)` is the network call, so tests can supply their own.
export async function checkForUpdate({ current, fetchImpl, url = RELEASES_API, timeoutMs = 8000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await fetchImpl(url, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'OpenSix/' + current },
        signal: controller.signal,
      });
    } catch {
      // The network layer's own message is technical ("net::ERR_…"), so say what it means.
      throw new Error(controller.signal.aborted ? 'GitHub did not answer in time.' : 'Could not reach GitHub. Check your internet connection.');
    }
    if (response.status === 403 || response.status === 429) throw new Error('GitHub is limiting requests right now. Try again later.');
    if (!response.ok) throw new Error('GitHub answered with status ' + response.status + '.');
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) throw new Error('GitHub sent an unexpectedly large reply.');
    let release;
    try { release = JSON.parse(text); } catch { throw new Error('GitHub sent an unexpected reply.'); }
    return interpretRelease(release, current);
  } catch (error) {
    if (controller.signal.aborted) throw new Error('GitHub did not answer in time.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
