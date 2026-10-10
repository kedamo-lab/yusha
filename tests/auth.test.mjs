import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, unlink, rmdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createTikTokConnector, tokenSeed } from '../tiktok-auth.mjs';
import { createSiteServer } from '../server.mjs';

const credentials = { clientKey: 'test-key', clientSecret: 'test-secret' };
const scopes = 'user.info.basic,video.list,user.info.profile,user.info.stats';

async function listen(t, server) {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise(done => { server.close(done); server.closeAllConnections(); }));
    return `http://127.0.0.1:${server.address().port}`;
}
async function temporaryStore(t) {
    await mkdir(resolve('work'), { recursive: true });
    const dir = await mkdtemp(join(resolve('work'), 'auth-test-'));
    const path = join(dir, 'token.json');
    t.after(async () => { await unlink(path).catch(() => {}); await rmdir(dir); });
    return path;
}
async function authorize(base) {
    const landing = await fetch(base);
    assert.equal(landing.headers.get('Referrer-Policy'), 'same-origin');
    assert.ok(landing.headers.get('Content-Security-Policy').includes("form-action 'self' https://www.tiktok.com"));
    const page = await landing.text();
    const key = page.match(/action="\/connect\?key=([a-f0-9]+)"/)[1];
    const response = await fetch(`${base}/connect?key=${key}`, { method: 'POST', headers: { Origin: base }, redirect: 'manual' });
    assert.equal(response.status, 303);
    return { authorizeUrl: new URL(response.headers.get('Location')), cookie: response.headers.get('Set-Cookie').split(';')[0] };
}

test('local OAuth validates state, cookie, origin and PKCE; persists tokens and enables live feed after restart', async t => {
    const tokenStore = await temporaryStore(t);
    let tokenCalls = 0;
    let challenge;
    const fetchImpl = async (url, request) => {
        if (url.includes('/oauth/token/')) {
            tokenCalls++;
            const body = new URLSearchParams(request.body);
            assert.equal(body.get('client_secret'), credentials.clientSecret);
            assert.equal(body.get('grant_type'), 'authorization_code');
            assert.equal(body.get('code'), 'test-code');
            assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('hex'), challenge);
            return Response.json({ access_token: 'private-access', refresh_token: 'private-refresh', expires_in: 86400, scope: scopes });
        }
        assert.equal(request.headers.Authorization, 'Bearer private-access');
        return Response.json({ data: { user: { username: 'yusshhik', display_name: 'Yusshha' } }, error: { code: 'ok' } });
    };
    const base = await listen(t, createTikTokConnector({ ...credentials, tokenStore, seed: tokenSeed(credentials), fetchImpl }));
    assert.equal((await fetch(base + '/callback/?state=fake&code=test')).status, 400);
    assert.equal((await fetch(base + '/connect?key=fake', { method: 'POST', headers: { Origin: 'https://evil.example' } })).status, 403);
    const { authorizeUrl, cookie } = await authorize(base);
    assert.equal(authorizeUrl.origin, 'https://www.tiktok.com');
    assert.equal(authorizeUrl.searchParams.get('redirect_uri'), base + '/callback/');
    assert.equal(authorizeUrl.searchParams.get('code_challenge_method'), 'S256');
    challenge = authorizeUrl.searchParams.get('code_challenge');
    const callback = `${base}/callback/?state=${authorizeUrl.searchParams.get('state')}&code=test-code`;
    assert.equal((await fetch(callback)).status, 400);
    assert.equal(tokenCalls, 0);
    const connected = await fetch(callback, { headers: { Cookie: cookie } });
    assert.equal(connected.status, 200);
    assert.equal(connected.headers.get('Referrer-Policy'), 'no-referrer');
    assert.ok(!(await connected.text()).includes('private-access'));
    const saved = JSON.parse(await readFile(tokenStore, 'utf8'));
    assert.equal(saved.scopes, scopes);
    assert.equal(saved.refreshToken, 'private-refresh');
    assert.equal((await fetch(callback, { headers: { Cookie: cookie } })).status, 400);
    assert.equal(tokenCalls, 1);
    const site = await listen(t, createSiteServer({ ...credentials, tokenStore, fetchImpl: async url => Response.json({ data: url.includes('/user/info/') ? { user: { username: 'yusshhik', display_name: 'Yusshha', follower_count: 32 } } : { videos: [], has_more: false }, error: { code: 'ok' } }) }));
    const feed = await (await fetch(site + '/api/tiktok')).json();
    assert.equal(feed.mode, 'live');
    assert.equal(feed.profile.followers, 32);
    assert.equal((await fetch(site + '/tiktok-auth.mjs')).status, 404);
});

test('OAuth refuses another account and leaves no token file', async t => {
    const tokenStore = await temporaryStore(t);
    const base = await listen(t, createTikTokConnector({ ...credentials, tokenStore, seed: tokenSeed(credentials), fetchImpl: async url => Response.json(url.includes('/oauth/token/') ? { access_token: 'wrong-access', refresh_token: 'wrong-refresh', scope: scopes } : { data: { user: { username: 'another_user' } } }) }));
    const { authorizeUrl, cookie } = await authorize(base);
    const response = await fetch(`${base}/callback/?state=${authorizeUrl.searchParams.get('state')}&code=test`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 400);
    await assert.rejects(readFile(tokenStore), { code: 'ENOENT' });
});

test('denied consent never exchanges a code or writes credentials', async t => {
    const tokenStore = await temporaryStore(t);
    const base = await listen(t, createTikTokConnector({ ...credentials, tokenStore, seed: tokenSeed(credentials), fetchImpl: () => assert.fail('No exchange after denied consent') }));
    const { authorizeUrl, cookie } = await authorize(base);
    const response = await fetch(`${base}/callback/?state=${authorizeUrl.searchParams.get('state')}&error=access_denied`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 400);
    await assert.rejects(readFile(tokenStore), { code: 'ENOENT' });
});
