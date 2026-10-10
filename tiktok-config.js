// Public settings only. TikTok access tokens belong on the server, never here.
window.YUSHA_TIKTOK = Object.freeze({
    username: 'yusshhik',
    displayName: 'Yusshha',
    apiUrl: ['localhost', '127.0.0.1'].includes(location.hostname)
        ? './api/tiktok'
        : 'https://yusha-tiktok-api.yusha-site.workers.dev/api/tiktok',
    pollInterval: 60000,
});
