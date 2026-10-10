import { readFile, mkdir, writeFile } from 'node:fs/promises';

// Run with --env-file=.env. Never print credential values or pass them as CLI arguments.
const saved = JSON.parse(await readFile(new URL('../.local/tiktok-token.json', import.meta.url), 'utf8'));
if (!process.env.TIKTOK_CLIENT_KEY || !process.env.TIKTOK_CLIENT_SECRET || !saved.refreshToken) throw new Error('TikTok is not connected');
await mkdir(new URL('../.local/', import.meta.url), { recursive: true });
await writeFile(new URL('../.local/cloudflare-secrets.json', import.meta.url), JSON.stringify({
    TIKTOK_CLIENT_KEY: process.env.TIKTOK_CLIENT_KEY,
    TIKTOK_CLIENT_SECRET: process.env.TIKTOK_CLIENT_SECRET,
    TIKTOK_TOKEN_SEED: JSON.stringify({ accessToken: saved.accessToken, refreshToken: saved.refreshToken, expiresAt: saved.expiresAt, scopes: saved.scopes }),
}), { mode: 0o600 });
console.log('Cloudflare secrets prepared in ignored .local directory.');
