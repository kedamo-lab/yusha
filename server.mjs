import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tokenSeed, saveTokens } from './tiktok-auth.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC_FILES = new Set(['index.html', 'clips.html', 'clips.css', 'clips.js', 'privacy.html', 'terms.html', 'legal.css', 'tiktok-config.js', 'tiktok-videos.json', 'page-transition.css', 'page-transition.js', 'favicon.png', 'hero.png', 'hero2.png', 'mockup.jpg']);
const MIME = { html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', json: 'application/json; charset=utf-8', png: 'image/png', jpg: 'image/jpeg' };
const VIDEO_FIELDS = 'id,title,video_description,create_time,cover_image_url,duration,view_count';

export function createSiteServer(options = {}) {
    const {
        root = ROOT, accessToken = '', refreshToken = '', clientKey = '', clientSecret = '',
        scopes = 'user.info.basic,video.list', fetchImpl = fetch, cacheMs = 60000,
        tokenStore = null, catalogPath = null,
    } = options;
    const auth = { accessToken, refreshToken, expiresAt: accessToken ? Infinity : 0, scopes };
    const seed = tokenSeed({ accessToken, refreshToken, clientKey, clientSecret });
    const cache = new Map();
    const pending = new Map();
    let refreshPending;
    let catalogCache;
    let catalogPending;

    async function getCatalog() {
        if (!catalogPath) return { mode: 'embed', profile: { username: 'yusshhik', displayName: 'Yusshha' }, videos: [] };
        if (catalogCache && Date.now() - catalogCache.savedAt < 1800000) return catalogCache.value;
        if (catalogPending) return catalogPending;
        catalogPending = (async () => {
            const saved = JSON.parse(await readFile(catalogPath, 'utf8'));
            const videos = await Promise.all(saved.videos.filter((video) => /^\d{10,25}$/.test(video.id)).slice(0, 20).map(async (video) => {
                try {
                    const sourceUrl = `https://www.tiktok.com/@yusshhik/video/${video.id}`;
                    const response = await fetchImpl(`https://www.tiktok.com/oembed?url=${encodeURIComponent(sourceUrl)}`, { signal: AbortSignal.timeout(10000) });
                    if (!response.ok) return video;
                    const data = await response.json();
                    if (data.author_url !== 'https://www.tiktok.com/@yusshhik') return video;
                    return { ...video, title: data.title || video.title, coverUrl: data.thumbnail_url || video.coverUrl };
                } catch { return video; }
            }));
            const value = { mode: 'catalog', updatedAt: saved.updatedAt, profile: { username: 'yusshhik', displayName: 'Yusshha' }, videos, hasMore: false };
            catalogCache = { value, savedAt: Date.now() };
            return value;
        })();
        try { return await catalogPending; } finally { catalogPending = null; }
    }

    const authReady = (async () => {
        if (!tokenStore || (!accessToken && !refreshToken && !(clientKey && clientSecret))) return;
        try {
            const stored = JSON.parse(await readFile(tokenStore, 'utf8'));
            if (stored.seed === seed && typeof stored.accessToken === 'string' && typeof stored.refreshToken === 'string') Object.assign(auth, stored);
        } catch { /* First run, changed credentials, or unavailable local state. */ }
    })();

    async function refreshAccess() {
        if (!auth.refreshToken || !clientKey || !clientSecret) throw new Error('token_expired');
        if (refreshPending) return refreshPending;
        refreshPending = (async () => {
            const response = await fetchImpl('https://open.tiktokapis.com/v2/oauth/token/', {
                method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ client_key: clientKey, client_secret: clientSecret, grant_type: 'refresh_token', refresh_token: auth.refreshToken }).toString(),
                signal: AbortSignal.timeout(10000),
            });
            const payload = await response.json();
            if (!response.ok || typeof payload.access_token !== 'string' || payload.error) throw new Error('token_refresh_failed');
            auth.accessToken = payload.access_token;
            auth.refreshToken = payload.refresh_token || auth.refreshToken;
            auth.expiresAt = Date.now() + Number(payload.expires_in || 86400) * 1000;
            if (typeof payload.scope === 'string') auth.scopes = payload.scope;
            if (tokenStore) {
                await saveTokens(tokenStore, auth, seed);
            }
            return auth.accessToken;
        })();
        try { return await refreshPending; } finally { refreshPending = null; }
    }

    async function requestTikTok(path, body, retry = true) {
        await authReady;
        if (!auth.accessToken || auth.expiresAt < Date.now() + 60000) await refreshAccess();
        const usedToken = auth.accessToken;
        const response = await fetchImpl(`https://open.tiktokapis.com${path}`, {
            method: body ? 'POST' : 'GET',
            headers: { Authorization: `Bearer ${auth.accessToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
            ...(body ? { body: JSON.stringify(body) } : {}),
            signal: AbortSignal.timeout(10000),
        });
        if (response.status === 401 && retry && auth.refreshToken) {
            if (auth.accessToken === usedToken) await refreshAccess();
            return requestTikTok(path, body, false);
        }
        const payload = await response.json();
        if (!response.ok || (payload.error && payload.error.code !== 'ok')) throw new Error('tiktok_unavailable');
        return payload.data;
    }

    async function getFeed(cursor) {
        const key = cursor || 'latest';
        const cached = cache.get(key);
        if (cached && Date.now() - cached.savedAt < cacheMs) return cached.value;
        if (pending.has(key)) return pending.get(key);
        const task = (async () => {
            await authReady;
            const granted = new Set(auth.scopes.split(',').map(scope => scope.trim()));
            const fields = ['avatar_url', 'display_name'];
            if (granted.has('user.info.profile')) fields.push('username', 'bio_description');
            if (granted.has('user.info.stats')) fields.push('follower_count', 'following_count', 'likes_count');
            const [userData, videoData] = await Promise.all([
                requestTikTok(`/v2/user/info/?fields=${fields.join(',')}`),
                requestTikTok(`/v2/video/list/?fields=${VIDEO_FIELDS}`, { max_count: 20, ...(cursor ? { cursor: Number(cursor) } : {}) }),
            ]);
            const user = userData?.user;
            if (!user || !Array.isArray(videoData?.videos)) throw new Error('invalid_tiktok_response');
            if (user.username && user.username.toLowerCase() !== 'yusshhik') throw new Error('profile_mismatch');
            const value = {
                mode: 'live', updatedAt: new Date().toISOString(),
                profile: {
                    username: 'yusshhik', displayName: user.display_name, avatarUrl: user.avatar_url,
                    bio: user.bio_description, followers: user.follower_count,
                    following: user.following_count, likes: user.likes_count,
                },
                videos: videoData.videos.filter((video) => /^\d{10,25}$/.test(video.id)).map((video) => ({
                    id: video.id, title: video.title || video.video_description || '', createdAt: video.create_time,
                    coverUrl: video.cover_image_url, duration: video.duration, views: video.view_count,
                })),
                cursor: videoData.cursor, hasMore: Boolean(videoData.has_more),
            };
            if (cache.size >= 40 && !cache.has(key)) cache.delete(cache.keys().next().value);
            cache.set(key, { value, savedAt: Date.now() });
            return value;
        })();
        pending.set(key, task);
        try { return await task; } finally { pending.delete(key); }
    }

    return createServer(async (req, res) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
        const json = (status, payload) => {
            res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(req.method === 'HEAD' ? undefined : JSON.stringify(payload));
        };
        try {
            const url = new URL(req.url, 'http://localhost');
            if (!['GET', 'HEAD'].includes(req.method)) { res.setHeader('Allow', 'GET, HEAD'); json(405, { error: 'method_not_allowed' }); return; }
            if (url.pathname === '/api/tiktok') {
                const cursor = url.searchParams.get('cursor');
                if (cursor !== null && !/^\d{1,16}$/.test(cursor)) { json(400, { error: 'invalid_cursor' }); return; }
                await authReady;
                if (!auth.accessToken && !auth.refreshToken) { json(200, await getCatalog()); return; }
                try { json(200, await getFeed(cursor)); }
                catch { json(503, { error: 'tiktok_unavailable', message: 'Не удалось обновить TikTok. Попробуйте позже.' }); }
                return;
            }
            const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
            if (!PUBLIC_FILES.has(file)) { json(404, { error: 'not_found' }); return; }
            const data = await readFile(join(root, file));
            res.writeHead(200, { 'Content-Type': MIME[file.split('.').pop()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
            res.end(req.method === 'HEAD' ? undefined : data);
        } catch { json(500, { error: 'server_error' }); }
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const port = Number(process.env.PORT || 4173);
    const host = process.env.HOST || '127.0.0.1';
    const server = createSiteServer({
        accessToken: process.env.TIKTOK_ACCESS_TOKEN,
        refreshToken: process.env.TIKTOK_REFRESH_TOKEN,
        clientKey: process.env.TIKTOK_CLIENT_KEY,
        clientSecret: process.env.TIKTOK_CLIENT_SECRET,
        scopes: process.env.TIKTOK_SCOPES || 'user.info.basic,video.list',
        tokenStore: join(ROOT, '.local', 'tiktok-token.json'),
        catalogPath: join(ROOT, 'tiktok-videos.json'),
    });
    server.listen(port, host, () => console.log(`Local: http://${host}:${port}`));
    server.on('error', (error) => { console.error(`Server: ${error.code || 'startup_failed'}`); process.exitCode = 1; });
}
