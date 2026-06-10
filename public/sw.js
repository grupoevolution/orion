// Orion PWA Service Worker v3.0 — push de eventos de venda e resumos (notificações de instância removidas)
const CACHE_NAME = 'orion-v3-0';

self.addEventListener('install', e => {
    self.skipWaiting();
});

self.addEventListener('activate', e => {
    e.waitUntil(clients.claim());
});

// Push notifications
self.addEventListener('push', e => {
    if (!e.data) return;
    let data;
    try { data = e.data.json(); } catch { data = { title: 'Orion', body: e.data.text() }; }

    // Vibração: alerta feminino tem pattern distinto pra ser reconhecido sem olhar a tela
    let vibrate = [200, 50, 200];
    if (data.isFemale) vibrate = [100, 50, 100, 50, 100, 50, 300];
    else if (data.highValue) vibrate = [500, 100, 500];

    const options = {
        body: data.body,
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        // Tag distinta separa stack de notificações no iOS (feminino não sobrescreve venda normal)
        tag: data.isFemale ? (data.type + '-female') : (data.highValue ? (data.type + '-high') : (data.type || 'orion-notif')),
        requireInteraction: data.isFemale,
        vibrate,
        silent: false,
        data: { url: '/mobile.html', type: data.type, timestamp: data.timestamp, isFemale: !!data.isFemale, highValue: !!data.highValue }
    };

    e.waitUntil(self.registration.showNotification(data.title, options));
});

self.addEventListener('notificationclick', e => {
    e.notification.close();
    const url = e.notification.data?.url || '/mobile.html';
    e.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
            const orionClient = list.find(c => c.url.includes('mobile.html') || c.url.includes(self.location.origin));
            if (orionClient) return orionClient.focus();
            return clients.openWindow(url);
        })
    );
});

self.addEventListener('message', e => {
    if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
