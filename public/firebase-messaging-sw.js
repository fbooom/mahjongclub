// Combined service worker: Firebase Cloud Messaging + PWA offline caching.
// Registered explicitly from main.jsx so caching is active even without FCM.

// ── PWA Caching ──────────────────────────────────────────────────────────────
const CACHE = 'mahjong-club-v1';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.add('/')));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = e.request.url;
  // Pass through Firebase, Google API, and function calls — never cache these.
  if (
    url.includes('googleapis.com') ||
    url.includes('firebaseio.com') ||
    url.includes('firebaseapp.com') ||
    url.includes('cloudfunctions.net') ||
    url.includes('/api/')
  ) return;

  if (e.request.mode === 'navigate') {
    // Network-first for navigations; fall back to cached shell when offline.
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, clone));
          return res;
        })
        .catch(() => caches.match('/'))
    );
    return;
  }

  // Cache-first for static assets (JS, CSS, images, fonts).
  e.respondWith(
    caches.match(e.request).then((cached) => {
      if (cached) return cached;
      return fetch(e.request).then((res) => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, clone));
        }
        return res;
      });
    })
  );
});

// ── Notification click: navigate to the relevant group or game ───────────────
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const { type, groupId, gameId } = data;

  // Build a cold-start URL with nav params so the app can route after login.
  // These params are distinct from the ?joinGroup/?gameCode join-invite params.
  let url = "/";
  if ((type === "chat" || type === "reply") && groupId) {
    url = `/?navGroup=${groupId}`;
  } else if ((type === "gameChat" || type === "game" || type === "gameReminder") && groupId && gameId) {
    url = `/?navGroup=${groupId}&navGame=${gameId}`;
  } else if (type === "gameChat" && !groupId && gameId) {
    url = `/?navGame=${gameId}`;
  }

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      const existing = clientList.find((c) => c.url.includes(self.location.origin) && "focus" in c);
      if (existing) {
        // App is already open — tell it to navigate without a page reload.
        existing.postMessage({ type: "NAVIGATE", data });
        return existing.focus();
      }
      return clients.openWindow(url);
    })
  );
});

// ── Firebase Cloud Messaging ──────────────────────────────────────────────────
importScripts("https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyCTeU_wXAyimBlyfKbTgXlNXexKZX-8Ecc",
  authDomain: "mahjong-club-da606.firebaseapp.com",
  projectId: "mahjong-club-da606",
  storageBucket: "mahjong-club-da606.firebasestorage.app",
  messagingSenderId: "744873688381",
  appId: "1:744873688381:web:4950566339bcd942e95954",
});

const messaging = firebase.messaging();

// Handle background messages (app is not in focus)
messaging.onBackgroundMessage((payload) => {
  const { title, body, icon } = payload.notification || {};
  self.registration.showNotification(title || "Mahjong Club", {
    body: body || "New message in your group",
    icon: icon || "/favicon.ico",
    badge: "/favicon.ico",
    data: payload.data,
  });
});
