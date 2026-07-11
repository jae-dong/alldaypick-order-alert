importScripts('https://www.gstatic.com/firebasejs/11.10.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/11.10.0/firebase-messaging-compat.js');

firebase.initializeApp({"apiKey": "AIzaSyCFRmQPRvYznJV-MTzKb__SpYDfvMpmsAo", "authDomain": "alldaypick-order-alert.firebaseapp.com", "projectId": "alldaypick-order-alert", "storageBucket": "alldaypick-order-alert.firebasestorage.app", "messagingSenderId": "549342074740", "appId": "1:549342074740:web:c003e0eb0e75097008be21"});
const messaging=firebase.messaging();

messaging.onBackgroundMessage(payload=>{
  const title=payload.notification?.title || payload.data?.title || '올데이픽 주문알림';
  const options={
    body:payload.notification?.body || payload.data?.body || '새 알림이 도착했습니다.',
    icon:'./icon.svg',
    badge:'./icon.svg',
    data:{url:payload.data?.url || './index.html'}
  };
  self.registration.showNotification(title,options);
});

self.addEventListener('notificationclick',event=>{
  event.notification.close();
  const url=event.notification.data?.url || './index.html';
  event.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(list=>{
    for(const client of list){ if('focus' in client) return client.focus(); }
    return clients.openWindow(url);
  }));
});

const CACHE='order-alert-v11';
const ASSETS=['./','./index.html','./manifest.json','./icon.svg'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS))));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))));
self.addEventListener('fetch',e=>e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request))));
