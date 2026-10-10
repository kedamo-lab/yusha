(() => {
    const wipe = document.createElement('div');
    wipe.className = 'page-wipe';
    wipe.setAttribute('aria-hidden', 'true');
    document.body.append(wipe);
    document.addEventListener('click', (event) => {
        const link = event.target.closest('a[data-page-link]');
        if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        if (matchMedia('(prefers-reduced-motion: reduce)').matches || 'onpagereveal' in window) return;
        event.preventDefault();
        if (document.documentElement.classList.contains('is-leaving')) return;
        document.documentElement.classList.add('is-leaving');
        window.setTimeout(() => location.assign(link.href), 460);
    });
    window.addEventListener('pageshow', () => document.documentElement.classList.remove('is-leaving'));
})();
