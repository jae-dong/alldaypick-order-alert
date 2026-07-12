
$ErrorActionPreference = "Stop"

$project = Split-Path -Parent $MyInvocation.MyCommand.Path
$indexPath = Join-Path $project "index.html"
$backendPath = Join-Path $project "backend"
$patchBackend = Join-Path $project "v15-files\backend"

if (!(Test-Path $indexPath)) {
  Write-Host "ERROR: index.html not found." -ForegroundColor Red
  Write-Host "Copy this package into the alldaypick-order-alert folder first."
  Read-Host "Press Enter"
  exit 1
}

if (!(Test-Path $backendPath)) {
  Write-Host "ERROR: backend folder not found." -ForegroundColor Red
  Read-Host "Press Enter"
  exit 1
}

if (!(Test-Path $patchBackend)) {
  Write-Host "ERROR: v15-files folder not found." -ForegroundColor Red
  Read-Host "Press Enter"
  exit 1
}

$html = Get-Content -Raw -Encoding UTF8 $indexPath

$match = [regex]::Match(
  $html,
  'const\s+firebaseConfig\s*=\s*(\{.*?\});',
  [System.Text.RegularExpressions.RegexOptions]::Singleline
)

if (!$match.Success) {
  Write-Host "ERROR: firebaseConfig not found in index.html." -ForegroundColor Red
  Read-Host "Press Enter"
  exit 1
}

$config = $match.Groups[1].Value

Copy-Item `
  (Join-Path $patchBackend "coupang.js") `
  (Join-Path $backendPath "coupang.js") `
  -Force

Copy-Item `
  (Join-Path $patchBackend "local-agent.js") `
  (Join-Path $backendPath "local-agent.js") `
  -Force

$sw = @"
importScripts('https://www.gstatic.com/firebasejs/11.10.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/11.10.0/firebase-messaging-compat.js');

firebase.initializeApp($config);
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

const CACHE = 'order-alert-v15';
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
"@

Set-Content `
  -Path (Join-Path $project "sw.js") `
  -Value $sw `
  -Encoding UTF8

Write-Host ""
Write-Host "SUCCESS: v15 push files applied." -ForegroundColor Green
Write-Host "Firebase API configuration was preserved." -ForegroundColor Green
Write-Host ""
Write-Host "Next: Commit and Push with GitHub Desktop." -ForegroundColor Cyan
Write-Host ""

Read-Host "Press Enter"
