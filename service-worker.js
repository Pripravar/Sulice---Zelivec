/* ════════════════════════════════════════════════════════════════
   SERVICE WORKER – Sulice-Želivec
   - Cache pro offline využití základní HTML aplikace
   - Příjem Web Push notifikací (Firebase Cloud Messaging)
   Vytvořeno: 2026-05-12
   ════════════════════════════════════════════════════════════════ */

// VERZE cache - při změně příště zvedni, ať si telefony stáhnou novou verzi.
const CACHE_VERSION = 'sulice-v25-2026-05-12';

const CORE_ASSETS = [
  './',
  './index.html',
  './manifest.json'
];

// ── Instalace: napřed-cache základních souborů ─────────────────
self.addEventListener('install', function(event) {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_VERSION).then(function(cache) {
      return cache.addAll(CORE_ASSETS).catch(function(err) {
        console.warn('SW pre-cache selhal částečně:', err);
      });
    })
  );
});

// ── Aktivace: smazat staré verze cache ─────────────────────────
self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(keys.map(function(k) {
        if(k !== CACHE_VERSION) return caches.delete(k);
      }));
    }).then(function() {
      return self.clients.claim();
    })
  );
});

// ── Fetch: network-first pro HTML, cache-first pro statika ─────
self.addEventListener('fetch', function(event) {
  var req = event.request;
  if(req.method !== 'GET') return;
  var url = new URL(req.url);

  // Firebase a externí API necachujeme - jdou přímo
  if(url.origin !== self.location.origin) return;

  // HTML: network-first (vždy chceme nejnovější aplikaci, ale offline funguje)
  if(req.mode === 'navigate' || (req.headers.get('accept') || '').indexOf('text/html') !== -1) {
    event.respondWith(
      fetch(req).then(function(resp) {
        var copy = resp.clone();
        caches.open(CACHE_VERSION).then(function(cache) { cache.put(req, copy); });
        return resp;
      }).catch(function() {
        return caches.match(req).then(function(c) { return c || caches.match('./index.html'); });
      })
    );
    return;
  }

  // Statika (manifest, ikony…): cache-first
  event.respondWith(
    caches.match(req).then(function(cached) {
      return cached || fetch(req).then(function(resp) {
        var copy = resp.clone();
        if(resp.status === 200) {
          caches.open(CACHE_VERSION).then(function(cache) { cache.put(req, copy); });
        }
        return resp;
      });
    })
  );
});

// ── Push notifikace (Web Push / FCM) ───────────────────────────
self.addEventListener('push', function(event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; } catch(e) {
    try { data = { notification: { title: 'Notifikace', body: event.data.text() } }; } catch(_) {}
  }
  var n = data.notification || {};
  var title = n.title || 'Sulice – Želivec';
  var options = {
    body:    n.body || '',
    icon:    n.icon || './manifest.json',
    badge:   n.badge,
    data:    data.data || {},
    tag:     (data.data && data.data.taskId) || 'sulice-notify',
    renotify: true
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// ── Klik na notifikaci - otevřít aplikaci ──────────────────────
self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  var taskId = event.notification.data && event.notification.data.taskId;
  var url = './' + (taskId ? ('#task=' + encodeURIComponent(taskId)) : '');
  event.waitUntil(
    self.clients.matchAll({type:'window', includeUncontrolled:true}).then(function(list){
      for(var i=0; i<list.length; i++) {
        var c = list[i];
        if(c.url.indexOf(self.location.origin) === 0 && 'focus' in c) {
          c.focus();
          if('navigate' in c) c.navigate(url);
          return;
        }
      }
      if(self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
