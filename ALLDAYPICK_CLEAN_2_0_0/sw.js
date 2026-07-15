const CACHE='alldaypick-clean-v2.0.0-20260715';
const STATIC=[
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './icon.svg'
];

self.addEventListener('install',event=>{
  event.waitUntil(
    caches.open(CACHE)
      .then(cache=>cache.addAll(STATIC))
      .then(()=>self.skipWaiting())
  );
});

self.addEventListener('activate',event=>{
  event.waitUntil(
    caches.keys()
      .then(keys=>Promise.all(
        keys.filter(key=>key!==CACHE).map(key=>caches.delete(key))
      ))
      .then(()=>self.clients.claim())
  );
});

self.addEventListener('fetch',event=>{
  const request=event.request;

  if(request.method!=='GET'){
    return;
  }

  const url=new URL(request.url);

  if(!['http:','https:'].includes(url.protocol)){
    return;
  }

  if(request.mode==='navigate'){
    event.respondWith(
      fetch(request,{cache:'no-store'})
        .then(response=>{
          if(response.ok&&url.origin===self.location.origin){
            const copy=response.clone();
            caches.open(CACHE)
              .then(cache=>cache.put('./index.html',copy))
              .catch(()=>{});
          }

          return response;
        })
        .catch(()=>caches.match('./index.html'))
    );

    return;
  }

  event.respondWith(
    fetch(request)
      .then(response=>{
        if(response.ok&&url.origin===self.location.origin){
          const copy=response.clone();
          caches.open(CACHE)
            .then(cache=>cache.put(request,copy))
            .catch(()=>{});
        }

        return response;
      })
      .catch(()=>caches.match(request))
  );
});
