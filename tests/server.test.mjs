import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, unlink, rmdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createSiteServer } from '../server.mjs';

async function start(t, options = {}) {
    const server = createSiteServer(options);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise((done) => { server.close(done); server.closeAllConnections(); }));
    return `http://127.0.0.1:${server.address().port}`;
}
const ok = (data) => Response.json({ data, error: { code: 'ok' } });
const video = (id = '7340000000000000001') => ({ id, title: 'Настоящий ролик', create_time: 1700000000, cover_image_url: 'https://example.com/cover.jpg', duration: 15, view_count: 123 });
const user = { display_name: 'Yusshha', avatar_url: 'https://example.com/avatar.jpg' };

test('static pages work; credentials and repository files are not served', async (t) => {
    const base = await start(t);
    for (const route of ['/', '/clips.html', '/clips.js', '/page-transition.css', '/tiktok-videos.json']) assert.equal((await fetch(base + route)).status, 200);
    for (const route of ['/.env', '/.git/config', '/.local/tiktok-token.json', '/server.mjs', '/package.json']) assert.equal((await fetch(base + route)).status, 404);
    assert.equal((await fetch(base + '/api/tiktok', { method: 'POST' })).status, 405);
});

test('unconfigured server explicitly reports embed mode without contacting TikTok', async (t) => {
    const base = await start(t, { fetchImpl: () => assert.fail('TikTok must not be called') });
    const payload = await (await fetch(base + '/api/tiktok')).json();
    assert.equal(payload.mode, 'embed');
    assert.equal(payload.profile.username, 'yusshhik');
    assert.deepEqual(payload.videos, []);
});

test('saved real videos renew oEmbed thumbnails without claiming live discovery', async (t) => {
    let calls = 0;
    const base = await start(t, { catalogPath: resolve('tiktok-videos.json'), fetchImpl: async (url) => {
        calls++;
        assert.ok(url.startsWith('https://www.tiktok.com/oembed?url='));
        return Response.json({ author_url: 'https://www.tiktok.com/@yusshhik', title: 'Обновлённая подпись', thumbnail_url: 'https://example.com/refreshed.jpg' });
    } });
    const payload = await (await fetch(base + '/api/tiktok')).json();
    assert.equal(payload.mode, 'catalog');
    assert.equal(payload.videos.length, 18);
    assert.equal(payload.videos[0].coverUrl, 'https://example.com/refreshed.jpg');
    assert.equal(payload.videos[0].title, 'Обновлённая подпись');
    await fetch(base + '/api/tiktok');
    assert.equal(calls, 18);
});

test('live API maps videos, caches requests, preserves ID strings, and paginates', async (t) => {
    const requests = [];
    const base = await start(t, { accessToken: 'test-access-secret', fetchImpl: async (url, options) => {
        requests.push({ url, options });
        assert.equal(options.headers.Authorization, 'Bearer test-access-secret');
        return url.includes('/user/info/') ? ok({ user }) : ok({ videos: [video()], cursor: 1700000000000, has_more: true });
    } });
    const response = await fetch(base + '/api/tiktok');
    const payload = await response.json();
    assert.equal(payload.mode, 'live');
    assert.equal(payload.profile.displayName, 'Yusshha');
    assert.equal(payload.videos[0].id, '7340000000000000001');
    assert.equal(payload.videos[0].views, 123);
    assert.equal(payload.hasMore, true);
    assert.ok(!JSON.stringify(payload).includes('test-access-secret'));
    await fetch(base + '/api/tiktok');
    assert.equal(requests.length, 2);
    await fetch(base + '/api/tiktok?cursor=1700000000000');
    assert.equal(requests.length, 4);
    assert.equal(JSON.parse(requests[3].options.body).cursor, 1700000000000);
    assert.equal((await fetch(base + '/api/tiktok?cursor=-1')).status, 400);
    assert.equal((await fetch(base + '/api/tiktok?cursor=not-a-cursor')).status, 400);
});

test('upstream failure is reported and a later request can recover', async (t) => {
    let fail = true;
    const base = await start(t, { accessToken: 'test-access-secret', fetchImpl: async (url) => {
        if (fail) return Response.json({ error: { code: 'access_token_invalid', message: 'private upstream details' } }, { status: 401 });
        return url.includes('/user/info/') ? ok({ user }) : ok({ videos: [video()], has_more: false });
    } });
    const response = await fetch(base + '/api/tiktok');
    assert.equal(response.status, 503);
    assert.ok(!(await response.text()).includes('private upstream details'));
    fail = false;
    assert.equal((await fetch(base + '/api/tiktok')).status, 200);
});

test('refresh token rotates once and is restored from private storage on restart', async (t) => {
    const workRoot = resolve('work');
    await mkdir(workRoot, { recursive: true });
    const folder = await mkdtemp(join(workRoot, 'token-test-'));
    const tokenStore = join(folder, 'token.json');
    t.after(async () => { await unlink(tokenStore).catch(() => {}); await rmdir(folder); });
    let refreshCount = 0;
    const options = { refreshToken: 'initial-test-refresh', clientKey: 'test-key', clientSecret: 'test-secret', tokenStore, fetchImpl: async (url, request) => {
        if (url.includes('/oauth/token/')) {
            refreshCount++;
            assert.equal(new URLSearchParams(request.body).get('refresh_token'), 'initial-test-refresh');
            return Response.json({ access_token: 'new-test-access', refresh_token: 'rotated-test-refresh', expires_in: 86400 });
        }
        assert.equal(request.headers.Authorization, 'Bearer new-test-access');
        return url.includes('/user/info/') ? ok({ user }) : ok({ videos: [video()], has_more: false });
    } };
    const base = await start(t, options);
    assert.equal((await fetch(base + '/api/tiktok')).status, 200);
    assert.equal(refreshCount, 1);
    const saved = JSON.parse(await readFile(tokenStore, 'utf8'));
    assert.equal(saved.refreshToken, 'rotated-test-refresh');
    const restarted = await start(t, options);
    assert.equal((await fetch(restarted + '/api/tiktok')).status, 200);
    assert.equal(refreshCount, 1);
});

test('optional scopes expose real stats and reject a different profile', async (t) => {
    let wrongProfile = false;
    const base = await start(t, { accessToken: 'test-token', scopes: 'user.info.basic,video.list,user.info.profile,user.info.stats', cacheMs: 0, fetchImpl: async (url) => {
        if (url.includes('/user/info/')) {
            assert.ok(url.includes('username'));
            assert.ok(url.includes('follower_count'));
            return ok({ user: { ...user, username: wrongProfile ? 'another_user' : 'yusshhik', bio_description: 'Описание', follower_count: 1234 } });
        }
        return ok({ videos: [], has_more: false });
    } });
    const payload = await (await fetch(base + '/api/tiktok')).json();
    assert.equal(payload.profile.followers, 1234);
    assert.equal(payload.profile.bio, 'Описание');
    wrongProfile = true;
    assert.equal((await fetch(base + '/api/tiktok')).status, 503);
});
