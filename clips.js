(() => {
    'use strict';
    const config = window.YUSHA_TIKTOK;
    const $ = (id) => document.getElementById(id);
    const username = config.username;
    const profileUrl = `https://www.tiktok.com/@${encodeURIComponent(username)}`;
    const number = new Intl.NumberFormat('ru-RU', { notation: 'compact', maximumFractionDigits: 1 });
    const date = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
    const demoVideos = [
        { id: 'preview-1', title: 'После стрима', label: 'AFTER\nHOURS.', art: 1 },
        { id: 'preview-2', title: 'На своей волне', label: 'OWN\nVIBE.', art: 2 },
        { id: 'preview-3', title: 'Тот самый момент', label: 'ONE\nMORE.', art: 3 },
        { id: 'preview-4', title: 'Ночной режим', label: 'NIGHT\nSHIFT.', art: 4 },
    ].map((video) => ({ ...video, demo: true }));
    const state = { videos: demoVideos, mode: 'preview', live: false, cursor: null, hasMore: false, loading: false, current: 0, tab: 'feed', newIds: new Set() };
    const storageKey = `yusha-tiktok:${username}`;
    let knownIds = null;
    let toastTimeout;
    let observer;
    let returnFocus;
    let embedStarted = false;

    try {
        const stored = JSON.parse(localStorage.getItem(storageKey) || 'null');
        if (Array.isArray(stored?.known)) knownIds = new Set(stored.known);
        if (Array.isArray(stored?.unread)) state.newIds = new Set(stored.unread);
    } catch { /* Private browsing can make storage unavailable. */ }

    const icon = (name, className = '') => {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', `icon ${className}`);
        svg.setAttribute('aria-hidden', 'true');
        const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
        use.setAttribute('href', `#i-${name}`);
        svg.append(use);
        return svg;
    };
    const element = (tag, className, text) => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    };
    const safeHttps = (value) => {
        try { const url = new URL(value); return url.protocol === 'https:' ? url.href : ''; } catch { return ''; }
    };
    const persist = () => {
        try { localStorage.setItem(storageKey, JSON.stringify({ known: [...(knownIds || [])].slice(-500), unread: [...state.newIds].slice(-100) })); } catch { /* Optional persistence. */ }
    };
    const announce = (message) => {
        clearTimeout(toastTimeout);
        $('toast').textContent = message;
        $('toast').hidden = false;
        toastTimeout = setTimeout(() => { $('toast').hidden = true; }, 6000);
    };
    const setStatus = (text, type = '') => {
        $('sync-label').textContent = text;
        $('sync-status').className = `sync-status ${type}`;
    };
    const selectTab = (tab, moveFocus = false) => {
        state.tab = tab;
        history.replaceState(null, '', tab === 'profile' ? '#profile' : '#videos');
        for (const name of ['feed', 'profile']) {
            const active = name === tab;
            $(`tab-${name}`).classList.toggle('is-active', active);
            $(`tab-${name}`).setAttribute('aria-selected', String(active));
            $(`tab-${name}`).tabIndex = active ? 0 : -1;
            $(`${name}-panel`).hidden = !active;
        }
        if (moveFocus) $(`tab-${tab}`).focus();
        if (tab === 'profile') loadCreatorEmbed();
    };
    const loadCreatorEmbed = () => {
        if (embedStarted) return;
        embedStarted = true;
        const script = document.createElement('script');
        script.src = 'https://www.tiktok.com/embed.js';
        script.async = true;
        script.onerror = () => { $('embed-help').textContent = 'TikTok не загрузился. Попробуй ещё раз или открой профиль по ссылке выше.'; };
        document.body.append(script);
    };
    const demoArt = (video) => {
        const art = element('div', `card-art demo-art demo-${video.art}`);
        const image = element('img');
        image.src = video.art === 2 || video.art === 4 ? 'hero.png' : 'hero2.png';
        image.alt = '';
        image.loading = 'lazy';
        art.append(image);
        return art;
    };
    const renderGrid = () => {
        const fragment = document.createDocumentFragment();
        for (const [index, video] of state.videos.entries()) {
            const card = element('button', 'video-card');
            card.type = 'button';
            card.dataset.videoId = video.id;
            card.setAttribute('aria-label', `${video.demo ? 'Превью: ' : 'Смотреть: '}${video.title || 'Видео'}`);
            const art = video.demo ? demoArt(video) : element('div', 'card-art');
            if (!video.demo && safeHttps(video.coverUrl)) {
                const image = element('img');
                image.src = safeHttps(video.coverUrl);
                image.alt = '';
                image.loading = 'lazy';
                image.referrerPolicy = 'no-referrer';
                image.onerror = () => image.remove();
                art.append(image);
            }
            const play = element('span', 'card-play');
            play.append(icon('play'));
            art.append(play);
            if (video.demo) {
                const label = element('span', 'card-demo-label', video.label);
                label.style.whiteSpace = 'pre-line';
                art.append(label, element('span', 'card-badge', 'ПРЕВЬЮ'));
            } else if (state.newIds.has(video.id)) art.append(element('span', 'card-badge', 'НОВОЕ'));
            const bottom = element('span', 'card-bottom');
            if (video.demo) bottom.append(element('span', '', 'Листай и смотри'));
            else {
                if (Number.isFinite(video.views)) bottom.append(icon('play'), element('span', '', number.format(video.views)));
                else bottom.append(element('span', '', '@yusshhik'));
                if (video.duration) bottom.append(element('span', 'card-duration', `${Math.floor(video.duration / 60)}:${String(video.duration % 60).padStart(2, '0')}`));
            }
            art.append(bottom);
            card.append(art, element('h3', 'card-title', video.title || 'Видео без описания'));
            card.append(element('p', 'card-date', video.demo ? 'Превью дизайна · не публикация' : video.createdAt ? date.format(new Date(video.createdAt * 1000)) : 'TikTok'));
            card.addEventListener('click', () => openViewer(index));
            fragment.append(card);
        }
        $('video-grid').replaceChildren(fragment);
        $('empty-message').hidden = state.videos.length !== 0;
        $('new-count').textContent = String(state.newIds.size);
        $('new-count').hidden = !state.live || !state.newIds.size;
        $('load-more').hidden = !state.live || !state.hasMore;
    };
    const updateProfile = (profile) => {
        $('display-name').textContent = profile.displayName || config.displayName;
        const avatar = safeHttps(profile.avatarUrl);
        if (avatar) {
            $('profile-avatar').src = avatar;
            $('profile-avatar').onerror = () => { $('profile-avatar').onerror = null; $('profile-avatar').src = 'favicon.png'; };
        }
        $('profile-bio').textContent = profile.bio || '';
        $('profile-bio').hidden = !profile.bio;
        $('profile-stats').replaceChildren();
        for (const [key, label] of [['followers', 'подписчиков'], ['following', 'подписок'], ['likes', 'лайков']]) {
            if (!Number.isFinite(profile[key])) continue;
            const item = element('div');
            item.append(element('dt', '', label), element('dd', '', number.format(profile[key])));
            $('profile-stats').append(item);
        }
        $('profile-stats').hidden = !$('profile-stats').childElementCount;
    };
    const validVideos = (videos) => (Array.isArray(videos) ? videos : []).filter((v) => /^\d{10,25}$/.test(v.id) && typeof v.title === 'string');
    const useCatalog = (payload) => {
        const videos = validVideos(payload.videos);
        if (!videos.length || state.live) return;
        state.videos = videos;
        state.mode = 'catalog';
        $('feed-tab-label').textContent = 'Видео';
        $('feed-notice').querySelector('p').firstChild.textContent = 'Подборка из профиля. Самые свежие публикации — во вкладке ';
        $('feed-notice').querySelector('.preview-label').textContent = 'TIKTOK / SELECTION';
        setStatus('Подборка из TikTok');
        renderGrid();
    };
    const loadSavedCatalog = async () => {
        try {
            const response = await fetch('./tiktok-videos.json', { signal: AbortSignal.timeout(5000) });
            if (response.ok) useCatalog(await response.json());
        } catch { /* Design preview remains available offline. */ }
    };
    const syncFeed = async ({ more = false, manual = false } = {}) => {
        if (state.loading || (more && !state.hasMore)) return;
        state.loading = true;
        $('refresh-feed').disabled = true;
        $('refresh-feed').classList.add('is-loading');
        $('load-more').disabled = true;
        try {
            const url = new URL(config.apiUrl, location.href);
            if (more) url.searchParams.set('cursor', state.cursor);
            const response = await fetch(url, { signal: AbortSignal.timeout(15000), cache: 'no-store' });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const payload = await response.json();
            if (payload.mode === 'catalog') {
                useCatalog(payload);
                if (manual) announce('Подборка обновлена. Свежие публикации — во вкладке «Профиль TikTok».');
                return;
            }
            if (payload.mode !== 'live') {
                setStatus('TikTok-профиль');
                if (manual) {
                    selectTab('profile');
                    announce('Открыт встроенный TikTok-профиль. Обнови страницу, чтобы перезагрузить виджет.');
                }
                return;
            }
            const incoming = validVideos(payload.videos);
            const wasLive = state.live;
            const newlyFound = !more && knownIds ? incoming.filter((v) => !knownIds.has(v.id)) : [];
            if (!knownIds) knownIds = new Set();
            for (const video of incoming) knownIds.add(video.id);
            for (const video of newlyFound) state.newIds.add(video.id);
            const previous = state.live ? state.videos : [];
            state.videos = more
                ? [...previous, ...incoming.filter((v) => !previous.some((old) => old.id === v.id))]
                : [...incoming, ...previous.filter((v) => !incoming.some((fresh) => fresh.id === v.id) && payload.hasMore)];
            state.live = true;
            state.mode = 'live';
            if (more || !wasLive || previous.length <= incoming.length || !payload.hasMore) {
                state.cursor = payload.cursor;
                state.hasMore = Boolean(payload.hasMore);
            }
            updateProfile(payload.profile || {});
            $('feed-tab-label').textContent = 'Видео';
            $('feed-notice').hidden = true;
            persist();
            renderGrid();
            const checked = new Date(payload.updatedAt || Date.now()).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
            setStatus(`Обновлено ${checked}`, 'is-live');
            if (newlyFound.length) announce(`Новые ролики: ${newlyFound.length}. Они уже в начале ленты.`);
            else if (manual) announce(more ? 'Видео загружены' : 'Лента обновлена');
        } catch {
            if (state.live) setStatus('Не удалось обновить', 'has-error');
            else setStatus(state.mode === 'catalog' ? 'Подборка из TikTok' : 'TikTok-профиль');
            if (manual) announce(state.live ? 'Не удалось обновить ленту. Попробуй позже.' : 'Свежие публикации доступны во вкладке «Профиль TikTok».');
        } finally {
            state.loading = false;
            $('refresh-feed').disabled = false;
            $('refresh-feed').classList.remove('is-loading');
            $('load-more').disabled = false;
        }
    };

    const sendPlayer = (frame, type) => frame?.contentWindow?.postMessage({ type, 'x-tiktok-player': true }, 'https://www.tiktok.com');
    const markViewed = (video) => {
        if (video.demo || !state.newIds.delete(video.id)) return;
        persist();
        const card = [...$('video-grid').children].find((node) => node.dataset.videoId === video.id);
        card?.querySelector('.card-badge')?.remove();
        $('new-count').textContent = String(state.newIds.size);
        $('new-count').hidden = !state.newIds.size;
    };
    const activateSlide = (index) => {
        state.current = index;
        const slides = [...$('viewer-scroll').children];
        for (const [position, slide] of slides.entries()) {
            slide.inert = position !== index;
            let frame = slide.querySelector('iframe');
            const video = slide.videoData;
            if (position === index && !video.demo && !frame && !slide.dataset.playerFailed) {
                frame = element('iframe');
                frame.title = video.title || `Видео @${username}`;
                frame.src = `https://www.tiktok.com/player/v1/${video.id}?autoplay=1&loop=1&rel=0&description=1&music_info=1`;
                frame.allow = 'autoplay; fullscreen; encrypted-media; picture-in-picture';
                frame.allowFullscreen = true;
                frame.referrerPolicy = 'strict-origin-when-cross-origin';
                slide.querySelector('.viewer-player').append(frame);
            } else if (position !== index && frame) {
                sendPlayer(frame, 'pause');
                frame.remove(); // Unmount to reliably stop audio, even before player readiness.
            }
        }
        $('viewer-position').textContent = `${index + 1} / ${slides.length}`;
        $('previous-video').disabled = index === 0;
        $('next-video').disabled = index === slides.length - 1;
        markViewed(slides[index].videoData);
    };
    const openViewer = (index) => {
        if (!state.videos.length) return;
        returnFocus = document.activeElement;
        observer?.disconnect();
        const fragment = document.createDocumentFragment();
        for (const [position, video] of state.videos.entries()) {
            const slide = element('article', 'viewer-slide');
            slide.dataset.index = position;
            slide.videoData = video;
            slide.setAttribute('aria-label', `${position + 1}. ${video.title || 'Видео'}`);
            const player = element('div', 'viewer-player');
            if (video.demo) {
                player.append(demoArt(video));
                const copy = element('div', 'demo-viewer-copy');
                copy.append(element('span', '', 'ПРЕВЬЮ ИНТЕРФЕЙСА'), element('h2', '', video.title), element('p', '', 'Так будет выглядеть вертикальная лента. Здесь показан дизайн, настоящие ролики находятся в профиле TikTok.'));
                const link = element('a', '', 'Смотреть @yusshhik ↗');
                link.href = profileUrl;
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
                copy.append(link);
                player.append(copy);
            } else {
                const fallback = element('div', 'player-fallback', 'Если плеер не загрузился, открой ролик в TikTok.');
                const link = element('a', '', 'Открыть ролик ↗');
                link.href = `${profileUrl}/video/${video.id}`;
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
                fallback.append(link);
                player.append(fallback);
                const swipeZone = element('div', 'viewer-swipe-zone', 'Листай здесь ↕');
                swipeZone.setAttribute('aria-hidden', 'true');
                player.append(swipeZone);
            }
            slide.append(player);
            fragment.append(slide);
        }
        $('viewer-scroll').replaceChildren(fragment);
        $('viewer-title').textContent = state.mode === 'preview' ? 'ПРЕВЬЮ' : 'КЛИПЫ';
        $('video-dialog').showModal();
        document.body.classList.add('viewer-open');
        $('viewer-scroll').scrollTop = index * $('viewer-scroll').clientHeight;
        activateSlide(index);
        observer = new IntersectionObserver((entries) => {
            for (const entry of entries) if (entry.isIntersecting && entry.intersectionRatio > .6) activateSlide(Number(entry.target.dataset.index));
        }, { root: $('viewer-scroll'), threshold: .65 });
        [...$('viewer-scroll').children].forEach((slide) => observer.observe(slide));
        $('close-viewer').focus();
    };
    const stepVideo = (direction) => {
        const slides = [...$('viewer-scroll').children];
        const target = slides[state.current + direction];
        target?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
    };
    const cleanupViewer = () => {
        observer?.disconnect();
        for (const frame of $('viewer-scroll').querySelectorAll('iframe')) sendPlayer(frame, 'pause');
        $('viewer-scroll').replaceChildren();
        document.body.classList.remove('viewer-open');
        if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
        else $('watch-feed').focus({ preventScroll: true });
    };

    $('tab-feed').addEventListener('click', () => selectTab('feed'));
    $('tab-profile').addEventListener('click', () => selectTab('profile'));
    for (const tab of document.querySelectorAll('[role="tab"]')) tab.addEventListener('keydown', (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        selectTab(event.key === 'Home' ? 'feed' : event.key === 'End' ? 'profile' : state.tab === 'feed' ? 'profile' : 'feed', true);
    });
    $('show-profile-inline').addEventListener('click', () => selectTab('profile', true));
    $('watch-feed').addEventListener('click', () => openViewer(0));
    $('refresh-feed').addEventListener('click', () => {
        if (!state.live && state.tab === 'profile') location.reload();
        else syncFeed({ manual: true });
    });
    $('load-more').addEventListener('click', () => syncFeed({ more: true, manual: true }));
    $('close-viewer').addEventListener('click', () => $('video-dialog').close());
    $('video-dialog').addEventListener('close', cleanupViewer);
    $('previous-video').addEventListener('click', () => stepVideo(-1));
    $('next-video').addEventListener('click', () => stepVideo(1));
    $('video-dialog').addEventListener('keydown', (event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); stepVideo(event.key === 'ArrowDown' ? 1 : -1); }
    });
    window.addEventListener('message', (event) => {
        if (event.origin !== 'https://www.tiktok.com' || !event.data?.['x-tiktok-player']) return;
        const frame = $('viewer-scroll').children[state.current]?.querySelector('iframe');
        if (event.source !== frame?.contentWindow) return;
        if (event.data.type === 'onPlayerReady' && !document.hidden) sendPlayer(frame, 'play');
        if (event.data.type === 'onPlayerError' && event.data.value?.errorCode !== 3002) {
            const slide = $('viewer-scroll').children[state.current];
            slide.dataset.playerFailed = 'true';
            frame.remove();
        }
    });
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            for (const frame of $('viewer-scroll').querySelectorAll('iframe')) sendPlayer(frame, 'pause');
        } else {
            syncFeed();
            if ($('video-dialog').open) sendPlayer($('viewer-scroll').children[state.current]?.querySelector('iframe'), 'play');
        }
    });
    // Poll only while the visitor has the page open and visible.
    setInterval(() => { if (!document.hidden) syncFeed(); }, Math.max(config.pollInterval, 60000));
    renderGrid();
    if (location.hash === '#profile') selectTab('profile');
    loadSavedCatalog().finally(() => syncFeed());
})();
