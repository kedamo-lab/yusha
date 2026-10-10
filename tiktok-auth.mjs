import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function tokenSeed({ accessToken = '', refreshToken = '', clientKey = '', clientSecret = '' }) {
    return createHash('sha256').update(refreshToken || accessToken || `${clientKey}:${clientSecret}`).digest('hex');
}

export async function saveTokens(tokenStore, auth, seed) {
    await mkdir(dirname(tokenStore), { recursive: true });
    await writeFile(`${tokenStore}.tmp`, JSON.stringify({ ...auth, seed }), { mode: 0o600 });
    await rename(`${tokenStore}.tmp`, tokenStore);
}

// This setup listener runs only on loopback, separately from the public website.
export function createTikTokConnector({ clientKey, clientSecret, tokenStore, seed, scopes = 'user.info.basic,video.list,user.info.profile,user.info.stats', fetchImpl = fetch, onConnected = () => {} }) {
    const sessions = new Map();
    const setupKey = randomBytes(24).toString('hex');
    let completed = false;
    const server = createServer(async (req, res) => {
        const origin = `http://127.0.0.1:${server.address().port}`;
        const url = new URL(req.url, origin);
        const page = (status, message, connect = false) => {
            res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': connect ? 'same-origin' : 'no-referrer', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://www.tiktok.com; base-uri 'none'; frame-ancestors 'none'", 'X-Content-Type-Options': 'nosniff' });
            res.end(`<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>YUSHA · TikTok</title><style>body{background:#18090d;color:#fff4dd;font:18px system-ui;max-width:650px;margin:12vh auto;padding:24px;line-height:1.6}button,a{color:inherit}button{background:#df2d52;border:0;padding:16px 24px;border-radius:12px;font:inherit;cursor:pointer}</style><h1>YUSHA × TikTok</h1><p>${message}</p>${connect ? `<form method="post" action="/connect?key=${setupKey}"><button>Подключить @yusshhik</button></form>` : '<p><a href="http://127.0.0.1:4173/clips.html">Открыть ленту сайта</a></p>'}</html>`);
        };
        if (req.headers.host !== new URL(origin).host || !['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) { page(403, 'Недопустимый адрес подключения.'); return; }
        if (req.method === 'GET' && url.pathname === '/') {
            page(200, completed ? 'TikTok подключён. Перезапусти сервер сайта, чтобы загрузить актуальные видео.' : 'Войди как @yusshhik и разреши чтение профиля, статистики и публичных видео. Токены останутся на этом компьютере.', !completed);
            return;
        }
        if (req.method === 'POST' && url.pathname === '/connect') {
            if (completed || url.searchParams.get('key') !== setupKey || req.headers.origin !== origin) { page(403, 'Открой страницу подключения заново.'); return; }
            for (const [key, session] of sessions) if (session.expiresAt < Date.now()) sessions.delete(key);
            if (sessions.size >= 10) { page(429, 'Слишком много попыток. Повтори позже.'); return; }
            const state = randomBytes(32).toString('hex');
            const verifier = randomBytes(32).toString('hex');
            sessions.set(state, { verifier, expiresAt: Date.now() + 10 * 60000 });
            const authorize = new URL('https://www.tiktok.com/v2/auth/authorize/');
            authorize.search = new URLSearchParams({ client_key: clientKey, scope: scopes, response_type: 'code', redirect_uri: `${origin}/callback/`, state, code_challenge: createHash('sha256').update(verifier).digest('hex'), code_challenge_method: 'S256', disable_auto_auth: '1' });
            res.writeHead(303, { Location: authorize.href, 'Cache-Control': 'no-store', 'Set-Cookie': `yusha_tiktok_state=${state}; HttpOnly; SameSite=Lax; Path=/callback/; Max-Age=600` });
            res.end(); return;
        }
        if (req.method === 'GET' && url.pathname === '/callback/') {
            const state = url.searchParams.get('state');
            const session = sessions.get(state);
            const cookie = (req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith('yusha_tiktok_state='))?.slice('yusha_tiktok_state='.length);
            if (!session || session.expiresAt < Date.now() || cookie !== state) { page(400, 'Проверка авторизации не пройдена. Начни подключение заново.'); return; }
            sessions.delete(state);
            res.setHeader('Set-Cookie', 'yusha_tiktok_state=; HttpOnly; SameSite=Lax; Path=/callback/; Max-Age=0');
            if (url.searchParams.has('error') || !url.searchParams.get('code')) { page(400, 'Доступ не предоставлен. Можно повторить подключение.'); return; }
            try {
                const response = await fetchImpl('https://open.tiktokapis.com/v2/oauth/token/', {
                    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({ client_key: clientKey, client_secret: clientSecret, grant_type: 'authorization_code', code: url.searchParams.get('code'), redirect_uri: `${origin}/callback/`, code_verifier: session.verifier }).toString(), signal: AbortSignal.timeout(10000),
                });
                const payload = await response.json();
                if (!response.ok || payload.error || !payload.access_token || !payload.refresh_token) throw new Error('exchange_failed');
                const granted = new Set((payload.scope || '').split(','));
                if (!['user.info.basic', 'video.list', 'user.info.profile'].every(scope => granted.has(scope))) throw new Error('scopes_missing');
                const profileResponse = await fetchImpl('https://open.tiktokapis.com/v2/user/info/?fields=username', { headers: { Authorization: `Bearer ${payload.access_token}` }, signal: AbortSignal.timeout(10000) });
                const profile = await profileResponse.json();
                if (!profileResponse.ok || profile.data?.user?.username?.toLowerCase() !== 'yusshhik') { page(400, 'Нужен профиль @yusshhik. Токены другого аккаунта не сохранены.'); return; }
                await saveTokens(tokenStore, { accessToken: payload.access_token, refreshToken: payload.refresh_token, expiresAt: Date.now() + Number(payload.expires_in || 86400) * 1000, scopes: payload.scope }, seed);
                completed = true;
                sessions.clear();
                page(200, 'Профиль @yusshhik подключён. Токен сохранён в приватном хранилище; сервер будет продлевать его автоматически. Перезапусти сервер сайта.');
                onConnected();
            } catch { page(502, 'TikTok не завершил подключение. Проверь настройки Sandbox и попробуй заново.'); }
            return;
        }
        page(404, 'Страница не найдена.');
    });
    return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const root = dirname(fileURLToPath(import.meta.url));
    const clientKey = process.env.TIKTOK_CLIENT_KEY;
    const clientSecret = process.env.TIKTOK_CLIENT_SECRET;
    if (!clientKey || !clientSecret) { console.error('Сначала укажи TIKTOK_CLIENT_KEY и TIKTOK_CLIENT_SECRET в .env.'); process.exitCode = 1; }
    else {
        const server = createTikTokConnector({ clientKey, clientSecret, tokenStore: join(root, '.local', 'tiktok-token.json'), seed: tokenSeed({ clientKey, clientSecret, accessToken: process.env.TIKTOK_ACCESS_TOKEN, refreshToken: process.env.TIKTOK_REFRESH_TOKEN }), onConnected: () => { console.log('TikTok connected: @yusshhik'); server.close(); } });
        server.listen(4789, '127.0.0.1', () => console.log('Connect: http://127.0.0.1:4789/'));
        server.on('error', error => { console.error(`Connector: ${error.code || 'startup_failed'}`); process.exitCode = 1; });
    }
}
