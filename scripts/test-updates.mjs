// Tests for the update check logic. Run: node --test scripts/test-updates.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RELEASES_PAGE, checkForUpdate, compareVersions, interpretRelease, parseVersion } from '../app/updates.mjs';

const digest = 'sha256:' + 'ab'.repeat(32);
const release = (overrides = {}) => ({
  tag_name: 'v1.4.0', draft: false, prerelease: false, html_url: RELEASES_PAGE + 'tag/v1.4.0', body: 'Notes', published_at: '2026-11-27T10:00:00Z',
  assets: [{ name: 'OpenSix.exe', state: 'uploaded', size: 123, digest }], ...overrides,
});
const reply = (body, status = 200) => async () => ({ ok: status >= 200 && status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

test('versions parse and compare as numbers, not text', () => {
  assert.deepEqual(parseVersion('v1.3.10'), [1, 3, 10]);
  assert.equal(parseVersion('1.3'), null);
  assert.equal(parseVersion('v1.3.3-beta'), null);
  assert.equal(parseVersion('1.3.3 && calc'), null);
  assert.equal(compareVersions('1.3.10', '1.3.9'), 1);
  assert.equal(compareVersions('1.3.3', 'v1.3.3'), 0);
  assert.equal(compareVersions('1.2.9', '1.10.0'), -1);
  assert.equal(compareVersions('2.0.0', '1.99.99'), 1);
  assert.equal(compareVersions('x', '1.0.0'), null);
});

test('a newer release is available and carries its details', () => {
  const result = interpretRelease(release(), '1.3.4');
  assert.equal(result.status, 'available');
  assert.equal(result.latest, '1.4.0');
  assert.equal(result.url, RELEASES_PAGE + 'tag/v1.4.0');
  assert.equal(result.notes, 'Notes');
  assert.deepEqual(result.asset, { name: 'OpenSix.exe', size: 123, sha256: 'ab'.repeat(32) });
});

test('the same or an older release means up to date', () => {
  assert.equal(interpretRelease(release(), '1.4.0').status, 'current');
  assert.equal(interpretRelease(release(), '1.5.0').status, 'current');
});

test('drafts, prereleases, odd tags and foreign addresses are refused', () => {
  assert.throws(() => interpretRelease(release({ draft: true }), '1.3.4'));
  assert.throws(() => interpretRelease(release({ prerelease: true }), '1.3.4'));
  assert.throws(() => interpretRelease(release({ tag_name: 'v1.4.0-rc1' }), '1.3.4'));
  assert.throws(() => interpretRelease(release({ tag_name: '1.4.0' }), '1.3.4'));
  assert.throws(() => interpretRelease(release({ html_url: 'https://evil.example/releases/tag/v1.4.0' }), '1.3.4'));
  assert.throws(() => interpretRelease(release({ html_url: RELEASES_PAGE + 'tag/v9.9.9' }), '1.3.4'));
  assert.throws(() => interpretRelease(null, '1.3.4'));
  assert.throws(() => interpretRelease(release(), 'unknown'));
});

test('a missing or malformed digest is left out, notes are capped', () => {
  assert.equal(interpretRelease(release({ assets: [{ name: 'OpenSix.exe', state: 'uploaded', size: 5, digest: 'md5:zz' }] }), '1.3.4').asset.sha256, null);
  assert.equal(interpretRelease(release({ assets: [] }), '1.3.4').asset, null);
  assert.equal(interpretRelease(release({ body: 'x'.repeat(10000) }), '1.3.4').notes.length, 4000);
});

test('network replies are checked', async () => {
  assert.equal((await checkForUpdate({ current: '1.3.4', fetchImpl: reply(release()) })).status, 'available');
  await assert.rejects(checkForUpdate({ current: '1.3.4', fetchImpl: reply('not json') }), /unexpected reply/);
  await assert.rejects(checkForUpdate({ current: '1.3.4', fetchImpl: reply({}, 404) }), /status 404/);
  await assert.rejects(checkForUpdate({ current: '1.3.4', fetchImpl: reply({}, 403) }), /limiting requests/);
  await assert.rejects(checkForUpdate({ current: '1.3.4', fetchImpl: reply('x'.repeat(1024 * 1024 + 1)) }), /large reply/);
  await assert.rejects(checkForUpdate({ current: '1.3.4', fetchImpl: async () => { throw new TypeError('net::ERR_CONNECTION_REFUSED'); } }), /Could not reach GitHub\. Check your internet connection\./);
});

test('a reply that never comes times out', async () => {
  const hang = (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
  await assert.rejects(checkForUpdate({ current: '1.3.4', fetchImpl: hang, timeoutMs: 50 }), /did not answer in time/);
});

test('only the version is sent with the request', async () => {
  let sent;
  await checkForUpdate({ current: '1.3.4', fetchImpl: async (url, init) => { sent = { url, headers: init.headers }; return reply(release())(); } });
  assert.match(sent.url, /^https:\/\/api\.github\.com\/repos\/cyberpulse2077\/OpenSix\/releases\/latest$/);
  assert.deepEqual(Object.keys(sent.headers).sort(), ['Accept', 'User-Agent']);
  assert.equal(sent.headers['User-Agent'], 'OpenSix/1.3.4');
});

// ----- the service -----
import { createUpdateService } from '../app/update-service.mjs';

function makeService(options = {}) {
  const store = { ...options.preferences };
  const calls = { fetch: 0, notified: [], opened: [] };
  const service = createUpdateService({
    current: options.current ?? '1.3.4',
    fetchImpl: async () => { calls.fetch++; if (options.fail) throw new Error('offline'); return reply(options.release ?? release())(); },
    preferences: () => store,
    savePreferences: patch => Object.assign(store, patch),
    openExternal: async address => { calls.opened.push(address); },
    notify: result => calls.notified.push(result.latest),
    now: options.now ?? (() => 1_000_000),
    delayMs: 5,
  });
  return { service, store, calls };
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('service: an automatic check tells the window about a new release and remembers when it ran', async () => {
  const { service, store, calls } = makeService();
  const result = await service.check();
  assert.equal(result.status, 'available');
  assert.deepEqual(calls.notified, ['1.4.0']);
  assert.equal(store.updateLastCheck, 1_000_000);
  assert.equal(service.state().result.latest, '1.4.0');
});

test('service: checking switched off means no request at all, until a manual check', async () => {
  const { service, calls } = makeService({ preferences: { updateCheck: false } });
  assert.equal(await service.check(), null);
  service.schedule();
  await pause(40);
  assert.equal(calls.fetch, 0);
  assert.equal((await service.check({ manual: true })).status, 'available');
  assert.equal(calls.fetch, 1);
  assert.deepEqual(calls.notified, []);
});

test('service: a skipped version is not announced, but a manual check still reports it', async () => {
  const { service, calls } = makeService({ preferences: { updateSkipped: '1.4.0' } });
  await service.check();
  assert.deepEqual(calls.notified, []);
  assert.equal((await service.check({ manual: true })).status, 'available');
  assert.equal(service.set({ skip: '1.5.0' }).skipped, '1.5.0');
  assert.throws(() => service.set({ skip: 'rm -rf' }), /Not a version/);
  assert.throws(() => service.set({ enabled: 'yes' }), /on or off/);
  assert.equal(service.set({ skip: null }).skipped, null);
});

test('service: failures are quiet when automatic and reported when manual', async () => {
  const { service, store } = makeService({ fail: true });
  assert.equal(await service.check(), null);
  assert.equal(store.updateLastCheck, undefined);
  await assert.rejects(service.check({ manual: true }), /Could not reach GitHub/);
});

test('service: every start-up checks once, even when the last check was a moment ago', async () => {
  // The last check was 50 ms before "now": a start-up still checks.
  const recent = makeService({ preferences: { updateLastCheck: 1_000_000 }, now: () => 1_000_050 });
  recent.service.schedule();
  await pause(60);
  assert.equal(recent.calls.fetch, 1);
  assert.deepEqual(recent.calls.notified, ['1.4.0']);
  // Nothing repeats while the app keeps running.
  await pause(100);
  assert.equal(recent.calls.fetch, 1);
  recent.service.stop();
});

test('service: the start-up check waits a moment, and a failed one is not retried in a loop', async () => {
  const waiting = makeService();
  waiting.service.schedule();
  assert.equal(waiting.calls.fetch, 0, 'nothing happens before the start-up delay');
  await pause(60);
  assert.equal(waiting.calls.fetch, 1);
  waiting.service.stop();
  const failing = makeService({ fail: true });
  failing.service.schedule();
  await pause(150);
  assert.equal(failing.calls.fetch, 1);
  failing.service.stop();
});

test('service: switching the check on schedules one, switching it off cancels it', async () => {
  const { service, calls } = makeService({ preferences: { updateCheck: false } });
  service.schedule();
  await pause(40);
  assert.equal(calls.fetch, 0);
  service.set({ enabled: true });
  await pause(40);
  assert.equal(calls.fetch, 1);
  service.set({ enabled: false });
  service.schedule();
  await pause(40);
  assert.equal(calls.fetch, 1);
  service.stop();
});

test('service: only the release page found by the last check can be opened', async () => {
  const { service, calls } = makeService();
  await assert.rejects(service.open(), /no update/);
  await service.check();
  assert.equal(await service.open(), true);
  assert.deepEqual(calls.opened, [RELEASES_PAGE + 'tag/v1.4.0']);
  const { service: current } = makeService({ current: '1.4.0' });
  await current.check();
  await assert.rejects(current.open(), /no update/);
});
