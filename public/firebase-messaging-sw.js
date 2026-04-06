// Firebase Cloud Messaging Service Worker
// This file must live at the root of your domain (handled by Vite's public/ folder).
//
// SETUP REQUIRED:
//   1. Go to Firebase Console → Project Settings → Cloud Messaging
//   2. Generate a Web Push certificate (VAPID key)
//   3. Replace the placeholder below with your actual config values
//   4. Add your VAPID key to the getToken() call in App.jsx

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
