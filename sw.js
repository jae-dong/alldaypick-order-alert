importScripts('https://www.gstatic.com/firebasejs/11.10.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/11.10.0/firebase-messaging-compat.js');

firebase.initializeApp({"apiKey": "AIzaSyCFRmQPRvYznJV-MTzKb__SpYDfvMpmgAo", "authDomain": "alldaypick-order-alert.firebaseapp.com", "projectId": "alldaypick-order-alert", "storageBucket": "alldaypick-order-alert.firebasestorage.app", "messagingSenderId": "549342074740", "appId": "1:549342074740:web:c003e0eb0e75097008be21"});
const messaging = firebase.messaging();

messaging.onBackgroundMessage(payload => {
  const title =
    payload.notification?.title ||
    payload.data?.title ||
    '올데이픽 주문알림';

  const options = {
    body:
      payload.notification?.body ||
      payload.data?.body ||
      '새 알림이 도착했습니다.',

    icon: './icon.svg',
    badge: './icon.svg',
    tag: payload.data?.orderId || 'alldaypick-order',
    renotify: true,
    vibrate: [200, 100, 200],

    data: {
      url:
        payload.data?.url ||
        'https://jae-dong.github.io/alldaypick-order-alert/'
    }
  };

  self.registration.showNotification(title, options);
});

self.addEventListener('notificationclick', event => {
  event.notification.close();

  const url =
    event.notification.data?.url ||
    'https://jae-dong.github.io/alldaypick-order-alert/';

  event.waitUntil(
    clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then(list => {
        for (const client of list) {
          if ('focus' in client) {
            client.navigate(url);
            return client.focus();
          }
        }

        return clients.openWindow(url);
      })
  );
});

const CACHE = 'order-alert-v22';
const ASSETS = ['./', './index.html', './manifest.json', './icon.svg'];

self.addEventListener('install', event => {
  self.skipWaiting();

  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(ASSETS))
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    Promise.all([
      self.clients.claim(),

      caches
        .keys()
        .then(keys =>
          Promise.all(
            keys
              .filter(key => key !== CACHE)
              .map(key => caches.delete(key))
          )
        )
    ])
  );
});

self.addEventListener('fetch', event => {
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() => caches.match('./index.html'))
    );
    return;
  }

  event.respondWith(
    caches
      .match(event.request)
      .then(cached => cached || fetch(event.request))
  );
});

