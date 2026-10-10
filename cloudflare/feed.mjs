const USERNAME = 'yusshhik';
const CACHE_MS = 60000;
const VIDEO_FIELDS = 'id,title,video_description,create_time,cover_image_url,duration,view_count';

// Storage belongs to one private SQLite Durable Object, shared by all visitors.
export class Feed {
    constructor(storage, env, fetchImpl = fetch, now = Date.now) {
        this.storage = storage;
        this.env = env;
        // Cloudflare's native fetch rejects a method receiver; call it as a function.
        this.fetchImpl = (...args) => fetchImpl(...args);
        this.now = now;
        this.cache = new Map();
        this.pending = new Map();
        this.ready = this.load();
    }

    async load() {
        const stored = await this.storage.get('auth');
        // The bootstrap secret is consumed only once. Rotated tokens always win.
        if (stored) this.auth = stored;
        else {
            const seed = JSON.parse(this.env.TIKTOK_TOKEN_SEED || '{}');
            if (!seed.accessToken || !seed.refreshToken || !Number.isFinite(seed.expiresAt)) throw new Error('missing_tokens');
            this.auth = { accessToken: seed.accessToken, refreshToken: seed.refreshToken, expiresAt: seed.expiresAt, scopes: seed.scopes || 'user.info.basic,video.list' };
            await this.storage.put('auth', this.auth);
        }
        const cached = await this.storage.get('latest');
        if (cached) this.cache.set('latest', cached);
    }

    async refresh() {
        if (this.refreshPending) return this.refreshPending;
        this.refreshPending = (async () => {
            const response = await this.fetchImpl('https://open.tiktokapis.com/v2/oauth/token/', {
                method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ client_key: this.env.TIKTOK_CLIENT_KEY, client_secret: this.env.TIKTOK_CLIENT_SECRET, grant_type: 'refresh_token', refresh_token: this.auth.refreshToken }),
                signal: AbortSignal.timeout(10000),
            });
            const data = await response.json();
            if (!response.ok || data.error || typeof data.access_token !== 'string' || !data.access_token || !(Number(data.expires_in) > 0)) throw new Error('refresh_failed');
            const next = {
                accessToken: data.access_token, refreshToken: data.refresh_token || this.auth.refreshToken,
                expiresAt: this.now() + Number(data.expires_in) * 1000, scopes: data.scope || this.auth.scopes,
            };
            await this.storage.put('auth', next);
            this.auth = next;
        })();
        try { await this.refreshPending; } finally { this.refreshPending = null; }
    }

    async request(path, body, retry = true) {
        if (this.auth.expiresAt < this.now() + CACHE_MS) await this.refresh();
        const usedToken = this.auth.accessToken;
        const response = await this.fetchImpl(`https://open.tiktokapis.com${path}`, {
            method: body ? 'POST' : 'GET',
            headers: { Authorization: `Bearer ${usedToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
            ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000),
        });
        if (response.status === 401 && retry) {
            if (this.auth.accessToken === usedToken) await this.refresh();
            return this.request(path, body, false);
        }
        const data = await response.json().catch(() => { throw new Error(`upstream_json_${response.status}`); });
        if (!response.ok || (data.error && data.error.code !== 'ok')) {
            const codes = new Set(['access_token_invalid', 'scope_not_authorized', 'rate_limit_exceeded', 'invalid_params', 'invalid_request', 'internal_error', 'invalid_token', 'unauthorized']);
            const code = codes.has(data.error?.code) ? data.error.code : 'unknown';
            throw new Error(`upstream_${response.status}_${code}`);
        }
        return data.data;
    }

    async get(cursor = null) {
        await this.ready;
        const key = cursor || 'latest';
        const cached = this.cache.get(key);
        if (cached && this.now() - cached.savedAt < CACHE_MS) return cached.value;
        if (this.pending.has(key)) return this.pending.get(key);
        const task = (async () => {
            const scopes = new Set(this.auth.scopes.split(','));
            const fields = ['avatar_url', 'display_name'];
            if (scopes.has('user.info.profile')) fields.push('username', 'bio_description');
            if (scopes.has('user.info.stats')) fields.push('follower_count', 'following_count', 'likes_count');
            const [profile, list] = await Promise.all([
                this.request(`/v2/user/info/?fields=${fields.join(',')}`),
                this.request(`/v2/video/list/?fields=${VIDEO_FIELDS}`, { max_count: 20, ...(cursor ? { cursor: Number(cursor) } : {}) }),
            ]);
            const user = profile?.user;
            if (!user || !Array.isArray(list?.videos) || (user.username && user.username.toLowerCase() !== USERNAME)) throw new Error('invalid_profile');
            const value = {
                mode: 'live', updatedAt: new Date(this.now()).toISOString(),
                profile: { username: USERNAME, displayName: user.display_name, avatarUrl: user.avatar_url, bio: user.bio_description, followers: user.follower_count, following: user.following_count, likes: user.likes_count },
                videos: list.videos.filter(video => typeof video.id === 'string' && /^\d{10,25}$/.test(video.id)).map(video => ({
                    id: video.id, title: video.title || video.video_description || '', createdAt: video.create_time,
                    coverUrl: video.cover_image_url, duration: video.duration, views: video.view_count,
                })),
                cursor: list.cursor, hasMore: Boolean(list.has_more),
            };
            const entry = { value, savedAt: this.now() };
            if (key === 'latest') await this.storage.put('latest', entry);
            if (this.cache.size >= 40 && !this.cache.has(key)) this.cache.delete(this.cache.keys().next().value);
            this.cache.set(key, entry);
            return value;
        })();
        this.pending.set(key, task);
        try { return await task; } finally { this.pending.delete(key); }
    }
}

export async function handleRequest(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const headers = {
        'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'Vary': 'Origin',
    };
    const respond = (status, body) => new Response(request.method === 'HEAD' ? null : JSON.stringify(body), { status, headers });
    if (origin && origin !== env.SITE_ORIGIN) return respond(403, { error: 'origin_not_allowed' });
    if (origin) headers['Access-Control-Allow-Origin'] = origin;
    if (url.pathname !== '/api/tiktok') return respond(404, { error: 'not_found' });
    if (request.method === 'OPTIONS') {
        headers['Access-Control-Allow-Methods'] = 'GET, HEAD, OPTIONS';
        headers['Access-Control-Max-Age'] = '86400';
        return new Response(null, { status: 204, headers });
    }
    if (!['GET', 'HEAD'].includes(request.method)) {
        headers.Allow = 'GET, HEAD, OPTIONS';
        return respond(405, { error: 'method_not_allowed' });
    }
    const cursor = url.searchParams.get('cursor');
    if (cursor !== null && (!/^\d{1,16}$/.test(cursor) || !Number.isSafeInteger(Number(cursor)))) return respond(400, { error: 'invalid_cursor' });
    try {
        return respond(200, await env.TIKTOK_FEED.getByName(USERNAME).getFeed(cursor));
    } catch (error) {
        const reason = /^(upstream_(?:json_)?\d{3}(?:_[a-z_]+)?|missing_tokens|refresh_failed|invalid_profile)$/.test(error.message) ? error.message : 'internal_failure';
        console.warn('TikTok API unavailable:', reason);
        return respond(503, { error: 'tiktok_unavailable', message: 'Не удалось обновить TikTok. Попробуйте позже.' });
    }
}
