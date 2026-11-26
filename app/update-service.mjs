// Runs update checks for the app: the preferences, the check at start-up, "skip this version" and opening the release page.
// The network, the preference store, the browser and the window are passed in, so the main process wires the real ones.
import { RELEASES_PAGE, checkForUpdate, parseVersion } from './updates.mjs';

export function createUpdateService({
  current, fetchImpl, url, preferences, savePreferences, openExternal, notify,
  now = Date.now, delayMs = 6000, automatic = true,
}) {
  let last = null;
  let running = null;
  let timer = null;

  const enabled = () => preferences().updateCheck !== false;

  function state() {
    const prefs = preferences();
    return { current, enabled: enabled(), automatic, lastCheck: prefs.updateLastCheck ?? null, skipped: prefs.updateSkipped ?? null, result: last };
  }

  // A manual check always reports back to the caller and ignores "skip". An automatic check is quiet: it says nothing when
  // it fails or when the release was skipped, and it only runs while checking is switched on.
  function check({ manual = false } = {}) {
    if (!manual && !enabled()) return Promise.resolve(null);
    if (running) return running;
    running = (async () => {
      try {
        const result = await checkForUpdate({ current, fetchImpl, url });
        last = result;
        savePreferences({ updateLastCheck: now() });
        if (!manual && result.status === 'available' && preferences().updateSkipped !== result.latest) notify(result);
        return result;
      } catch (error) {
        if (manual) throw error;
        return null;
      } finally {
        running = null;
      }
    })();
    return running;
  }

  function stop() {
    clearTimeout(timer);
    timer = null;
  }

  // Checks once, a few seconds after the app has started, so that start-up itself is not slowed down. Every start-up checks.
  function schedule() {
    stop();
    if (!automatic || !enabled()) return;
    timer = setTimeout(() => { timer = null; check(); }, delayMs);
    timer.unref?.();
  }

  function set({ enabled: on, skip } = {}) {
    const patch = {};
    if (on !== undefined) {
      if (typeof on !== 'boolean') throw new Error('Choose on or off.');
      patch.updateCheck = on;
    }
    if (skip !== undefined) {
      if (skip !== null && !parseVersion(skip)) throw new Error('Not a version.');
      patch.updateSkipped = skip === null ? null : parseVersion(skip).join('.');
    }
    savePreferences(patch);
    if (on !== undefined) schedule();
    return state();
  }

  // Opens the page of the release that the last check found, in the default browser. The page address comes from the
  // checked release record and has to be this project's own release page.
  async function open() {
    if (last?.status !== 'available' || !last.url.startsWith(RELEASES_PAGE)) throw new Error('There is no update to open.');
    await openExternal(last.url);
    return true;
  }

  return { state, check, set, open, schedule, stop };
}
