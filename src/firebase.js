import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getMessaging, isSupported } from "firebase/messaging";

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
export const auth = getAuth(app);
export const db = getFirestore(app);
export const googleProvider = new GoogleAuthProvider();

// Messaging — resolves to the Messaging instance, or null if unsupported
export const messagingReady = isSupported()
  .then((yes) => yes ? getMessaging(app) : null)
  .catch(() => null);
