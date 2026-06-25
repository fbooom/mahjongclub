import { initializeApp } from "firebase/app";
import { getAuth, initializeAuth, indexedDBLocalPersistence, GoogleAuthProvider } from "firebase/auth";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager } from "firebase/firestore";
import { getMessaging, isSupported } from "firebase/messaging";
import { getStorage } from "firebase/storage";
import { Capacitor } from "@capacitor/core";

const firebaseConfig = {
  apiKey: "AIzaSyCTeU_wXAyimBlyfKbTgXlNXexKZX-8Ecc",
  authDomain: "mahjong-club-da606.firebaseapp.com",
  projectId: "mahjong-club-da606",
  storageBucket: "mahjong-club-da606.firebasestorage.app",
  messagingSenderId: "744873688381",
  appId: "1:744873688381:web:4950566339bcd942e95954",
  measurementId: "G-KS2LQTJY5Z",
};

const app = initializeApp(firebaseConfig);

// Capacitor's native WebView needs explicit IndexedDB persistence —
// the default auto-detection path stalls and onAuthStateChanged never fires.
export const auth = Capacitor.isNativePlatform()
  ? initializeAuth(app, { persistence: indexedDBLocalPersistence })
  : getAuth(app);

// Offline persistence: data loads from IndexedDB cache instantly on every open
// after the first, instead of waiting for a network round trip.
// experimentalAutoDetectLongPolling: falls back to long polling if WebSocket
// is unreliable (common on iOS Capacitor WKWebView).
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  experimentalAutoDetectLongPolling: true,
});
export const storage = getStorage(app);
export const googleProvider = new GoogleAuthProvider();

// Messaging — resolves to the Messaging instance, or null if unsupported
export const messagingReady = isSupported()
  .then((yes) => yes ? getMessaging(app) : null)
  .catch(() => null);
