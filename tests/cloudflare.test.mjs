import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Feed, handleRequest } from '../cloudflare/feed.mjs';

const scopes = 'user.info.basic,user.info.profile,user.info.stats,video.list';
function fixture({ expired = false, fail = false, unauthorized = false, username = 'yusshhik' } = {}) {
    let time = 1800000000000;
    const data = new Map();
    const storage = {
        async get(key) { return structuredClone(data.get(key)); },
        async put(key, value) { data.set(key, structuredClone(value)); },
    };
    const env = {
        TIKTOK_CLIENT_KEY: 'private-key', TIKTOK_CLIENT_SECRET: 'private-secret',
        TIKTOK_TOKEN_SEED: JSON.stringify({ accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: time + (expired ? -1000 : 3600000), scopes }),
        SITE_ORIGIN: 'https://yusha-lyart.vercel.app',
    };
    const calls = [];
    const fetchImpl = async function (url, options) {
        assert.equal(this, undefined, 'Workers fetch requires a standalone function call');
        calls.push({ url, options });
        if (url.includes('/oauth/token/')) {
            assert.equal(options.body.get('refresh_token'), 'old-refresh');
            return Response.json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 86400, scope: scopes });
        }
        if (fail) return Response.json({ error: { code: 'secret-upstream-detail' } }, { status: 500 });
        if (unauthorized && options.headers.Authorization === 'Bearer old-access') return new Response('', { status: 401 });
        if (url.includes('/user/info/')) return Response.json({ data: { user: { username, display_name: 'Yusshha', follower_count: 32 } }, error: { code: 'ok' } });
        const body = JSON.parse(options.body);
        return Response.json({ data: { videos: [{ id: '7595115306188425223', title: 'Video', view_count: 100 }], cursor: body.cursor || 1800000000, has_more: !body.cursor }, error: { code: 'ok' } });
    };
    const feed = new Feed(storage, env, fetchImpl, () => time);
    env.TIKTOK_FEED = { getByName(name) { assert.equal(name, 'yusshhik'); return { getFeed: cursor => feed.get(cursor) }; } };
    return { feed, env, storage, calls, advance: ms => { time += ms; }, now: () => time, fetchImpl };
}

test('cloud feed persists rotated tokens and cache across instance restarts', async () => {
    const f = fixture({ expired: true });
    const values = await Promise.all(Array.from({ length: 6 }, () => f.feed.get()));
    assert.equal(f.calls.filter(call => call.url.includes('/oauth/token/')).length, 1);
    assert.equal(f.calls.length, 3);
    assert.equal(values[0].profile.followers, 32);
    assert.equal(values[0].videos[0].id, '7595115306188425223');
    const restarted = new Feed(f.storage, f.env, f.fetchImpl, f.now);
    assert.deepEqual(await restarted.get(), values[0]);
    assert.equal(f.calls.length, 3);
    assert.equal((await f.storage.get('auth')).refreshToken, 'new-refresh');
    f.advance(61000);
    await restarted.get();
    assert.equal(f.calls.length, 5);
    assert.equal(f.calls[3].options.headers.Authorization, 'Bearer new-access');
});

test('parallel upstream 401s share one refresh; pagination bypasses latest cache', async () => {
    const f = fixture({ unauthorized: true });
    await f.feed.get();
    assert.equal(f.calls.filter(call => call.url.includes('/oauth/token/')).length, 1);
    const older = await f.feed.get('1700000000000');
    assert.equal(older.hasMore, false);
    assert.equal(older.cursor, 1700000000000);
});

test('public endpoint allows the site CORS origin and hides all private routes', async () => {
    const f = fixture();
    const request = (path, options = {}) => new Request(`https://api.example${path}`, { headers: { Origin: f.env.SITE_ORIGIN }, ...options });
    const response = await handleRequest(request('/api/tiktok'), f.env);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), f.env.SITE_ORIGIN);
    const text = await response.text();
    for (const secret of ['old-access', 'old-refresh', 'private-key', 'private-secret']) assert.equal(text.includes(secret), false);
    for (const path of ['/.env', '/.local/tiktok-token.json', '/cloudflare/worker.mjs', '/']) assert.equal((await handleRequest(request(path), f.env)).status, 404);
    assert.equal((await handleRequest(request('/api/tiktok', { method: 'HEAD' }), f.env)).status, 200);
    assert.equal(await (await handleRequest(request('/api/tiktok', { method: 'HEAD' }), f.env)).text(), '');
    assert.equal((await handleRequest(request('/api/tiktok', { method: 'OPTIONS' }), f.env)).status, 204);
    assert.equal((await handleRequest(request('/api/tiktok', { method: 'POST' }), f.env)).status, 405);
    assert.equal((await handleRequest(request('/api/tiktok?cursor=9007199254740992'), f.env)).status, 400);
    assert.equal((await handleRequest(request('/api/tiktok?cursor=abc'), f.env)).status, 400);
    const denied = await handleRequest(request('/api/tiktok', { headers: { Origin: 'https://other.example' } }), f.env);
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.has('Access-Control-Allow-Origin'), false);
    assert.equal(f.calls.length, 2);
});

test('cloud errors do not expose upstream details or cache a different profile', async () => {
    for (const options of [{ fail: true }, { username: 'someone_else' }]) {
        const f = fixture(options);
        const response = await handleRequest(new Request('https://api.example/api/tiktok'), f.env);
        assert.equal(response.status, 503);
        assert.equal((await response.text()).includes('secret-upstream-detail'), false);
        assert.equal(await f.storage.get('latest'), undefined);
    }
});
