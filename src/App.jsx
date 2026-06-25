import { useState, useEffect, useRef } from "react";
import {
  onAuthStateChanged, createUserWithEmailAndPassword,
  signInWithEmailAndPassword, signInWithPopup, signInWithCredential,
  GoogleAuthProvider, signOut,
} from "firebase/auth";
import {
  collection, collectionGroup, doc, setDoc, getDoc, getDocs, updateDoc, deleteDoc,
  onSnapshot, query, where, orderBy, limit, addDoc, serverTimestamp,
  arrayUnion, arrayRemove, deleteField, runTransaction, writeBatch,
  enableNetwork, disableNetwork,
} from "firebase/firestore";
import { auth, db, storage, googleProvider, messagingReady } from "./firebase";
import { ref as storageRef, listAll, getMetadata } from "firebase/storage";
import { getToken, onMessage, deleteToken } from "firebase/messaging";
import { getFunctions, httpsCallable, httpsCallableFromURL } from "firebase/functions";
import { Capacitor } from "@capacitor/core";
import { App as CapApp } from "@capacitor/app";
import { PushNotifications } from "@capacitor/push-notifications";
import { GoogleAuth } from "@southdevs/capacitor-google-auth";

// Route all Cloud Function calls through Firebase Hosting (/api/*) so they
// work even when the GCP org policy blocks allUsers IAM bindings on Cloud Run.
const HOSTING_BASE = "https://mahjong-club-da606.web.app/api";
const hostingFn = (name) => httpsCallableFromURL(getFunctions(), `${HOSTING_BASE}/${name}`);
import { sakura as defaultTheme, themes, buildCSSVars } from "./theme";
import { QRCodeSVG } from "qrcode.react";
import jsQR from "jsqr";

// VAPID key — get from Firebase Console → Project Settings → Cloud Messaging → Web Push certificates
const VAPID_KEY = "BKkYCO7TpfkGKyFGFwxP9qv_SqUyey_tLi5yzk5bngZxZ6ZBd3S9IgYSsHwIlRMinuGxmiFK4bQDjwxIPj8M0Bg";

// Google OAuth web client ID (public identifier — also stored in capacitor.config.ts).
// Used as serverClientId in the native Google Sign-In flow so the plugin can return
// a serverAuthCode. Not a secret: it is embedded in the app binary and web bundle.
const GOOGLE_WEB_CLIENT_ID = "744873688381-a12j7rdj7cpfjedddvfn2ejjobmt2p6t.apps.googleusercontent.com";

// On iOS the CSS env(safe-area-inset-top) resolves to 0 in Capacitor's WKWebView
// even with viewport-fit=cover, so headers use a hardcoded offset instead.
// 74px = 59px (Dynamic Island status bar on iPhone 14 Pro+) + 15px breathing room,
// matching the ~14px gap the bookmarked web app shows below the status bar.
// Older iPhones (notch: 47px, SE: 20px) get slightly more padding — still correct.
const HEADER_BTN_TOP = Capacitor.getPlatform() === "ios" ? 74 : 14;

// Returns the UTC timestamp for midnight of today in the given IANA timezone.
// Uses binary search so it handles all offsets including ±30/45-minute zones.
const _tzDayCache = {};
function startOfTodayInTz(tz) {
  const safeTz = tz || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: safeTz });
  const key = `${safeTz}|${todayStr}`;
  if (_tzDayCache[key] !== undefined) return _tzDayCache[key];
  const [y, m, d] = todayStr.split("-").map(Number);
  let lo = Date.UTC(y, m - 1, d - 1), hi = Date.UTC(y, m - 1, d + 1);
  while (hi - lo > 1000) {
    const mid = Math.floor((lo + hi) / 2);
    if (new Date(mid).toLocaleDateString("en-CA", { timeZone: safeTz }) < todayStr) lo = mid;
    else hi = mid;
  }
  return (_tzDayCache[key] = hi);
}

// Common IANA timezones for the profile timezone picker.
const TIMEZONES = [
  "America/New_York","America/Chicago","America/Denver","America/Los_Angeles",
  "America/Anchorage","America/Honolulu","America/Phoenix","America/Toronto",
  "America/Vancouver","America/Sao_Paulo","America/Argentina/Buenos_Aires",
  "America/Mexico_City","America/Bogota","America/Lima","America/Santiago",
  "Europe/London","Europe/Paris","Europe/Berlin","Europe/Madrid","Europe/Rome",
  "Europe/Amsterdam","Europe/Stockholm","Europe/Warsaw","Europe/Zurich",
  "Europe/Athens","Europe/Helsinki","Europe/Istanbul","Europe/Moscow",
  "Africa/Cairo","Africa/Johannesburg","Africa/Lagos","Africa/Nairobi",
  "Asia/Dubai","Asia/Karachi","Asia/Kolkata","Asia/Dhaka","Asia/Bangkok",
  "Asia/Jakarta","Asia/Singapore","Asia/Shanghai","Asia/Hong_Kong",
  "Asia/Seoul","Asia/Tokyo","Asia/Manila","Australia/Sydney","Australia/Melbourne",
  "Australia/Brisbane","Australia/Perth","Pacific/Auckland","Pacific/Auckland",
  "Pacific/Honolulu","Pacific/Fiji","UTC",
];

// Canonical public URL used for all shareable links and QR codes.
// In the Capacitor native app window.location.origin is "capacitor://localhost"
// which is unrecognisable to external QR scanners — always use the real domain.
const APP_PUBLIC_URL = "https://ourmahjong.club";

// ── Game join-code utilities ─────────────────────────────────────────────────
// Unambiguous chars: no O/0, I/1/l confusion
const GAME_CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function generateGameCode() {
  return Array.from({ length: 6 }, () => GAME_CODE_CHARS[Math.floor(Math.random() * GAME_CODE_CHARS.length)]).join("");
}
function isValidGameCode(code) {
  return /^[A-Za-z0-9_-]{3,20}$/.test(code);
}

// ── Subscription plan helpers ────────────────────────────────────────────────
// Hardcoded fallback — used before Firestore plan config is loaded
const FREE_PLAN = { maxGroups: 2, gamesPerCycle: 1, cycleDays: 30 };

function getPlan(user) {
  return user?.subscription?.plan || "free";
}

// cfg = live plan config from Firestore. Absent or null limit fields mean unlimited (Infinity).
// No code-side defaults — all limits must be set explicitly in Firestore.
function getPlanLimits(cfg) {
  return {
    maxGroups:     cfg?.limits?.maxGroups     ?? Infinity,
    gamesPerCycle: cfg?.limits?.gamesPerCycle ?? Infinity,
    cycleDays:     cfg?.limits?.cycleDays     ?? 30,
  };
}

// Returns { ok: true } or { ok: false }
// Enforces the plan's maxGroups limit for every plan. Unlimited = Infinity in cfg.
function canAddGroup(groups, user, cfg) {
  const { maxGroups } = getPlanLimits(cfg);
  if (!isFinite(maxGroups)) return { ok: true };
  const activeCount = (Array.isArray(groups) ? groups : []).filter(g => g.status !== "archived").length;
  return activeCount >= maxGroups ? { ok: false } : { ok: true };
}

// Returns { ok: true } or { ok: false }
// Enforces the plan's gamesPerCycle limit for every plan. Unlimited = Infinity in cfg.
// standaloneGames: optional array of standalone (non-group) hosted games to include in the count.
function canHostGame(user, groups, cfg, standaloneGames = []) {
  const { gamesPerCycle } = getPlanLimits(cfg);
  if (!isFinite(gamesPerCycle)) return { ok: true };
  const uid = user?.uid;
  const now = Date.now();
  const futureGroupHosted = (groups || []).reduce((n, g) =>
    n + (g.games || []).filter(gm => gm.hostId === uid && gm.date > now && gm.status !== "archived").length, 0);
  const futureStandaloneHosted = (standaloneGames || [])
    .filter(gm => gm.date > now && gm.status !== "archived").length;
  return (futureGroupHosted + futureStandaloneHosted) >= gamesPerCycle ? { ok: false } : { ok: true };
}

const showBrowserNotif = (title, body, tag) => {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  // iOS Safari PWA does not support the Notification() constructor — use SW showNotification().
  getSwRegistration()
    .then((swReg) => {
      if (swReg) return swReg.showNotification(title, { body, icon: "/favicon.ico", tag });
      return new Notification(title, { body, icon: "/favicon.ico", tag });
    })
    .catch(() => {});
};

// ── Push notification helpers (web + native) ─────────────────────────────────

// Returns the active service worker registration for FCM, registering it if needed.
// Passing the registration explicitly to getToken() prevents Firebase from trying
// to auto-register the SW, which fails on Safari iOS PWA when the CSP was blocking
// importScripts from gstatic.com (now fixed) or when registration is already active.
async function getSwRegistration() {
  if (!("serviceWorker" in navigator)) return undefined;
  try {
    const existing = await navigator.serviceWorker.getRegistration("/firebase-messaging-sw.js");
    if (existing) return existing;
    return await navigator.serviceWorker.register("/firebase-messaging-sw.js");
  } catch { return undefined; }
}

// Tracks the current device's native push token so logout can remove it from Firestore.
let _nativePushToken = null;

// Silent refresh: re-registers and saves FCM token without showing any dialog.
// Called on sign-in. Also sets notificationsEnabled=true so the Cloud Function
// includes this user in pushes (tokens present = OS permission already granted).
// Handle to the currently-active "registration" listener, so it can be
// swapped out on re-registration without wiping foreground/tap listeners.
let _registrationListener = null;

// Returns true if token was successfully registered, false if OS permission not granted.
async function silentlyRefreshFcmToken(uid) {
  if (Capacitor.isNativePlatform()) {
    try {
      const { receive } = await PushNotifications.checkPermissions();
      if (receive !== "granted") return false;
      if (_registrationListener) { _registrationListener.then(h => h.remove()).catch(() => {}); }
      _registrationListener = PushNotifications.addListener("registration", async ({ value: token }) => {
        if (token) {
          _nativePushToken = token;
          updateDoc(doc(db, "users", uid), { nativePushTokens: arrayUnion(token) })
            .catch(e => console.error("[FCM native] Firestore write failed:", e));
        }
      });
      await PushNotifications.register();
      return true;
    } catch (e) { console.error("[FCM native] silent refresh failed:", e); return false; }
  }
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  const messaging = await messagingReady;
  if (!messaging) return;
  try {
    const swReg = await getSwRegistration();
    const token = await getToken(messaging, { vapidKey: VAPID_KEY, ...(swReg && { serviceWorkerRegistration: swReg }) });
    if (token) await updateDoc(doc(db, "users", uid), { fcmTokens: arrayUnion(token) });
  } catch (e) { console.error("[FCM] silent refresh failed:", e); }
}

// Explicit enable: prompts for permission, registers token, flips notificationsEnabled.
// Returns a status string the UI acts on.
async function enablePushNotifications(uid) {
  if (Capacitor.isNativePlatform()) {
    let { receive } = await PushNotifications.checkPermissions();
    if (receive === "denied") return "denied";
    if (receive !== "granted") {
      const result = await PushNotifications.requestPermissions();
      if (result.receive !== "granted") return "no-permission";
    }
    if (_registrationListener) { _registrationListener.then(h => h.remove()).catch(() => {}); }
    let _errListener = null;
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve("error:timeout"), 10000);
      const finish = (r) => {
        clearTimeout(timer);
        _errListener?.then(h => h.remove()).catch(() => {});
        resolve(r);
      };
      _registrationListener = PushNotifications.addListener("registration", async ({ value: token }) => {
        if (token) {
          _nativePushToken = token;
          await updateDoc(doc(db, "users", uid), { notificationsEnabled: true, nativePushTokens: arrayUnion(token) });
          finish("ok");
        } else { finish("empty-token"); }
      });
      _errListener = PushNotifications.addListener("registrationError", () => finish("error:registration-failed"));
      PushNotifications.register().catch(() => finish("error:register-threw"));
    });
  }
  // Web path
  if (typeof Notification === "undefined") return "unsupported";
  if (Notification.permission === "denied") return "denied";
  if (Notification.permission === "default") {
    const result = await Notification.requestPermission();
    if (result !== "granted") return "no-permission";
  }
  const messaging = await messagingReady;
  if (!messaging) return "unsupported";
  try {
    const swReg = await getSwRegistration();
    const token = await getToken(messaging, { vapidKey: VAPID_KEY, ...(swReg && { serviceWorkerRegistration: swReg }) });
    if (token) {
      await updateDoc(doc(db, "users", uid), { notificationsEnabled: true, fcmTokens: arrayUnion(token) });
      return "ok";
    }
    return "empty-token";
  } catch (e) {
    console.error("[FCM] getToken failed:", e.code || e.name, e.message);
    return "error:" + e.message;
  }
}

// Instrumented version of enablePushNotifications that writes each step to `log[]`
// so the result can be displayed in the UI without needing dev tools.
async function enablePushNotificationsWithLog(uid, log) {
  log.push(`UID: ${uid || "MISSING"}`);
  log.push(`Platform: ${Capacitor.isNativePlatform() ? Capacitor.getPlatform() : "web"}`);

  if (Capacitor.isNativePlatform()) {
    log.push("Checking native permissions…");
    let { receive } = await PushNotifications.checkPermissions();
    log.push(`Permission: ${receive}`);
    if (receive === "denied") { log.push("FAIL: permission=denied"); return "denied"; }
    if (receive !== "granted") {
      log.push("Requesting permission…");
      const res = await PushNotifications.requestPermissions();
      log.push(`Result: ${res.receive}`);
      if (res.receive !== "granted") return "no-permission";
    }
    log.push("Registering for push…");
    if (_registrationListener) { _registrationListener.then(h => h.remove()).catch(() => {}); }
    let _errListener = null;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        log.push("FAIL: APNs registration timed out after 10s — check Push Notifications capability in Xcode target");
        _errListener?.then(h => h.remove()).catch(() => {});
        resolve("error:timeout");
      }, 10000);
      const finish = (result) => {
        clearTimeout(timer);
        _errListener?.then(h => h.remove()).catch(() => {});
        resolve(result);
      };
      _registrationListener = PushNotifications.addListener("registration", async ({ value: token }) => {
        log.push(`Token: ${token ? token.slice(0, 30) + "…" : "(empty)"}`);
        if (token) {
          await updateDoc(doc(db, "users", uid), { notificationsEnabled: true, nativePushTokens: arrayUnion(token) });
          const snap = await getDoc(doc(db, "users", uid));
          log.push(`Firestore confirmed: nativePushTokens.length=${snap.data()?.nativePushTokens?.length}`);
          finish("ok");
        } else { finish("empty-token"); }
      });
      _errListener = PushNotifications.addListener("registrationError", (err) => {
        log.push(`FAIL: registrationError — ${JSON.stringify(err)}`);
        finish("error:registration-failed");
      });
      PushNotifications.register().catch((e) => { log.push(`FAIL: register threw — ${e.message}`); finish("error:register-threw"); });
    });
  }

  // Web path
  if (typeof Notification === "undefined") { log.push("FAIL: Notification API undefined"); return "unsupported"; }
  log.push(`Notification API: present`);
  if (Notification.permission === "denied") { log.push("FAIL: permission=denied"); return "denied"; }
  if (Notification.permission === "default") {
    log.push("Requesting permission…");
    const result = await Notification.requestPermission();
    log.push(`Permission result: ${result}`);
    if (result !== "granted") return "no-permission";
  } else {
    log.push(`Permission: ${Notification.permission}`);
  }
  log.push("Awaiting messagingReady…");
  const messaging = await messagingReady;
  if (!messaging) { log.push("FAIL: messagingReady=null (isSupported() false)"); return "unsupported"; }
  log.push("Messaging instance: ok");
  try {
    log.push("Calling getToken…");
    const swReg = await getSwRegistration();
    log.push(`SW registration: ${swReg ? swReg.scope : "none — Firebase will auto-register"}`);
    const token = await getToken(messaging, { vapidKey: VAPID_KEY, ...(swReg && { serviceWorkerRegistration: swReg }) });
    log.push(`Token value: ${token ? token.slice(0, 30) + "…" : "(empty)"}`);
    if (token) {
      log.push(`Writing to users/${uid}…`);
      await updateDoc(doc(db, "users", uid), { notificationsEnabled: true, fcmTokens: arrayUnion(token) });
      const snap = await getDoc(doc(db, "users", uid));
      const saved = snap.data()?.fcmTokens || [];
      log.push(`Firestore confirmed: fcmTokens.length=${saved.length}`);
      return "ok";
    }
    log.push("FAIL: getToken returned empty string");
    return "empty-token";
  } catch (e) {
    log.push(`FAIL: ${e.name} — ${e.message}`);
    return "error:" + e.message;
  }
}

const uid = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const fmt = (ts) => new Date(ts).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
const fmtT = (t) => { const [h, m] = t.split(":").map(Number); const mins = m === 0 ? "" : `:${m.toString().padStart(2,"0")}`; return `${h % 12 || 12}${mins} ${h >= 12 ? "PM" : "AM"}`; };
const fmtRange = (start, end) => {
  if (!end) return fmtT(start);
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  const startAmPm = sh >= 12 ? "PM" : "AM";
  const endAmPm = eh >= 12 ? "PM" : "AM";
  const fmt1 = (h, m) => { const mins = m === 0 ? "" : `:${m.toString().padStart(2,"0")}`; return `${h % 12 || 12}${mins}`; };
  // Omit start AM/PM if same as end
  const startStr = startAmPm === endAmPm ? fmt1(sh, sm) : `${fmt1(sh, sm)} ${startAmPm}`;
  return `${startStr} – ${fmt1(eh, em)} ${endAmPm}`;
};
const NOW = Date.now();

// Calendar helpers
const calDt = (dateTs, timeStr) => {
  const d = new Date(dateTs);
  const [h, m] = timeStr.split(":").map(Number);
  d.setHours(h, m, 0, 0);
  return d;
};
const icsDate = (d) => d.toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
const buildCalendarLinks = (game, groupName) => {
  const start = calDt(game.date, game.time);
  const end = game.endTime ? calDt(game.date, game.endTime) : new Date(start.getTime() + 3 * 60 * 60 * 1000);
  const title = encodeURIComponent(`${game.title} — ${groupName}`);
  const loc = encodeURIComponent(game.location);
  const details = encodeURIComponent(
    `Host: ${game.host}\nStyle: ${game.style || "Mahjong"}${game.note ? `\nNotes: ${game.note}` : ""}\n\nScheduled via Mahjong Club`
  );
  const googleUrl = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${title}&dates=${icsDate(start)}/${icsDate(end)}&location=${loc}&details=${details}`;
  const icsContent = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Mahjong Club//EN",
    "BEGIN:VEVENT",
    `DTSTART:${icsDate(start)}`,
    `DTEND:${icsDate(end)}`,
    `SUMMARY:${game.title} — ${groupName}`,
    `LOCATION:${game.location}`,
    `DESCRIPTION:Host: ${game.host}\\nStyle: ${game.style || "Mahjong"}${game.note ? `\\nNotes: ${game.note}` : ""}`,
    "END:VEVENT", "END:VCALENDAR",
  ].join("\r\n");
  return { googleUrl, icsContent };
};
const downloadIcs = (game, groupName) => {
  const { icsContent } = buildCalendarLinks(game, groupName);
  const blob = new Blob([icsContent], { type: "text/calendar" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `${game.title.replace(/[^a-z0-9]/gi, "_")}.ics`; a.click();
  URL.revokeObjectURL(url);
};

const SEED = [
  {
    id: "G1", name: "Tuesday Tiles", code: "TUE42", emoji: "🀄", color: "#c9607a",
    members: [
      { id: "me", name: "You", avatar: "🐼", host: true },
      { id: "u2", name: "Linda W.", avatar: "🦋" },
      { id: "u3", name: "Carol M.", avatar: "🌸" },
      { id: "u4", name: "Deb F.", avatar: "🍀" },
    ],
    games: [
      { id: "gm1", title: "Weekly Game Night", host: "Linda W.", hostId: "u2",
        date: NOW + 3 * 86400000, time: "19:00", location: "Linda's Place — 12 Oak St",
        seats: 4, rsvps: { me: "yes", u2: "yes", u3: "maybe", u4: "yes" }, waitlist: [],
        note: "Bring your own scorecard!" },
      { id: "gm2", title: "Saturday Afternoon Mah", host: "You", hostId: "me",
        date: NOW + 9 * 86400000, time: "14:00", location: "My Place — 5 Maple Ave",
        seats: 4, rsvps: { me: "yes", u2: "yes" }, waitlist: [], note: "Snacks provided!" },
    ],
  },
  {
    id: "G2", name: "Mah Jong Mavens", code: "MAV99", emoji: "🀅", color: "#9b6ea8",
    members: [
      { id: "me", name: "You", avatar: "🐼" },
      { id: "u5", name: "Rose T.", avatar: "🌹" },
      { id: "u6", name: "Anne P.", avatar: "🦚" },
    ],
    games: [],
  },
];

const EMOJIS = ["🀄","🀅","🀆","🀇","🀈","🎲","🌸","🌿","🎋","🎍"];
const COLORS = ["#c9607a","#9b6ea8","#d4829b","#e8a0b0","#c17db8","#a0845c","#7a9e7e","#d4a5c9"];
const REACTION_EMOJIS = ["😊","👍","❤️","👏","😢","👎"];

const inputSt = {
  width: "100%", padding: "12px 14px", background: "var(--bg-input)", borderRadius: "var(--radius-input)",
  fontSize: 16, fontWeight: 600, marginBottom: 6, border: "2px solid var(--border-input)",
  color: "var(--text-body)", display: "block", boxSizing: "border-box",
  WebkitAppearance: "none", appearance: "none",
};

function buildGlobalCSS(theme) {
  return `
  ${buildCSSVars(theme)}
  @import url('${theme.googleFontUrl}');
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{height:100%;font-family:var(--font-body);overflow:hidden;overscroll-behavior:none}
  body{background:var(--bg-body);min-height:100%}
  button{cursor:pointer;border:none;font-family:var(--font-body)}
  input,select,textarea{font-family:var(--font-body);outline:none;font-size:16px}

  @keyframes bIn{0%{transform:scale(.7);opacity:0}70%{transform:scale(1.06);opacity:1}100%{transform:scale(1)}}
  @keyframes sUp{from{transform:translateY(28px);opacity:0}to{transform:translateY(0);opacity:1}}
  @keyframes sheetUp{from{transform:translateX(-50%) translateY(100%)}to{transform:translateX(-50%) translateY(0)}}
  @keyframes f0{0%,100%{transform:translateY(0) rotate(-4deg)}50%{transform:translateY(-10px) rotate(4deg)}}
  @keyframes f1{0%,100%{transform:translateY(0) rotate(6deg)}50%{transform:translateY(-12px) rotate(-3deg)}}
  @keyframes f2{0%,100%{transform:translateY(0) rotate(-6deg)}50%{transform:translateY(-8px) rotate(6deg)}}
  .bIn{animation:bIn .4s cubic-bezier(.36,.07,.19,.97) both}
  .sUp{animation:sUp .3s ease both}

  /* App shell: mobile-first, caps at 480px, always centered */
  .app-shell {
    width: 100%;
    max-width: 480px;
    height: 100vh;
    height: 100dvh;
    margin: 0 auto;
    background: linear-gradient(170deg,var(--bg-shell-start) 0%,var(--bg-shell-mid) 40%,var(--bg-shell-end) 100%);
    position: relative;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  /* On larger screens: float as a card with subtle shadow */
  @media (min-width: 520px) {
    .app-shell {
      box-shadow: 0 0 60px var(--shadow-primary), 0 0 0 1px rgba(var(--border-light-rgb),0.2);
    }
  }

  /* Bottom nav is a flex child of .app-shell — no fixed positioning needed */
  .bottom-nav {
    flex-shrink: 0;
    width: 100%;
    background: var(--bg-nav);
    backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
    border-top: 1px solid var(--border-nav);
    display: flex; align-items: stretch;
    box-shadow: 0 -4px 24px var(--shadow-primary);
    z-index: 1000;
    padding-bottom: env(safe-area-inset-bottom);
  }

  ::-webkit-scrollbar{width:4px}
  ::-webkit-scrollbar-thumb{background:var(--scrollbar-thumb);border-radius:99px}
`;
}

// ── PWA Install Banner ────────────────────────────────────────────────────────
function useInstallBanner() {
  const [showBanner, setShowBanner] = useState(false);
  const [isIOS, setIsIOS] = useState(false);
  const [canPrompt, setCanPrompt] = useState(false);
  const deferredPrompt = useRef(null);

  useEffect(() => {
    if (Capacitor.isNativePlatform()) return;
    const isStandalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      ("standalone" in window.navigator && window.navigator.standalone);
    if (isStandalone) return;

    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    setIsIOS(ios);

    if (!ios) {
      const handler = (e) => {
        e.preventDefault();
        deferredPrompt.current = e;
        setCanPrompt(true);
        if (!localStorage.getItem("mjc_install_dismissed")) {
          const visits = parseInt(localStorage.getItem("mjc_install_visits") || "0") + 1;
          localStorage.setItem("mjc_install_visits", String(visits));
          if (visits >= 3) setShowBanner(true);
        }
      };
      window.addEventListener("beforeinstallprompt", handler);
      return () => window.removeEventListener("beforeinstallprompt", handler);
    } else {
      if (!localStorage.getItem("mjc_install_dismissed")) {
        const visits = parseInt(localStorage.getItem("mjc_install_visits") || "0") + 1;
        localStorage.setItem("mjc_install_visits", String(visits));
        if (visits >= 3) setShowBanner(true);
      }
    }
  }, []);

  const dismiss = () => { localStorage.setItem("mjc_install_dismissed", "1"); setShowBanner(false); };
  const install = async () => {
    if (deferredPrompt.current) {
      deferredPrompt.current.prompt();
      const { outcome } = await deferredPrompt.current.userChoice;
      deferredPrompt.current = null;
      setCanPrompt(false);
      if (outcome === "accepted") localStorage.setItem("mjc_install_dismissed", "1");
    }
    setShowBanner(false);
  };

  return { showBanner, isIOS, canPrompt, dismiss, install };
}

function InstallBanner({ showBanner, isIOS, onDismiss, onInstall }) {
  if (!showBanner) return null;
  return (
    <div style={{
      position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 9998,
      background: "rgba(255,255,255,0.96)",
      backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)",
      borderTop: "1px solid rgba(201,96,122,0.18)",
      padding: "14px 20px 34px",
      boxShadow: "0 -4px 32px rgba(168,66,107,0.14)",
      animation: "pwa-slide-up 0.3s cubic-bezier(0.4,0,0.2,1)",
      fontFamily: "'Inter', sans-serif",
    }}>
      <style>{`@keyframes pwa-slide-up{from{transform:translateY(100%)}to{transform:translateY(0)}}`}</style>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12, maxWidth: 480, margin: "0 auto" }}>
        <div style={{ fontSize: 38, lineHeight: 1, flexShrink: 0 }}>🀄</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 15, color: "#3a1a2a", marginBottom: 4 }}>
            Add Mahjong Club to your home screen
          </div>
          {isIOS ? (
            <div style={{ fontSize: 13, color: "#7a4a58", lineHeight: 1.6 }}>
              Tap{" "}
              <span style={{ display: "inline-flex", alignItems: "center", gap: 3, background: "rgba(201,96,122,0.1)", borderRadius: 6, padding: "1px 6px", fontWeight: 700, color: "#c9607a" }}>
                ⎙ Share
              </span>
              {" "}then tap <strong>"Add to Home Screen"</strong>
            </div>
          ) : (
            <button onClick={onInstall} style={{
              marginTop: 6, background: "linear-gradient(135deg,#c9607a,#9b6ea8)",
              color: "#fff", border: "none", borderRadius: 999, padding: "7px 18px",
              fontSize: 13, fontWeight: 700, cursor: "pointer",
            }}>
              Add to Home Screen
            </button>
          )}
        </div>
        <button onClick={onDismiss} style={{
          background: "rgba(201,96,122,0.1)", border: "none", borderRadius: "50%",
          width: 28, height: 28, fontSize: 18, cursor: "pointer", color: "#c9607a",
          display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, lineHeight: 1,
        }}>×</button>
      </div>
    </div>
  );
}

export default function App() {
  const installBanner = useInstallBanner();
  const [activeTheme, setActiveTheme] = useState(() => {
    try {
      const saved = localStorage.getItem("mahjong_theme");
      return (saved && themes[saved]) ? themes[saved] : defaultTheme;
    } catch { return defaultTheme; }
  });
  const cssElRef = useRef(null);

  // Create the style element once; update it whenever activeTheme changes
  useEffect(() => {
    const el = document.createElement("style");
    document.head.appendChild(el);
    cssElRef.current = el;
    return () => { document.head.removeChild(el); };
  }, []);

  useEffect(() => {
    if (cssElRef.current) cssElRef.current.textContent = buildGlobalCSS(activeTheme);
  }, [activeTheme]);


  const [groups, setGroups] = useState([]);
  const [guestGames, setGuestGames] = useState([]);
  const [standaloneGames, setStandaloneGames] = useState([]);
  // planConfigs: { [planKey]: planDocument } — real-time from subscriptionPackages
  const [planConfigs, setPlanConfigs] = useState({});
  const [page, setPage] = useState("home");
  const [isDesktop, setIsDesktop] = useState(window.innerWidth >= 900);
  const [adminMenuOpen, setAdminMenuOpen] = useState(false);

  // Handle return from Stripe Checkout
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const checkout = params.get("checkout");
    if (checkout === "success") {
      const plan = params.get("plan");
      window.history.replaceState({}, "", window.location.pathname);
      // Small delay so Firestore has time to update via webhook
      setTimeout(() => {
        setPage("account");
        if (plan === "pro") {
          flash("You're now a Pro member! Welcome aboard 🎉", "✨");
        } else {
          flash("You're now a Club member! Welcome aboard 🎉", "✨");
        }
      }, 1500);
    } else if (checkout === "cancelled") {
      window.history.replaceState({}, "", window.location.pathname);
      setPage("managePlan");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onResize = () => setIsDesktop(window.innerWidth >= 900);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const [gid, setGid] = useState(null);
  const [gmid, setGmid] = useState(null);
  const [toast, setToast] = useState(null);
  const [authUser, setAuthUser] = useState(undefined); // undefined = checking, null = logged out
  const [user, setUser] = useState(null);
  const [showWelcome, setShowWelcome] = useState(false);
  const [pendingAnnouncement, setPendingAnnouncement] = useState(null);
  const [impersonating, setImpersonating] = useState(null); // { uid, name, avatar, email }
  const gamesUnsubs = useRef({});
  const groupMeta = useRef({});
  const guestGameUnsubs = useRef({});
  const guestGroupCache = useRef({});
  const knownGameIds = useRef({}); // { [groupId]: Set<gameId> } — per-group tracking

  // ── Unread chat badge tracking ──
  // unreadCounts: { [chatId]: count }, chatId is a groupId (group chat) or gameId (game chat)
  const [unreadCounts, setUnreadCounts] = useState({});
  const chatMsgTsRef = useRef({});     // { [chatId]: number[] } — recent message createdAt (ms), capped
  const lastReadRef = useRef({});      // { [chatId]: number } — this user's lastRead (ms) per chat
  const chatMsgUnsubsRef = useRef({}); // { [chatId]: unsubscribe fn }

  // ── Subscription plan configs (real-time) ──
  // Gated on authUser so the listener never fires before auth is established.
  // On mobile (indexedDBLocalPersistence) auth restoration is slower — starting
  // this listener before auth causes a permission-denied that permanently
  // cancels it, leaving planConfigs empty and all limits showing as unlimited.
  useEffect(() => {
    if (!authUser) return;
    const unsub = onSnapshot(
      collection(db, "subscriptionPackages"),
      (snap) => {
        const map = {};
        snap.docs.forEach((d) => {
          const data = d.data();
          const key = data.planKey || d.id;
          map[key] = { id: d.id, ...data };
        });
        setPlanConfigs(map);
      },
      (err) => {
        if (err.code !== "permission-denied") console.error("[planConfigs]", err);
      }
    );
    return unsub;
  }, [authUser?.uid]);

  // ── Firebase auth state listener ──
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (fbUser) => {
      if (fbUser) {
        // Set authUser immediately so the groups/games listeners start in parallel
        // with the profile fetch — don't block data loading on sequential awaits.
        setAuthUser(fbUser);
        setPage("home");
        try {
          const snap = await getDoc(doc(db, "users", fbUser.uid));
          const detectedTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
          const loginProvider = fbUser.providerData?.[0]?.providerId === "google.com" ? "google" : "email";
          if (snap.exists()) {
            const data = snap.data();
            setUser({ uid: fbUser.uid, ...data });
            if (data.theme && themes[data.theme]) {
              setActiveTheme(themes[data.theme]);
              try { localStorage.setItem("mahjong_theme", data.theme); } catch {}
            }
            const backfill = {};
            if (!data.timezone) backfill.timezone = detectedTz;
            if (!data.loginProvider) backfill.loginProvider = loginProvider;
            if (Object.keys(backfill).length) updateDoc(doc(db, "users", fbUser.uid), backfill).catch(() => {});
            if (data.notificationsEnabled !== false) {
              // Silently refresh/store the token on every sign-in.
              // This covers both returning users (notificationsEnabled=true) and new users
              // (unset). The flag is only flipped to true when the user explicitly enables
              // push via the toggle. notificationsEnabled===false → respect opt-out.
              silentlyRefreshFcmToken(fbUser.uid);
            }
            // Check for announcements — non-blocking, runs after critical path
            getDocs(query(collection(db, "adminNotifications"),
              where("type", "==", "announcement"), where("status", "==", "active")))
              .then((announcSnap) => {
                const viewed = data.viewedAnnouncements || [];
                const unseen = announcSnap.docs
                  .map(d => ({ id: d.id, ...d.data() }))
                  .filter(a => !viewed.includes(a.id))
                  .sort((a, b) => (b.publishedAt?.toMillis?.() || 0) - (a.publishedAt?.toMillis?.() || 0));
                if (unseen.length > 0) setPendingAnnouncement(unseen[0]);
              }).catch(() => {});
          } else {
            const profile = { name: fbUser.displayName || fbUser.email.split("@")[0], email: fbUser.email, avatar: randAvatar(), phone: "", timezone: detectedTz, loginProvider };
            await setDoc(doc(db, "users", fbUser.uid), profile);
            setUser({ uid: fbUser.uid, ...profile });
            setShowWelcome(true);
          }
        } catch (e) {
          setUser({ uid: fbUser.uid, name: fbUser.displayName || "Player", email: fbUser.email || "", avatar: "🐼", phone: "" });
        }
      } else {
        setAuthUser(null);
        setUser(null);
        setGroups([]);
        setGuestGames([]);
        setPage("home");
      }
    });
    return unsub;
  }, []);

  // ── Web foreground FCM handler ────────────────────────────────────────────
  // Service worker only handles background; onMessage handles foreground.
  useEffect(() => {
    if (Capacitor.isNativePlatform()) return;
    let unsub;
    messagingReady.then((msg) => {
      if (!msg) return;
      unsub = onMessage(msg, (payload) => {
        const title = payload.notification?.title || "Mahjong Club";
        const body = payload.notification?.body || "";
        showBrowserNotif(title, body, payload.data?.type);
      });
    });
    return () => { if (unsub) unsub(); };
  }, []);

  // ── Native foreground push listener ──────────────────────────────────────
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    const sub = PushNotifications.addListener("pushNotificationReceived", (notification) => {
      showBrowserNotif(notification.title, notification.body);
    });
    return () => { sub.then((h) => h.remove()); };
  }, []);

  // ── Native push tap: navigate when user taps a notification ──────────────
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    const sub = PushNotifications.addListener("pushNotificationActionPerformed", (action) => {
      const data = action.notification?.data || {};
      const { type, groupId, gameId } = data;
      if ((type === "chat" || type === "reply") && groupId) {
        setPage("group"); setGid(groupId);
      } else if ((type === "gameChat" || type === "game" || type === "gameReminder") && groupId && gameId) {
        setPage("game"); setGid(groupId); setGmid(gameId);
      } else if (type === "gameChat" && !groupId && gameId) {
        setPage("standaloneGame"); setGid(null); setGmid(gameId);
      }
    });
    return () => { sub.then((h) => h.remove()); };
  }, []);

  // ── Universal Links (iOS) / App Links (Android) ──────────────────────────
  // appUrlOpen fires when the OS routes an HTTPS link to the native app.
  // Parse the URL and store params so the deepLinkPending effect can process
  // them once the user is authenticated (handles both cold and warm starts).
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    const sub = CapApp.addListener("appUrlOpen", (event) => {
      try {
        const url = new URL(event.url);
        const gameCode = url.searchParams.get("gameCode")?.toUpperCase() || null;
        const code = url.searchParams.get("joinGroup") || null;
        const gameId = url.searchParams.get("game") || null;
        if (gameCode || code) setDeepLinkPending({ gameCode, code, gameId });
      } catch {}
    });
    return () => { sub.then((h) => h.remove()); };
  }, []);

  // ── Re-enable Firestore network on app resume ────────────────────────────
  // On iOS the WKWebView suspends JS (and drops WebSocket connections) when backgrounded.
  // Calling enableNetwork on visibility restore kicks Firestore to reconnect and re-fire
  // all active onSnapshot listeners without tearing them down.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        disableNetwork(db).catch(() => {}).finally(() => enableNetwork(db).catch(() => {}));
        // Re-register push token on foreground so rotated tokens are refreshed in Firestore.
        const uid = auth.currentUser?.uid;
        if (uid) silentlyRefreshFcmToken(uid);
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  // ── Web push notification tap: navigate when SW posts a NAVIGATE message ──
  // Fires when the user taps a push notification and the app tab is already open.
  // The cold-start case (app was closed) is handled by pendingNavigation above.
  useEffect(() => {
    if (Capacitor.isNativePlatform()) return;
    const handler = (event) => {
      if (event.data?.type !== "NAVIGATE") return;
      const { type, groupId, gameId } = event.data.data || {};
      if ((type === "chat" || type === "reply") && groupId) {
        setPage("group"); setGid(groupId);
      } else if ((type === "gameChat" || type === "game" || type === "gameReminder") && groupId && gameId) {
        setPage("game"); setGid(groupId); setGmid(gameId);
      } else if (type === "gameChat" && !groupId && gameId) {
        setPage("standaloneGame"); setGid(null); setGmid(gameId);
      }
    };
    navigator.serviceWorker?.addEventListener("message", handler);
    return () => navigator.serviceWorker?.removeEventListener("message", handler);
  }, []);

  // ── Firestore real-time listeners for groups + games ──
  // Uses effectiveUid so listeners reload automatically when impersonation starts/stops
  const effectiveUid = impersonating?.uid || authUser?.uid;
  useEffect(() => {
    if (!effectiveUid) return;
    const uid = effectiveUid;
    const q = query(collection(db, "groups"), where("memberIds", "array-contains", uid));

    const groupsUnsub = onSnapshot(q, (snap) => {
      const currentIds = new Set(snap.docs.map((d) => d.id));

      // Clean up listeners for groups no longer visible
      Object.keys(gamesUnsubs.current).forEach((id) => {
        if (!currentIds.has(id)) {
          gamesUnsubs.current[id]();
          delete gamesUnsubs.current[id];
          delete groupMeta.current[id];
          delete knownGameIds.current[id];
        }
      });

      snap.docs.forEach((d) => { groupMeta.current[d.id] = { ...d.data(), id: d.id }; });

      if (snap.empty) { setGroups([]); return; }

      snap.docs.forEach((groupDoc) => {
        if (gamesUnsubs.current[groupDoc.id]) return;
        gamesUnsubs.current[groupDoc.id] = onSnapshot(
          collection(db, "groups", groupDoc.id, "games"),
          (gamesSnap) => {
            const games = gamesSnap.docs.map((d) => ({ ...d.data(), id: d.id }));

            // Notify user about newly added games (skip on initial load per group)
            const gid = groupDoc.id;
            const knownForGroup = knownGameIds.current[gid];
            if (knownForGroup !== undefined) {
              games.forEach((gm) => {
                if (!knownForGroup.has(gm.id)) {
                  const isMember =
                    (gm.memberIds || []).includes(uid) ||
                    gm.rsvps?.[uid] !== undefined ||
                    (gm.guestIds || []).includes(uid);
                  if (isMember) {
                    const groupName = groupMeta.current[gid]?.name || "Your group";
                    showBrowserNotif(
                      `New game: ${gm.title}`,
                      `${groupName} · ${fmt(gm.date)}${gm.time ? " · " + fmtT(gm.time) : ""}`,
                      `game-${gm.id}`
                    );
                  }
                }
              });
            }
            if (knownGameIds.current[gid] === undefined) knownGameIds.current[gid] = new Set();
            games.forEach((gm) => knownGameIds.current[gid].add(gm.id));

            setGroups((prev) => {
              const meta = groupMeta.current[groupDoc.id] || {};
              const updated = { ...meta, id: groupDoc.id, games };
              const idx = prev.findIndex((g) => g.id === groupDoc.id);
              return idx >= 0
                ? prev.map((g, i) => (i === idx ? updated : g))
                : [...prev, updated];
            });
          }
        );
      });
    });

    // Listener for standalone games where this user is the host
    const standaloneUnsub = onSnapshot(
      query(collection(db, "games"), where("hostId", "==", uid)),
      (snap) => {
        setStandaloneGames(snap.docs.map((d) => ({ ...d.data(), id: d.id, isStandalone: true, groupColor: "#7c3aed", groupName: "Open Game" })));
      }
    );

    // Listener for guest games: watch the user doc's guestGameRefs array,
    // then set up individual game listeners for each ref.
    const userDocUnsub = onSnapshot(doc(db, "users", uid), (userSnap) => {
      const refs = userSnap.data()?.guestGameRefs || [];
      // Normalise key: standalone refs have groupId=null, keyed as "standalone:{gameId}"
      const refKeys = new Set(refs.map((r) => r.groupId ? `${r.groupId}:${r.gameId}` : `standalone:${r.gameId}`));

      // Clean up listeners for refs that were removed
      Object.keys(guestGameUnsubs.current).forEach((key) => {
        if (!refKeys.has(key)) {
          guestGameUnsubs.current[key]();
          delete guestGameUnsubs.current[key];
          setGuestGames((prev) => {
            if (key.startsWith("standalone:")) {
              const gmId = key.slice("standalone:".length);
              return prev.filter((g) => !(g.id === gmId && g.isStandalone));
            }
            const [gId, gmId] = key.split(":");
            return prev.filter((g) => !(g.id === gmId && g.groupId === gId));
          });
        }
      });

      if (refs.length === 0) { setGuestGames([]); return; }

      refs.forEach(({ groupId, gameId }) => {
        // ── Standalone guest game (no groupId) ──
        if (!groupId) {
          const key = `standalone:${gameId}`;
          if (guestGameUnsubs.current[key]) return;
          guestGameUnsubs.current[key] = onSnapshot(
            doc(db, "games", gameId),
            (gameSnap) => {
              if (!gameSnap.exists()) return;
              const updated = { ...gameSnap.data(), id: gameId, isStandalone: true, isGuestGame: true, groupColor: "#7c3aed", groupName: "Open Game" };
              setGuestGames((prev) => [...prev.filter((g) => !(g.id === gameId && g.isStandalone)), updated]);
            }
          );
          return;
        }

        // ── Group guest game ──
        const key = `${groupId}:${gameId}`;
        if (guestGameUnsubs.current[key]) return;

        // Fetch group metadata once, then listen to the game doc
        getDoc(doc(db, "groups", groupId)).then((gs) => {
          if (!gs.exists()) return;
          const gd = gs.data();
          guestGroupCache.current[groupId] = { name: gd.name, color: gd.color, emoji: gd.emoji, members: gd.members || [] };

          guestGameUnsubs.current[key] = onSnapshot(
            doc(db, "groups", groupId, "games", gameId),
            (gameSnap) => {
              if (!gameSnap.exists()) return;
              const gm = guestGroupCache.current[groupId];
              const updated = { ...gameSnap.data(), id: gameId, groupId, groupName: gm.name, groupColor: gm.color, groupEmoji: gm.emoji, groupMembers: gm.members, isGuestGame: true };
              setGuestGames((prev) => {
                const filtered = prev.filter((g) => !(g.id === gameId && g.groupId === groupId));
                return [...filtered, updated];
              });
            }
          );
        }).catch(() => {});
      });
    });

    return () => {
      groupsUnsub();
      standaloneUnsub();
      userDocUnsub();
      Object.values(gamesUnsubs.current).forEach((u) => u());
      Object.values(guestGameUnsubs.current).forEach((u) => u());
      gamesUnsubs.current = {};
      groupMeta.current = {};
      guestGameUnsubs.current = {};
      guestGroupCache.current = {};
    };
  }, [effectiveUid]);

  // ── Unread chat badges: lastRead listener ──
  // Single listener on users/{uid}/chatLastRead for all per-chat lastRead timestamps.
  useEffect(() => {
    if (!effectiveUid) { lastReadRef.current = {}; return; }
    const recompute = (chatId) => {
      const ts = chatMsgTsRef.current[chatId] || [];
      const lastRead = lastReadRef.current[chatId] || 0;
      const count = ts.filter((t) => t > lastRead).length;
      setUnreadCounts((prev) => (prev[chatId] === count ? prev : { ...prev, [chatId]: count }));
    };
    const unsub = onSnapshot(collection(db, "users", effectiveUid, "chatLastRead"), (snap) => {
      const map = {};
      snap.docs.forEach((d) => { map[d.id] = d.data()?.lastRead?.toMillis?.() || 0; });
      lastReadRef.current = map;
      Object.keys(chatMsgTsRef.current).forEach(recompute);
    });
    return unsub;
  }, [effectiveUid]);

  // ── Unread chat badges: per-chat message listeners ──
  // One lightweight listener per group/game chat (capped to the most recent 100
  // messages — enough to know if there are unread ones without loading full history).
  useEffect(() => {
    if (!effectiveUid) return;
    const recompute = (chatId) => {
      const ts = chatMsgTsRef.current[chatId] || [];
      const lastRead = lastReadRef.current[chatId] || 0;
      const count = ts.filter((t) => t > lastRead).length;
      setUnreadCounts((prev) => (prev[chatId] === count ? prev : { ...prev, [chatId]: count }));
    };

    const chats = {}; // chatId -> messages collection ref
    groups.forEach((g) => {
      chats[g.id] = collection(db, "groups", g.id, "messages");
      (g.games || []).forEach((gm) => {
        chats[gm.id] = collection(db, "groups", g.id, "games", gm.id, "messages");
      });
    });
    standaloneGames.forEach((gm) => { chats[gm.id] = collection(db, "games", gm.id, "messages"); });
    guestGames.forEach((gm) => {
      chats[gm.id] = gm.groupId
        ? collection(db, "groups", gm.groupId, "games", gm.id, "messages")
        : collection(db, "games", gm.id, "messages");
    });

    const currentIds = new Set(Object.keys(chats));
    Object.keys(chatMsgUnsubsRef.current).forEach((id) => {
      if (!currentIds.has(id)) {
        chatMsgUnsubsRef.current[id]();
        delete chatMsgUnsubsRef.current[id];
        delete chatMsgTsRef.current[id];
        setUnreadCounts((prev) => { if (!(id in prev)) return prev; const next = { ...prev }; delete next[id]; return next; });
      }
    });

    Object.entries(chats).forEach(([chatId, colRef]) => {
      if (chatMsgUnsubsRef.current[chatId]) return;
      const q = query(colRef, orderBy("createdAt", "desc"), limit(100));
      chatMsgUnsubsRef.current[chatId] = onSnapshot(q, (snap) => {
        chatMsgTsRef.current[chatId] = snap.docs
          .filter((d) => d.data().uid !== effectiveUid)
          .map((d) => d.data().createdAt?.toMillis?.() || 0);
        recompute(chatId);
      }, () => {});
    });
  }, [effectiveUid, groups, standaloneGames, guestGames]);

  // Tear down all chat message listeners on sign-out / impersonation change / unmount.
  useEffect(() => {
    return () => {
      Object.values(chatMsgUnsubsRef.current).forEach((u) => u());
      chatMsgUnsubsRef.current = {};
      chatMsgTsRef.current = {};
    };
  }, [effectiveUid]);

const handleSignOut = async () => {
  try {
    const currentUser = auth.currentUser;
    if (currentUser) {
      if (Capacitor.isNativePlatform()) {
        if (_nativePushToken) {
          await updateDoc(doc(db, "users", currentUser.uid), { nativePushTokens: arrayRemove(_nativePushToken) }).catch(() => {});
          _nativePushToken = null;
        }
      } else if (typeof Notification !== "undefined" && Notification.permission === "granted") {
        const msg = await messagingReady;
        if (msg) {
          const swReg = await getSwRegistration();
          const token = await getToken(msg, { vapidKey: VAPID_KEY, ...(swReg && { serviceWorkerRegistration: swReg }) }).catch(() => null);
          if (token) {
            await deleteToken(msg).catch(() => {});
            await updateDoc(doc(db, "users", currentUser.uid), { fcmTokens: arrayRemove(token) }).catch(() => {});
          }
        }
      }
    }
  } catch { /* best effort — don't block sign-out */ }
  await signOut(auth);
};

  const handleThemeChange = async (themeId) => {
    const theme = themes[themeId];
    if (!theme) return;
    setActiveTheme(theme);
    try { localStorage.setItem("mahjong_theme", themeId); } catch {}
    try { await updateDoc(doc(db, "users", authUser.uid), { theme: themeId }); } catch {}
  };

  const startImpersonating = (targetUser) => {
    setImpersonating(targetUser);
    setGroups([]);
    setGuestGames([]);
    setPage("home");
    setGid(null);
    setGmid(null);
    // Fire-and-forget audit log — does not block the UI
    hostingFn("logImpersonation")({
      action: "start", targetUid: targetUser.uid, targetName: targetUser.name,
    }).catch(() => {}); // non-blocking; failure is silent to the admin
  };

  const stopImpersonating = () => {
    const prev = impersonating;
    setImpersonating(null);
    setGroups([]);
    setGuestGames([]);
    setPage("home");
    setGid(null);
    setGmid(null);
    if (prev) {
      hostingFn("logImpersonation")({
        action: "stop", targetUid: prev.uid, targetName: prev.name,
      }).catch(() => {});
    }
  };

  // ── Deep-link invite processing ──
  // pendingJoin: initialized once from URL params or localStorage — handles web cold starts.
  // deepLinkPending: updated by the appUrlOpen listener — handles native Universal/App Links.
  const [deepLinkPending, setDeepLinkPending] = useState(null);
  const [pendingJoin] = useState(() => {
    const p = new URLSearchParams(window.location.search);
    let code = p.get("joinGroup"), gameId = p.get("game"), gameCode = p.get("gameCode");
    if (code || gameCode) {
      // Persist so a mid-flow page refresh doesn't lose the invite
      if (code) localStorage.setItem("pendingJoinCode", code);
      if (gameId) localStorage.setItem("pendingJoinGameId", gameId);
      if (gameCode) localStorage.setItem("pendingGameCode", gameCode.toUpperCase());
      window.history.replaceState({}, "", window.location.pathname);
    } else {
      // Recover from localStorage if URL params were lost (e.g. after refresh)
      code = localStorage.getItem("pendingJoinCode") || null;
      gameId = localStorage.getItem("pendingJoinGameId") || null;
      gameCode = localStorage.getItem("pendingGameCode") || null;
    }
    return { code, gameId, gameCode };
  });

  // pendingNavigation: push notification tap when app was closed — reads ?navGroup / ?navGame
  const [pendingNavigation] = useState(() => {
    const p = new URLSearchParams(window.location.search);
    const navGroup = p.get("navGroup");
    const navGame = p.get("navGame");
    if (navGroup || navGame) {
      window.history.replaceState({}, "", window.location.pathname);
      return { groupId: navGroup, gameId: navGame };
    }
    return null;
  });

  useEffect(() => {
    if (!pendingNavigation || !authUser || !user) return;
    const { groupId, gameId } = pendingNavigation;
    if (groupId && gameId) { setPage("game"); setGid(groupId); setGmid(gameId); }
    else if (groupId)      { setPage("group"); setGid(groupId); }
    else if (gameId)       { setPage("standaloneGame"); setGmid(gameId); }
  }, [pendingNavigation, authUser?.uid, user?.uid]);

  useEffect(() => {
    if ((!pendingJoin.code && !pendingJoin.gameCode) || !authUser || !user) return;
    const { code, gameId, gameCode } = pendingJoin;
    const go_ = (p, g, gm) => { setPage(p); setGid(g || null); setGmid(gm || null); };

    // ── Game code invite (direct game join via ?gameCode=) ──
    if (gameCode && !code) {
      localStorage.removeItem("pendingGameCode");
      getDoc(doc(db, "gameCodes", gameCode))
        .then(async (codeSnap) => {
          if (!codeSnap.exists()) {
            setToast({ msg: "Game code is invalid or expired.", icon: "❌" }); setTimeout(() => setToast(null), 2600); return;
          }
          const { groupId, gameId: gId } = codeSnap.data();
          try {
            const gameRef = groupId
              ? doc(db, "groups", groupId, "games", gId)
              : doc(db, "games", gId);
            const gameSnap = await getDoc(gameRef);
            if (!gameSnap.exists()) {
              setToast({ msg: "Game not found.", icon: "❌" }); setTimeout(() => setToast(null), 2600); return;
            }
            const gData = gameSnap.data();

            // Already a participant — backfill registeredGuests if missing (legacy join), then navigate
            if ((gData.rsvps?.[authUser.uid] !== undefined) || (gData.guestIds || []).includes(authUser.uid)) {
              const hasEntry = (gData.registeredGuests || []).some(g => g.id === authUser.uid);
              if (!hasEntry) {
                updateDoc(gameRef, { registeredGuests: arrayUnion({ id: authUser.uid, name: user.name, avatar: user.avatar }) }).catch(() => {});
              }
              if (groupId) go_("guestGame", groupId, gId); else go_("standaloneGame", null, gId);
              return;
            }

            // Check seat capacity
            const yesCount = Object.values(gData.rsvps || {}).filter(v => v === "yes").length;
            const confirmedManualGuests = (gData.guests || []).filter(g => !(gData.waitlist || []).includes(g.id)).length;
            const isFull = (yesCount + confirmedManualGuests) >= (gData.seats || 4);

            // Profile info so name/avatar shows in RSVP list and seating
            const userInfo = { id: authUser.uid, name: user.name, avatar: user.avatar };

            if (isFull) {
              await updateDoc(gameRef, {
                guestIds: arrayUnion(authUser.uid),
                waitlist: arrayUnion(authUser.uid),
                registeredGuests: arrayUnion(userInfo),
              });
              await updateDoc(doc(db, "users", authUser.uid), { guestGameRefs: arrayUnion({ groupId: groupId || null, gameId: gId }) });
              setToast({ msg: "Game is full — you're on the waitlist", icon: "⏳" });
            } else {
              await updateDoc(gameRef, {
                guestIds: arrayUnion(authUser.uid),
                [`rsvps.${authUser.uid}`]: "yes",
                registeredGuests: arrayUnion(userInfo),
              });
              await updateDoc(doc(db, "users", authUser.uid), { guestGameRefs: arrayUnion({ groupId: groupId || null, gameId: gId }) });
              setToast({ msg: "You're in! See you at the table 🀄", icon: "🎉" });
            }
            setTimeout(() => setToast(null), 3000);
            if (groupId) go_("guestGame", groupId, gId); else go_("standaloneGame", null, gId);
          } catch {
            setToast({ msg: "Could not join game.", icon: "❌" }); setTimeout(() => setToast(null), 2600);
          }
        })
        .catch(() => { setToast({ msg: "Error processing game invite.", icon: "❌" }); setTimeout(() => setToast(null), 2600); });
      return;
    }

    if (!code) return;
    // Clear localStorage now that we're processing the invite
    localStorage.removeItem("pendingJoinCode");
    localStorage.removeItem("pendingJoinGameId");
    localStorage.removeItem("pendingGameCode");
    getDocs(query(collection(db, "groups"), where("code", "==", code)))
      .then(async (snap) => {
        if (snap.empty) { setToast({ msg: "Invite link is invalid or expired.", icon: "❌" }); setTimeout(() => setToast(null), 2600); return; }
        const groupDoc = snap.docs[0];
        const gid_ = groupDoc.id;
        const data = groupDoc.data();
        if (gameId) {
          // Game-only invite: add user as a guest on the game, do NOT join the group
          try {
            const gameRef = doc(db, "groups", gid_, "games", gameId);
            const gameSnap = await getDoc(gameRef);
            const gData = gameSnap.exists() ? gameSnap.data() : {};
            const yesCount = Object.values(gData.rsvps || {}).filter(v => v === "yes").length;
            const confirmedManualGuests = (gData.guests || []).filter(g => !(gData.waitlist || []).includes(g.id)).length;
            const isFull = (yesCount + confirmedManualGuests) >= (gData.seats || 4);
            const userInfo = { id: authUser.uid, name: user.name, avatar: user.avatar };

            if ((gData.rsvps?.[authUser.uid] !== undefined) || (gData.guestIds || []).includes(authUser.uid)) {
              go_("guestGame", gid_, gameId); return;
            }

            if (isFull) {
              await updateDoc(gameRef, { guestIds: arrayUnion(authUser.uid), waitlist: arrayUnion(authUser.uid), registeredGuests: arrayUnion(userInfo) });
              setToast({ msg: "Game is full — you're on the waitlist", icon: "⏳" });
            } else {
              await updateDoc(gameRef, { guestIds: arrayUnion(authUser.uid), [`rsvps.${authUser.uid}`]: "yes", registeredGuests: arrayUnion(userInfo) });
              setToast({ msg: "You're in! See you at the table 🀄", icon: "🎉" });
            }
            await updateDoc(doc(db, "users", authUser.uid), { guestGameRefs: arrayUnion({ groupId: gid_, gameId }) });
            go_("guestGame", gid_, gameId);
            setTimeout(() => setToast(null), 3000);
          } catch {
            setToast({ msg: "Could not join game.", icon: "❌" }); setTimeout(() => setToast(null), 2600);
          }
        } else {
          // Group invite: add user to the group
          if (!(data.memberIds || []).includes(authUser.uid)) {
            await runTransaction(db, async (tx) => {
              const ref = doc(db, "groups", gid_);
              const latest = await tx.get(ref);
              const d = latest.data();
              if ((d.memberIds || []).includes(authUser.uid)) return;
              tx.update(ref, {
                memberIds: [...(d.memberIds || []), authUser.uid],
                members: [...(d.members || []), { id: authUser.uid, name: user.name, avatar: user.avatar }],
              });
            });
            setToast({ msg: `Joined ${data.name}!`, icon: "🎊" }); setTimeout(() => setToast(null), 2600);
          }
          go_("group", gid_);
        }
      })
      .catch(() => { setToast({ msg: "Error processing invite.", icon: "❌" }); setTimeout(() => setToast(null), 2600); });
  }, [authUser?.uid, user?.uid]);

  // ── Process deep links that arrived via appUrlOpen (native Universal/App Links) ──
  // Mirrors the pendingJoin logic exactly; runs after the user is authenticated.
  useEffect(() => {
    if (!deepLinkPending || !authUser || !user) return;
    const { code, gameId, gameCode } = deepLinkPending;
    setDeepLinkPending(null);
    const go_ = (p, g, gm) => { setPage(p); setGid(g || null); setGmid(gm || null); };

    if (gameCode && !code) {
      getDoc(doc(db, "gameCodes", gameCode))
        .then(async (codeSnap) => {
          if (!codeSnap.exists()) {
            setToast({ msg: "Game code is invalid or expired.", icon: "❌" }); setTimeout(() => setToast(null), 2600); return;
          }
          const { groupId, gameId: gId } = codeSnap.data();
          try {
            const gameRef = groupId ? doc(db, "groups", groupId, "games", gId) : doc(db, "games", gId);
            const gameSnap = await getDoc(gameRef);
            if (!gameSnap.exists()) { setToast({ msg: "Game not found.", icon: "❌" }); setTimeout(() => setToast(null), 2600); return; }
            const gData = gameSnap.data();
            if ((gData.rsvps?.[authUser.uid] !== undefined) || (gData.guestIds || []).includes(authUser.uid)) {
              const hasEntry = (gData.registeredGuests || []).some(g => g.id === authUser.uid);
              if (!hasEntry) updateDoc(gameRef, { registeredGuests: arrayUnion({ id: authUser.uid, name: user.name, avatar: user.avatar }) }).catch(() => {});
              if (groupId) go_("guestGame", groupId, gId); else go_("standaloneGame", null, gId);
              return;
            }
            const yesCount = Object.values(gData.rsvps || {}).filter(v => v === "yes").length;
            const confirmedManualGuests = (gData.guests || []).filter(g => !(gData.waitlist || []).includes(g.id)).length;
            const isFull = (yesCount + confirmedManualGuests) >= (gData.seats || 4);
            const userInfo = { id: authUser.uid, name: user.name, avatar: user.avatar };
            if (isFull) {
              await updateDoc(gameRef, { guestIds: arrayUnion(authUser.uid), waitlist: arrayUnion(authUser.uid), registeredGuests: arrayUnion(userInfo) });
              await updateDoc(doc(db, "users", authUser.uid), { guestGameRefs: arrayUnion({ groupId: groupId || null, gameId: gId }) });
              setToast({ msg: "Game is full — you're on the waitlist", icon: "⏳" });
            } else {
              await updateDoc(gameRef, { guestIds: arrayUnion(authUser.uid), [`rsvps.${authUser.uid}`]: "yes", registeredGuests: arrayUnion(userInfo) });
              await updateDoc(doc(db, "users", authUser.uid), { guestGameRefs: arrayUnion({ groupId: groupId || null, gameId: gId }) });
              setToast({ msg: "You're in! See you at the table 🀄", icon: "🎉" });
            }
            setTimeout(() => setToast(null), 3000);
            if (groupId) go_("guestGame", groupId, gId); else go_("standaloneGame", null, gId);
          } catch { setToast({ msg: "Could not join game.", icon: "❌" }); setTimeout(() => setToast(null), 2600); }
        })
        .catch(() => { setToast({ msg: "Error processing game invite.", icon: "❌" }); setTimeout(() => setToast(null), 2600); });
      return;
    }

    if (!code) return;
    getDocs(query(collection(db, "groups"), where("code", "==", code)))
      .then(async (snap) => {
        if (snap.empty) { setToast({ msg: "Invite link is invalid or expired.", icon: "❌" }); setTimeout(() => setToast(null), 2600); return; }
        const groupDoc = snap.docs[0];
        const gid_ = groupDoc.id;
        const data = groupDoc.data();
        if (gameId) {
          try {
            const gameRef = doc(db, "groups", gid_, "games", gameId);
            const gameSnap = await getDoc(gameRef);
            const gData = gameSnap.exists() ? gameSnap.data() : {};
            const yesCount = Object.values(gData.rsvps || {}).filter(v => v === "yes").length;
            const confirmedManualGuests = (gData.guests || []).filter(g => !(gData.waitlist || []).includes(g.id)).length;
            const isFull = (yesCount + confirmedManualGuests) >= (gData.seats || 4);
            const userInfo = { id: authUser.uid, name: user.name, avatar: user.avatar };
            if ((gData.rsvps?.[authUser.uid] !== undefined) || (gData.guestIds || []).includes(authUser.uid)) {
              go_("guestGame", gid_, gameId); return;
            }
            if (isFull) {
              await updateDoc(gameRef, { guestIds: arrayUnion(authUser.uid), waitlist: arrayUnion(authUser.uid), registeredGuests: arrayUnion(userInfo) });
              setToast({ msg: "Game is full — you're on the waitlist", icon: "⏳" });
            } else {
              await updateDoc(gameRef, { guestIds: arrayUnion(authUser.uid), [`rsvps.${authUser.uid}`]: "yes", registeredGuests: arrayUnion(userInfo) });
              setToast({ msg: "You're in! See you at the table 🀄", icon: "🎉" });
            }
            await updateDoc(doc(db, "users", authUser.uid), { guestGameRefs: arrayUnion({ groupId: gid_, gameId }) });
            go_("guestGame", gid_, gameId);
            setTimeout(() => setToast(null), 3000);
          } catch { setToast({ msg: "Could not join game.", icon: "❌" }); setTimeout(() => setToast(null), 2600); }
        } else {
          if (!(data.memberIds || []).includes(authUser.uid)) {
            await runTransaction(db, async (tx) => {
              const ref = doc(db, "groups", gid_);
              const latest = await tx.get(ref);
              const d = latest.data();
              if ((d.memberIds || []).includes(authUser.uid)) return;
              tx.update(ref, {
                memberIds: [...(d.memberIds || []), authUser.uid],
                members: [...(d.members || []), { id: authUser.uid, name: user.name, avatar: user.avatar }],
              });
            });
            setToast({ msg: `Joined ${data.name}!`, icon: "🎊" }); setTimeout(() => setToast(null), 2600);
          }
          go_("group", gid_);
        }
      })
      .catch(() => { setToast({ msg: "Error processing invite.", icon: "❌" }); setTimeout(() => setToast(null), 2600); });
  }, [deepLinkPending, authUser?.uid, user?.uid]);

  const group = groups.find((g) => g.id === gid) || null;
  const game = group ? group.games.find((g) => g.id === gmid) || null : null;
  const guestGame = guestGames.find((g) => g.id === gmid && g.groupId === gid) || null;
  const guestGroupMeta = guestGame
    ? { id: guestGame.groupId, name: guestGame.groupName, color: guestGame.groupColor, emoji: guestGame.groupEmoji, members: [], openInvites: false, games: [] }
    : null;

  const scrollRef = useRef(null);
  const prevPageRef = useRef("home");
  const go = (p, g, gm) => {
    prevPageRef.current = page;
    setPage(p); if (g !== undefined) setGid(g); if (gm !== undefined) setGmid(gm || null);
  };
  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = 0; }, [page]);
  const flash = (msg, icon) => { setToast({ msg, icon: icon || "✅" }); setTimeout(() => setToast(null), 6000); };

  // Mark a chat as read when the user navigates into its group or game detail page.
  useEffect(() => {
    if (!effectiveUid) return;
    let chatId = null;
    if (page === "group" && gid) chatId = gid;
    else if ((page === "game" || page === "guestGame" || page === "standaloneGame") && gmid) chatId = gmid;
    if (!chatId) return;
    setDoc(doc(db, "users", effectiveUid, "chatLastRead", chatId), { lastRead: serverTimestamp() }, { merge: true }).catch(() => {});
  }, [page, gid, gmid, effectiveUid]);

  // ── Loading / auth gate ──
  if (authUser === undefined) {
    return (
      <div className="app-shell" style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", flexDirection: "column", gap: 16 }}>
        <div style={{ fontSize: 55, filter: "drop-shadow(0 6px 18px rgba(var(--shadow-rgb),.3))" }}>🀄</div>
        <div style={{ fontFamily: "'Inter',sans-serif", fontSize: 19, color: "var(--primary-muted)" }}>Loading…</div>
      </div>
    );
  }
  if (!authUser) {
    return (
      <div className="app-shell">
        <AuthScreen />
      </div>
    );
  }

  const uid = impersonating?.uid || authUser.uid;
  const displayUser = impersonating || user; // profile shown throughout the app
  // Live plan config for the current user (falls back to defaults if not yet loaded)
  const userPlanCfg = planConfigs[getPlan(displayUser)] ?? null;

  const NAV_ITEMS = [
    { id: "home",    icon: "🀄", label: "Home"    },
    { id: "games",   icon: "🀅", label: "Games"   },
    { id: "groups",  icon: "👥", label: "Groups"  },
    { id: "account", icon: "👤", label: "Account" },
  ];
  const GROUP_PAGES = ["groups","group","newGroup","joinGroup","editGroup","newGame","invite","newChoice"];
  const GAMES_PAGES = ["games","guestGame","standaloneGame","game","editGame"];
  const totalUnread = Object.values(unreadCounts).reduce((a, b) => a + b, 0);

  // Admin hub renders outside the app shell (full viewport)
  if (page === "adminHub" && user?.isAdmin) {
    return <AdminHub uid={authUser.uid} user={user} go={(p) => setPage(p)} flash={flash} onImpersonate={startImpersonating} />;
  }

  return (
    <>
    {/* Desktop admin dropdown — only shown on wide screens for admin users */}
    {isDesktop && user?.isAdmin && !impersonating && (
      <div style={{ position: "fixed", top: 16, right: 24, zIndex: 5000 }}>
        <button
          onClick={() => setAdminMenuOpen(v => !v)}
          style={{
            background: adminMenuOpen ? "linear-gradient(135deg,#2d1b4e,#5a2d6b)" : "rgba(45,27,78,0.9)",
            border: "1px solid rgba(155,110,168,0.4)", borderRadius: 10,
            padding: "8px 16px", color: "#fff", fontSize: 13, fontWeight: 700,
            cursor: "pointer", fontFamily: "'Inter',sans-serif",
            display: "flex", alignItems: "center", gap: 7,
            boxShadow: "0 4px 16px rgba(45,27,78,0.35)",
            backdropFilter: "blur(12px)",
          }}
        >
          🔐 Admin {adminMenuOpen ? "▲" : "▼"}
        </button>
        {adminMenuOpen && (
          <>
            <div onClick={() => setAdminMenuOpen(false)} style={{ position: "fixed", inset: 0, zIndex: -1 }} />
            <div style={{
              position: "absolute", top: "calc(100% + 6px)", right: 0,
              background: "var(--bg-popup)", borderRadius: 14,
              boxShadow: "0 8px 32px rgba(45,27,78,0.18)", border: "1px solid rgba(155,110,168,0.15)",
              overflow: "hidden", minWidth: 180, backdropFilter: "blur(16px)",
            }}>
              <button onClick={() => { setPage("adminHub"); setAdminMenuOpen(false); }} style={{
                width: "100%", padding: "12px 16px", background: "none", border: "none",
                textAlign: "left", fontSize: 14, fontWeight: 700, color: "#2d1b4e",
                cursor: "pointer", fontFamily: "'Inter',sans-serif",
                display: "flex", alignItems: "center", gap: 9,
                borderBottom: "1px solid rgba(155,110,168,0.1)",
              }}>🏛️ Admin Hub</button>
              <button onClick={() => { setPage("account"); setAdminMenuOpen(false); }} style={{
                width: "100%", padding: "12px 16px", background: "none", border: "none",
                textAlign: "left", fontSize: 14, fontWeight: 600, color: "#7a5090",
                cursor: "pointer", fontFamily: "'Inter',sans-serif",
                display: "flex", alignItems: "center", gap: 9,
              }}>👤 My Profile</button>
            </div>
          </>
        )}
      </div>
    )}

    <div className="app-shell">

      {/* iOS status-bar colour strip — position:absolute inside the shell so it isn't
          clipped by overflow:hidden in WKWebView the way position:fixed can be. */}
      {Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios" && (
        <div style={{
          position: "absolute", top: 0, left: 0, right: 0,
          height: HEADER_BTN_TOP,
          background: activeTheme?.primary || "#c9607a",
          zIndex: 99999,
          pointerEvents: "none",
        }} />
      )}

      {/* Impersonation banner */}
      {impersonating && (
        <div style={{
          position: "fixed", top: "env(safe-area-inset-top, 0px)", left: "50%", transform: "translateX(-50%)",
          width: "100%", maxWidth: 480, zIndex: 10000,
          background: "linear-gradient(135deg,#2d1b4e,#5a2d6b)",
          padding: "10px 16px", display: "flex", alignItems: "center", gap: 10,
          boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
        }}>
          <span style={{ fontSize: 21 }}>{impersonating.avatar}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 800, color: "rgba(255,255,255,0.6)", textTransform: "uppercase", letterSpacing: 1, fontFamily: "'Inter',sans-serif" }}>Admin · Viewing as</div>
            <div style={{ fontSize: 14, fontWeight: 700, color: "#fff", fontFamily: "'Inter',sans-serif", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{impersonating.name} · {impersonating.email}</div>
          </div>
          <button onClick={stopImpersonating} style={{ background: "rgba(255,255,255,0.18)", border: "1px solid rgba(255,255,255,0.3)", borderRadius: 999, padding: "5px 12px", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "'Inter',sans-serif", flexShrink: 0 }}>Exit</button>
        </div>
      )}

      {showWelcome && <WelcomeModal onClose={() => { setShowWelcome(false); go("account"); }} />}
      {pendingAnnouncement && (
        <AnnouncementModal
          announcement={pendingAnnouncement}
          onClose={async () => {
            const id = pendingAnnouncement.id;
            setPendingAnnouncement(null);
            try {
              await updateDoc(doc(db, "users", user.uid), { viewedAnnouncements: arrayUnion(id) });
              setUser(u => ({ ...u, viewedAnnouncements: [...(u.viewedAnnouncements || []), id] }));
            } catch { /* non-critical */ }
          }}
        />
      )}

      {/* Page content + toast — wrapped so toast floats just above the nav */}
      <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
        {toast && (
          <div style={{ position: "absolute", top: 16, left: "50%", transform: "translateX(-50%)", zIndex: 9999, width: "calc(100% - 32px)", maxWidth: 420, display: "flex", justifyContent: "center", pointerEvents: "none" }}>
            <div className="bIn" style={{
              background: "linear-gradient(135deg,#1a1a2a,#2e2e42)",
              color: "#fff", borderRadius: 999, padding: "10px 22px",
              fontWeight: 700, fontSize: 14, whiteSpace: "normal", textAlign: "center",
              boxShadow: "0 6px 28px rgba(0,0,0,0.55)",
              border: "1px solid rgba(255,255,255,0.12)",
            }}>{toast.icon} {toast.msg}</div>
          </div>
        )}
      <div ref={scrollRef} data-scroll-container style={{ height: "100%", overflowY: "auto", WebkitOverflowScrolling: "touch", paddingBottom: 16, paddingTop: impersonating ? "calc(env(safe-area-inset-top, 0px) + 52px)" : 0 }}>
        {page === "home" && <Home groups={groups} guestGames={guestGames} standaloneGames={standaloneGames} go={go} user={displayUser} activeTheme={activeTheme} planCfg={userPlanCfg} flash={flash} onNew={() => go("newChoice")} unreadCounts={unreadCounts} />}
        {page === "games" && <GamesPage groups={groups} guestGames={guestGames} standaloneGames={standaloneGames} go={go} user={displayUser} unreadCounts={unreadCounts} />}
        {page === "groups" && <GroupsPage groups={groups} go={go} user={displayUser} planCfg={userPlanCfg} flash={flash} onNew={() => go("newChoice")} unreadCounts={unreadCounts} />}
        {page === "newChoice" && <NewChoice uid={uid} groups={groups} user={displayUser} planCfg={userPlanCfg} standaloneGames={standaloneGames} go={go} flash={flash} onBack={() => go("home")} />}
        {page === "account" && <Account uid={uid} user={displayUser} setUser={setUser} groups={groups} guestGames={guestGames} flash={flash} go={go} onSignOut={handleSignOut} isAdmin={!!user?.isAdmin} onImpersonate={startImpersonating} isImpersonating={!!impersonating} activeThemeId={activeTheme.id} onThemeChange={handleThemeChange} planCfg={userPlanCfg} onInstallPWA={installBanner.install} canInstallPWA={installBanner.canPrompt} isIOSWeb={installBanner.isIOS} />}
        {page === "newGroup" && (
          <NewGroup onBack={() => go("groups")} themeColor={activeTheme.primary}
            onSave={async (g) => {
              if (!canAddGroup(groups, user, userPlanCfg).ok) {
                const lim = getPlanLimits(userPlanCfg);
                flash(`Your plan allows up to ${isFinite(lim.maxGroups) ? lim.maxGroups : "∞"} groups`, "🔒"); go("groups"); return;
              }
              try {
                const groupData = { ...g, members: [{ id: uid, name: user.name, avatar: user.avatar, host: true }], memberIds: [uid] };
                await setDoc(doc(db, "groups", g.id), groupData);
                // Optimistically add to state so the group page renders immediately
                // before the onSnapshot round-trip completes
                setGroups((prev) => [...prev, { ...groupData, id: g.id, games: [] }]);
                go("group", g.id); flash("Group created!", "🎉");
              } catch { flash("Error creating group", "❌"); }
            }} />
        )}
        {page === "joinGroup" && (
          <JoinGroup uid={uid} groups={groups} user={user} planCfg={userPlanCfg} onBack={() => go("home")}
            onJoin={async (id) => {
              if (!canAddGroup(groups, user, userPlanCfg).ok) {
                flash("Group limit reached — upgrade your plan to add more", "🔒"); go("account"); return;
              }
              try {
                await runTransaction(db, async (tx) => {
                  const ref = doc(db, "groups", id);
                  const snap = await tx.get(ref);
                  const data = snap.data();
                  if ((data.memberIds || []).includes(uid)) return;
                  tx.update(ref, {
                    memberIds: [...(data.memberIds || []), uid],
                    members: [...(data.members || []), { id: uid, name: user.name, avatar: user.avatar }],
                  });
                });
                go("group", id); flash("Joined!", "🎊");
              } catch { flash("Error joining group", "❌"); }
            }}
            onJoinGame={async (groupId, gameId, isStandalone) => {
              try {
                const gameRef = isStandalone
                  ? doc(db, "games", gameId)
                  : doc(db, "groups", groupId, "games", gameId);
                const gameSnap = await getDoc(gameRef);
                const gData = gameSnap.data() || {};
                if ((gData.rsvps?.[uid] !== undefined) || (gData.guestIds || []).includes(uid)) {
                  flash("You've already joined this game!", "ℹ️");
                  if (isStandalone) go("standaloneGame", null, gameId);
                  else go("guestGame", groupId, gameId);
                  return;
                }
                const userInfo = { id: uid, name: user.name, avatar: user.avatar };
                if (isStandalone) {
                  await updateDoc(gameRef, {
                    guestIds: arrayUnion(uid), [`rsvps.${uid}`]: "yes",
                    registeredGuests: arrayUnion(userInfo),
                  });
                  await updateDoc(doc(db, "users", uid), {
                    guestGameRefs: arrayUnion({ groupId: null, gameId }),
                  });
                  go("standaloneGame", null, gameId);
                } else {
                  await updateDoc(gameRef, {
                    guestIds: arrayUnion(uid), [`rsvps.${uid}`]: "yes",
                    registeredGuests: arrayUnion(userInfo),
                  });
                  await updateDoc(doc(db, "users", uid), {
                    guestGameRefs: arrayUnion({ groupId, gameId }),
                  });
                  go("guestGame", groupId, gameId);
                }
                flash("You're in! See you at the table 🀄", "🎉");
              } catch { flash("Could not join game", "❌"); }
            }} />
        )}
        {page === "editGroup" && group && (
          <EditGroup group={group} onBack={() => go("group", group.id)}
            onSave={async (updates) => {
              try {
                await updateDoc(doc(db, "groups", group.id), updates);
                go("group", group.id); flash("Group updated!", "✨");
              } catch { flash("Error updating group", "❌"); }
            }}
            onArchive={async () => {
              try {
                await updateDoc(doc(db, "groups", group.id), {
                  status: "archived", archivedAt: serverTimestamp(), updatedAt: serverTimestamp(),
                });
                setGroups((prev) => prev.map((g) => g.id === group.id ? { ...g, status: "archived" } : g));
                go("groups"); flash("Group archived", "📦");
              } catch { flash("Error archiving group", "❌"); }
            }}
            onArchiveAndMove={async (scheduledGames) => {
              try {
                const batch = writeBatch(db);
                for (const gm of scheduledGames) {
                  const { id: gmId, groupId: _gid, ...gmData } = gm;
                  batch.set(doc(db, "games", gmId), { ...gmData, isStandalone: true });
                  batch.delete(doc(db, "groups", group.id, "games", gmId));
                }
                batch.update(doc(db, "groups", group.id), {
                  status: "archived", archivedAt: serverTimestamp(), updatedAt: serverTimestamp(),
                });
                await batch.commit();
                for (const gm of scheduledGames) {
                  for (const p of (gm.players || [])) {
                    if (!p.uid || p.uid === gm.hostId) continue;
                    try {
                      const uRef = doc(db, "users", p.uid);
                      await updateDoc(uRef, { guestGameRefs: arrayRemove({ groupId: group.id, gameId: gm.id }) });
                      await updateDoc(uRef, { guestGameRefs: arrayUnion({ groupId: null, gameId: gm.id }) });
                    } catch { /* best effort */ }
                  }
                }
                setGroups((prev) => prev.map((g) => g.id === group.id ? { ...g, status: "archived" } : g));
                go("groups"); flash("Games moved & group archived", "📦");
              } catch { flash("Error archiving group", "❌"); }
            }}
            onArchiveAll={async (scheduledGames) => {
              try {
                const batch = writeBatch(db);
                for (const gm of scheduledGames) {
                  batch.update(doc(db, "groups", group.id, "games", gm.id), {
                    status: "archived", archivedAt: serverTimestamp(), updatedAt: serverTimestamp(),
                  });
                }
                batch.update(doc(db, "groups", group.id), {
                  status: "archived", archivedAt: serverTimestamp(), updatedAt: serverTimestamp(),
                });
                await batch.commit();
                setGroups((prev) => prev.map((g) => g.id === group.id ? { ...g, status: "archived" } : g));
                go("groups"); flash("Group & games archived", "📦");
              } catch { flash("Error archiving group", "❌"); }
            }} />
        )}
        {page === "group" && group && (
          <Group uid={uid} group={group} go={go} flash={flash} user={displayUser} planCfg={userPlanCfg} groups={groups} unreadCounts={unreadCounts}
            onLeave={async () => {
              try {
                await runTransaction(db, async (tx) => {
                  const ref = doc(db, "groups", group.id);
                  const snap = await tx.get(ref);
                  const data = snap.data();
                  tx.update(ref, {
                    memberIds: (data.memberIds || []).filter((id) => id !== uid),
                    members: (data.members || []).filter((m) => m.id !== uid),
                  });
                });
                // Remove user from RSVP/guest lists on all group games (best effort)
                try {
                  const gamesSnap = await getDocs(collection(db, "groups", group.id, "games"));
                  if (!gamesSnap.empty) {
                    const batch = writeBatch(db);
                    gamesSnap.docs.forEach((d) => {
                      const gm = d.data();
                      const updates = {};
                      if (gm.rsvps?.[uid]) updates[`rsvps.${uid}`] = deleteField();
                      if ((gm.guestIds || []).includes(uid)) {
                        updates.guestIds = arrayRemove(uid);
                        updates.guests = (gm.guests || []).filter((g) => g.id !== uid);
                        updates.registeredGuests = (gm.registeredGuests || []).filter((g) => g.id !== uid);
                      }
                      if ((gm.waitlist || []).includes(uid)) updates.waitlist = arrayRemove(uid);
                      if (Object.keys(updates).length > 0) batch.update(d.ref, updates);
                    });
                    await batch.commit();
                  }
                } catch { /* best effort — membership removal already succeeded */ }
                // Also clean up any guestGameRefs pointing to this group's games
                try {
                  await updateDoc(doc(db, "users", uid), {
                    guestGameRefs: (await getDoc(doc(db, "users", uid))).data()?.guestGameRefs?.filter((r) => r.groupId !== group.id) ?? [],
                  });
                } catch { /* best effort */ }
                setGroups((prev) => prev.filter((g) => g.id !== group.id));
                go("groups"); flash("Left group");
              } catch { flash("Error leaving group", "❌"); }
            }}
            onTransferAndLeave={async (newHostId) => {
              try {
                await runTransaction(db, async (tx) => {
                  const ref = doc(db, "groups", group.id);
                  const snap = await tx.get(ref);
                  const data = snap.data();
                  tx.update(ref, {
                    memberIds: (data.memberIds || []).filter((id) => id !== uid),
                    members: (data.members || [])
                      .filter((m) => m.id !== uid)
                      .map((m) => m.id === newHostId ? { ...m, host: true } : m),
                  });
                });
                // Remove user from RSVP/guest lists on all group games (best effort)
                try {
                  const gamesSnap = await getDocs(collection(db, "groups", group.id, "games"));
                  if (!gamesSnap.empty) {
                    const batch = writeBatch(db);
                    gamesSnap.docs.forEach((d) => {
                      const gm = d.data();
                      const updates = {};
                      if (gm.rsvps?.[uid]) updates[`rsvps.${uid}`] = deleteField();
                      if ((gm.guestIds || []).includes(uid)) {
                        updates.guestIds = arrayRemove(uid);
                        updates.guests = (gm.guests || []).filter((g) => g.id !== uid);
                        updates.registeredGuests = (gm.registeredGuests || []).filter((g) => g.id !== uid);
                      }
                      if ((gm.waitlist || []).includes(uid)) updates.waitlist = arrayRemove(uid);
                      if (Object.keys(updates).length > 0) batch.update(d.ref, updates);
                    });
                    await batch.commit();
                  }
                } catch { /* best effort */ }
                try {
                  await updateDoc(doc(db, "users", uid), {
                    guestGameRefs: (await getDoc(doc(db, "users", uid))).data()?.guestGameRefs?.filter((r) => r.groupId !== group.id) ?? [],
                  });
                } catch { /* best effort */ }
                setGroups((prev) => prev.filter((g) => g.id !== group.id));
                go("groups"); flash("Host transferred — group left", "👑");
              } catch { flash("Error leaving group", "❌"); }
            }}
            onTransferHost={async (newHostId) => {
              try {
                await runTransaction(db, async (tx) => {
                  const ref = doc(db, "groups", group.id);
                  const snap = await tx.get(ref);
                  const data = snap.data();
                  tx.update(ref, {
                    members: (data.members || []).map((m) =>
                      m.id === newHostId ? { ...m, host: true } :
                      m.id === uid ? { ...m, host: false } : m
                    ),
                  });
                });
                flash("Host transferred!", "👑");
              } catch { flash("Error transferring host", "❌"); }
            }} />
        )}
        {page === "newGame" && group && (
          <NewGame uid={uid} user={user} group={group} planCfg={userPlanCfg} onBack={() => go("group", group.id)}
            onSave={async (games) => {
              const arr = Array.isArray(games) ? games : [games];
              const isHosting = arr[0].hostId === uid;
              if (isHosting) {
                const hostCheck = canHostGame(user, groups, userPlanCfg);
                if (!hostCheck.ok) {
                  flash("Hosted game limit reached — upgrade for unlimited games", "🔒");
                  return;
                }
              }
              try {
                const batch = writeBatch(db);
                arr.forEach((gm) => {
                  batch.set(doc(db, "groups", group.id, "games", gm.id), gm);
                  if (gm.joinCode) {
                    batch.set(doc(db, "gameCodes", gm.joinCode), { groupId: group.id, gameId: gm.id, date: gm.date });
                  }
                });
                await batch.commit();
                // Optimistically add game(s) to state so they appear immediately
                setGroups((prev) => prev.map((g) => {
                  if (g.id !== group.id) return g;
                  const existingIds = new Set(g.games.map((gm) => gm.id));
                  const newGames = arr.filter((gm) => !existingIds.has(gm.id));
                  return { ...g, games: [...g.games, ...newGames] };
                }));
                if (arr.length === 1) { go("game", group.id, arr[0].id); flash("Game scheduled!", "🀄"); }
                else { go("group", group.id); flash(`${arr.length} games scheduled! 🀄`); }
              } catch { flash("Error scheduling game", "❌"); }
            }} />
        )}
        {page === "game" && game && group && (
          <Game uid={uid} user={displayUser} game={game} group={group} go={go} unreadCounts={unreadCounts}
            onBack={() => GAMES_PAGES.includes(prevPageRef.current) ? go("games") : go("group", group.id)}
            onRsvp={async (ans) => {
              try {
                await updateDoc(doc(db, "groups", group.id, "games", game.id), { [`rsvps.${uid}`]: ans });
                flash(ans === "yes" ? "You're in!" : "Got it", ans === "yes" ? "🎉" : "👍");
              } catch { flash("Error updating RSVP", "❌"); }
            }}
            onWaitlist={async (action) => {
              try {
                await updateDoc(doc(db, "groups", group.id, "games", game.id), {
                  waitlist: action === "join" ? arrayUnion(uid) : arrayRemove(uid),
                });
                flash(action === "join" ? "Added to waitlist!" : "Removed from waitlist", action === "join" ? "⏳" : "👋");
              } catch { flash("Error updating waitlist", "❌"); }
            }}
            onArchive={async () => {
              try {
                await updateDoc(doc(db, "groups", group.id, "games", game.id), {
                  status: "archived", archivedAt: serverTimestamp(), updatedAt: serverTimestamp(),
                });
                setGroups((prev) => prev.map((g) => {
                  if (g.id !== group.id) return g;
                  return { ...g, games: g.games.map((gm) => gm.id === game.id ? { ...gm, status: "archived" } : gm) };
                }));
                go("group", group.id); flash("Game archived", "📦");
              } catch { flash("Error archiving game", "❌"); }
            }}
            onLeave={async () => {
              try {
                const ref = doc(db, "groups", group.id, "games", game.id);
                const isGuest = (game.guestIds || []).includes(uid);
                await updateDoc(ref, {
                  [`rsvps.${uid}`]: deleteField(),
                  waitlist: arrayRemove(uid),
                  ...(isGuest && { guestIds: arrayRemove(uid), registeredGuests: (game.registeredGuests || []).filter(g => g.id !== uid) }),
                });
                if (isGuest) await updateDoc(doc(db, "users", uid), { guestGameRefs: arrayRemove({ groupId: group.id, gameId: game.id }) });
                go("group", group.id); flash("You've left the game", "👋");
              } catch { flash("Error leaving game", "❌"); }
            }}
            onSaveWinner={async (winner) => {
              await updateDoc(doc(db, "groups", group.id, "games", game.id), { winner });
              flash("Winner saved!", "🏆");
            }} />
        )}
        {page === "editGame" && game && group && (
          <EditGame uid={uid} game={game} group={group} onBack={() => go("game", group.id, game.id)}
            onSave={async (updated) => {
              try {
                const { id: gameId, ...data } = updated;
                const batch = writeBatch(db);
                batch.update(doc(db, "groups", group.id, "games", gameId), data);
                const oldCode = game.joinCode || null;
                const newCode = data.joinCode || null;
                if (newCode !== oldCode) {
                  if (oldCode) batch.delete(doc(db, "gameCodes", oldCode));
                  if (newCode) batch.set(doc(db, "gameCodes", newCode), { groupId: group.id, gameId, date: data.date });
                }
                await batch.commit();
                go("game", group.id, gameId); flash("Game updated!", "✨");
              } catch { flash("Error updating game", "❌"); }
            }}
            onTransferHost={async (newHostId) => {
              try {
                const newHostMember = group.members.find((m) => m.id === newHostId);
                if (!newHostMember) return;
                await updateDoc(doc(db, "groups", group.id, "games", game.id), {
                  host: newHostMember.name, hostId: newHostId,
                  [`rsvps.${newHostId}`]: "yes",
                  [`rsvps.${uid}`]: game.rsvps?.[uid] || "yes",
                });
                go("game", group.id, game.id);
                flash(`${newHostMember.name} is now the host! 🎯`);
              } catch { flash("Error transferring host", "❌"); }
            }}
          />
        )}
        {page === "invite" && group && (
          <Invite group={group} game={game} flash={flash} onBack={() => go(game ? "game" : "group", group.id, gmid)} />
        )}
        {page === "guestGame" && gid && gmid && (
          <GuestGameView uid={uid} user={displayUser} groupId={gid} gameId={gmid} go={go} flash={flash} unreadCounts={unreadCounts} />
        )}
        {page === "newStandaloneGame" && (
          <NewGame uid={uid} user={user} group={null} groups={groups} planCfg={userPlanCfg} onBack={() => go("home")}
            onSave={async (games, selectedGroupId) => {
              const arr = Array.isArray(games) ? games : [games];
              const hostCheck = canHostGame(user, groups, userPlanCfg, standaloneGames);
              if (!hostCheck.ok) { flash("Hosted game limit reached — upgrade for unlimited games", "🔒"); return; }
              try {
                const batch = writeBatch(db);
                if (selectedGroupId) {
                  arr.forEach((gm) => {
                    batch.set(doc(db, "groups", selectedGroupId, "games", gm.id), gm);
                    if (gm.joinCode) batch.set(doc(db, "gameCodes", gm.joinCode), { groupId: selectedGroupId, gameId: gm.id, date: gm.date });
                  });
                  await batch.commit();
                  setGroups((prev) => prev.map((g) => {
                    if (g.id !== selectedGroupId) return g;
                    const existingIds = new Set(g.games.map((gm) => gm.id));
                    const newGames = arr.filter((gm) => !existingIds.has(gm.id));
                    return { ...g, games: [...g.games, ...newGames] };
                  }));
                  if (arr.length === 1) { go("game", selectedGroupId, arr[0].id); flash("Game scheduled!", "🀄"); }
                  else { go("group", selectedGroupId); flash(`${arr.length} games scheduled! 🀄`); }
                } else {
                  arr.forEach((gm) => {
                    batch.set(doc(db, "games", gm.id), { ...gm, isStandalone: true });
                    if (gm.joinCode) batch.set(doc(db, "gameCodes", gm.joinCode), { groupId: null, gameId: gm.id, date: gm.date });
                  });
                  await batch.commit();
                  go("home"); flash("Game scheduled!", "🀄");
                }
              } catch { flash("Error creating game", "❌"); }
            }} />
        )}
        {page === "standaloneGame" && gmid && (
          <StandaloneGameView uid={uid} gameId={gmid} go={go} flash={flash} user={displayUser} unreadCounts={unreadCounts} />
        )}
        {page === "managePlan" && (
          <ManagePlan uid={uid} user={displayUser} setUser={setUser} planConfigs={planConfigs} go={go} flash={flash} />
        )}
      </div>

      </div>{/* end content+toast wrapper */}

      {/* Bottom nav */}
      <div className="bottom-nav">
        {NAV_ITEMS.map((item) => {
          const active = item.id === "account" ? page === "account" : item.id === "groups" ? GROUP_PAGES.includes(page) : item.id === "games" ? GAMES_PAGES.includes(page) : page === "home";
          return (
            <button key={item.id} onClick={() => go(item.id)} style={{
              flex: 1, padding: "10px 0 12px", background: "none", border: "none",
              display: "flex", flexDirection: "column", alignItems: "center", gap: 3,
              cursor: "pointer", transition: "transform .15s",
            }}
              onMouseDown={(e) => e.currentTarget.style.transform = "scale(.93)"}
              onMouseUp={(e) => e.currentTarget.style.transform = "scale(1)"}
              onTouchStart={(e) => e.currentTarget.style.transform = "scale(.93)"}
              onTouchEnd={(e) => e.currentTarget.style.transform = "scale(1)"}
            >
              <div style={{ position: "relative", width: 42, height: 28, borderRadius: 14, background: active ? "var(--active-tab-gradient)" : "transparent", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 17, boxShadow: active ? "0 2px 10px rgba(var(--shadow-rgb),0.35)" : "none", transition: "all .2s" }}>
                {item.icon}
                {item.id === "groups" && <Badge count={totalUnread} />}
              </div>
              <span style={{ fontSize: 12, fontWeight: active ? 700 : 500, color: active ? "var(--primary)" : "#c0a0b0", fontFamily: "'Inter',sans-serif" }}>{item.label}</span>
            </button>
          );
        })}
      </div>
    </div>
    <InstallBanner
      showBanner={installBanner.showBanner}
      isIOS={installBanner.isIOS}
      onDismiss={installBanner.dismiss}
      onInstall={installBanner.install}
    />
    </>
  );
}

/* ── NEW CHOICE PAGE ──────────────────────────────────────────────────────────
 * Full-screen page (matching the Join screen style) shown when the user taps
 * + New. Presents "Schedule a Game" and "Create a Group" options, respecting
 * plan limits. Dimmed options indicate the limit is reached.
 * ─────────────────────────────────────────────────────────────────────────── */
function NewChoice({ uid, groups, user, planCfg, standaloneGames, go, flash, onBack }) {
  const groupCheck = canAddGroup(groups, user, planCfg);
  const gameCheck  = canHostGame(user, groups, planCfg, standaloneGames);
  const canGroup   = groupCheck.ok;
  const canGame    = gameCheck.ok;
  const lim        = getPlanLimits(planCfg);

  const handleGame = () => {
    go("newStandaloneGame");
  };

  const gameSub = canGame ? "Standalone or pick a group — no group required" : "Hosted game limit reached — upgrade for more";

  const options = [
    {
      id: "game",
      icon: "🀄",
      label: "Schedule a Game",
      sub: gameSub,
      disabled: !canGame,
      onClick: handleGame,
    },
    {
      id: "group",
      icon: "👥",
      label: "Create a Group",
      sub: canGroup ? "Invite friends and start scheduling" : `Group limit reached — upgrade to add more`,
      disabled: !canGroup,
      onClick: () => go("newGroup"),
    },
  ];

  return (
    <Shell title="New" onBack={onBack} color="var(--primary)">
      <div style={{ textAlign: "center", fontSize: 49, margin: "12px 0 20px" }}>✨</div>
      <p style={{ textAlign: "center", fontWeight: 700, fontSize: 16, color: "var(--text-body)", marginBottom: 24, fontFamily: "'Inter',sans-serif" }}>
        What would you like to create?
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 13 }}>
        {options.map(({ id, icon, label, sub, disabled, onClick }) => (
          <button key={id} onClick={() => !disabled && onClick()} style={{
            display: "flex", alignItems: "center", gap: 16,
            padding: "18px 20px", borderRadius: 18, cursor: disabled ? "default" : "pointer", textAlign: "left",
            background: "linear-gradient(135deg,var(--bg-card),var(--bg-card-alt))",
            border: "1.5px solid var(--border-card)",
            boxShadow: "0 4px 18px rgba(var(--shadow-rgb),0.09), inset 0 1px 0 var(--shadow-inset)",
            backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)",
            transition: "transform .14s",
            opacity: disabled ? 0.45 : 1,
          }}
            onMouseDown={(e) => { if (!disabled) e.currentTarget.style.transform = "scale(.97)"; }}
            onMouseUp={(e) => { e.currentTarget.style.transform = "scale(1)"; }}
            onTouchStart={(e) => { if (!disabled) e.currentTarget.style.transform = "scale(.97)"; }}
            onTouchEnd={(e) => { e.currentTarget.style.transform = "scale(1)"; }}
          >
            <div style={{
              width: 52, height: 52, borderRadius: 15, flexShrink: 0,
              background: "linear-gradient(135deg,rgba(var(--primary-rgb),0.14),rgba(var(--primary-rgb),0.07))",
              display: "flex", alignItems: "center", justifyContent: "center", fontSize: 26,
              border: "1.5px solid rgba(var(--primary-rgb),0.15)",
            }}>{icon}</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700, fontSize: 17, color: "var(--text-body)", fontFamily: "'Inter',sans-serif" }}>{label}</div>
              <div style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 3, fontFamily: "'Inter',sans-serif" }}>{sub}</div>
            </div>
            {!disabled && <span style={{ color: "var(--primary-faint)", fontSize: 22 }}>›</span>}
          </button>
        ))}
      </div>
      {!canGame && !canGroup && (
        <div style={{ marginTop: 24 }}>
          <p style={{ textAlign: "center", fontSize: 13, color: "var(--text-muted)", marginBottom: 14, fontFamily: "'Inter',sans-serif", lineHeight: 1.6 }}>
            Your plan allows {isFinite(lim.maxGroups) ? lim.maxGroups : "∞"} group{lim.maxGroups !== 1 ? "s" : ""} and {isFinite(lim.gamesPerCycle) ? lim.gamesPerCycle : "∞"} hosted game{lim.gamesPerCycle !== 1 ? "s" : ""} every {lim.cycleDays} days.
          </p>
          <Btn full onClick={() => go("account")}>Upgrade my plan</Btn>
        </div>
      )}
    </Shell>
  );
}

/* ── WELCOME MODAL ── */
function ConfirmDialog({ title, message, confirmLabel = "Delete", onConfirm, onCancel }) {
  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 10000,
      background: "rgba(0,0,0,0.45)",
      backdropFilter: "blur(6px)", WebkitBackdropFilter: "blur(6px)",
      display: "flex", alignItems: "center", justifyContent: "center",
      padding: "24px",
    }}>
      <div className="bIn" style={{
        background: "linear-gradient(160deg,var(--bg-card-base) 0%,var(--bg-card-alt) 100%)",
        borderRadius: 24,
        padding: "28px 24px 22px",
        maxWidth: 340, width: "100%",
        boxShadow: "0 20px 56px rgba(var(--shadow-rgb),0.28), inset 0 1px 0 var(--shadow-inset)",
        border: "1px solid rgba(var(--border-light-rgb),0.5)",
        textAlign: "center",
      }}>
        <div style={{ fontSize: 38, marginBottom: 12 }}>⚠️</div>
        <h3 style={{
          fontFamily: "var(--font-display)", fontSize: 20,
          color: "var(--text-heading)", marginBottom: 10, lineHeight: 1.3,
        }}>{title}</h3>
        <p style={{
          fontSize: 14, color: "var(--text-muted)", lineHeight: 1.6,
          marginBottom: 22,
        }}>{message}</p>
        <div style={{ display: "flex", gap: 10 }}>
          <Btn full outline onClick={onCancel} style={{ flex: 1 }}>Cancel</Btn>
          <Btn full danger onClick={onConfirm} style={{ flex: 1 }}>{confirmLabel}</Btn>
        </div>
      </div>
    </div>
  );
}

function AnnouncementModal({ announcement, onClose }) {
  const features = announcement.features || [];
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 10001, background: "rgba(20,10,40,0.72)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div className="bIn" style={{
        background: "linear-gradient(160deg,#1a0d30 0%,#2d1b4e 60%,#3d1f5e 100%)",
        borderRadius: 28, padding: "28px 22px 22px", maxWidth: 420, width: "100%",
        boxShadow: "0 32px 80px rgba(80,20,120,0.5)", border: "1px solid rgba(155,110,168,0.35)",
        maxHeight: "80vh", display: "flex", flexDirection: "column",
      }}>
        <div style={{ textAlign: "center", marginBottom: 20 }}>
          <div style={{ fontSize: 42, marginBottom: 10 }}>🎉</div>
          <div style={{ fontFamily: "'Inter',sans-serif", fontSize: 22, fontWeight: 800, color: "#fff", letterSpacing: 0.5 }}>{announcement.title || "What's New"}</div>
          {announcement.body && <div style={{ fontSize: 13, color: "rgba(255,255,255,0.65)", marginTop: 6, fontFamily: "'Inter',sans-serif", lineHeight: 1.5 }}>{announcement.body}</div>}
        </div>

        {features.length > 0 && (
          <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 10, marginBottom: 20 }}>
            {features.map((f, i) => (
              <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 14, background: "rgba(255,255,255,0.07)", borderRadius: 16, padding: "14px 16px", border: "1px solid rgba(255,255,255,0.1)" }}>
                <div style={{ fontSize: 28, lineHeight: 1, flexShrink: 0 }}>{f.icon || "✨"}</div>
                <div>
                  <div style={{ fontFamily: "'Inter',sans-serif", fontSize: 15, fontWeight: 700, color: "#fff", marginBottom: 3 }}>{f.title}</div>
                  <div style={{ fontSize: 13, color: "rgba(255,255,255,0.65)", fontFamily: "'Inter',sans-serif", lineHeight: 1.5 }}>{f.description}</div>
                </div>
              </div>
            ))}
          </div>
        )}

        <button onClick={onClose} style={{
          width: "100%", padding: "14px 0", borderRadius: 14,
          background: "linear-gradient(135deg,#c9607a,#9b6ea8)",
          border: "none", color: "#fff", fontSize: 16, fontWeight: 700,
          cursor: "pointer", fontFamily: "'Inter',sans-serif",
          boxShadow: "0 4px 20px rgba(201,96,122,0.4)",
        }}>Got it!</button>
      </div>
    </div>
  );
}

function WelcomeModal({ onClose }) {
  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 10000,
      background: "rgba(100,30,60,0.55)",
      backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)",
      display: "flex", alignItems: "center", justifyContent: "center",
      padding: "24px",
    }}>
      <div className="bIn" style={{
        background: "linear-gradient(160deg,var(--bg-card-base) 0%,var(--bg-card-alt) 100%)",
        borderRadius: 28,
        padding: "32px 26px 28px",
        maxWidth: 360, width: "100%",
        boxShadow: "0 24px 64px rgba(var(--shadow-rgb),0.3), inset 0 1px 0 var(--shadow-inset)",
        border: "1px solid rgba(var(--border-light-rgb),0.6)",
        textAlign: "center",
        position: "relative",
      }}>
        {/* Decorative tiles */}
        <div style={{ fontSize: 15, letterSpacing: 6, color: "#e8a0b0", marginBottom: 16, opacity: 0.7 }}>
          🀇 🀄 🀅 🀆 🀙
        </div>

        <div style={{ fontSize: 53, marginBottom: 12, filter: "drop-shadow(0 4px 12px rgba(var(--shadow-rgb),0.25))" }}>🀄</div>

        <h2 style={{
          fontFamily: "'Inter',sans-serif",
          fontSize: 25, color: "var(--section-title)",
          marginBottom: 14, lineHeight: 1.3, letterSpacing: 0.5,
          textAlign: "center",
        }}>
          Welcome to Mahjong Club
          <br />
          <span style={{ fontSize: 21 }}>✨</span>
        </h2>

        <p style={{
          fontSize: 15, color: "#7a4a58", lineHeight: 1.8,
          fontFamily: "'Inter',sans-serif", fontWeight: 400,
          marginBottom: 10,
        }}>
          We know the struggle — chasing down four players, juggling schedules, 
          and keeping track of who's in, who's out, and who's 
          <em> definitely</em> blaming the tiles. 😄
        </p>

        <p style={{
          fontSize: 15, color: "#7a4a58", lineHeight: 1.8,
          fontFamily: "'Inter',sans-serif", fontWeight: 400,
          marginBottom: 24,
        }}>
          Mahjong Club makes it simple. Create your group, schedule your games, 
          invite your players, and let everyone RSVP in one beautiful spot. 
          More tiles, less chaos. 🌸
        </p>

        {/* Divider */}
        <div style={{ height: 1, background: "linear-gradient(90deg,transparent,#f0c0d0,transparent)", marginBottom: 22 }} />

        <button onClick={onClose} style={{
          width: "100%",
          padding: "14px 20px",
          borderRadius: 999,
          background: "var(--active-tab-gradient)",
          color: "#fff",
          fontSize: 16, fontWeight: 700,
          border: "none", cursor: "pointer",
          fontFamily: "'Inter',sans-serif",
          boxShadow: "0 6px 20px rgba(var(--shadow-rgb),0.4)",
          letterSpacing: 0.3,
        }}>
          Let's Play! 🀄
        </button>
      </div>
    </div>
  );
}

/* ── AVATAR SYSTEM ── */
// Curated luxury emoji — mahjong, florals, cocktail culture, elegant nature.
// Each has a signature jewel-tone gradient shown in the picker and throughout the app.
const AVATAR_DEFS = [
  // ── Mahjong & Asian culture ──────────────────────────────────────────────────
  { id: "🀄", bg: "linear-gradient(135deg,#500808,#880808)" }, // mahjong red dragon
  { id: "🎋", bg: "linear-gradient(135deg,#081808,#0e2808)" }, // bamboo suit
  { id: "🎴", bg: "linear-gradient(135deg,#1a0808,#300810)" }, // flower playing cards
  { id: "🧧", bg: "linear-gradient(135deg,#580808,#900808)" }, // red envelope (lucky money)
  { id: "🏮", bg: "linear-gradient(135deg,#480808,#780808)" }, // red lantern
  { id: "🎐", bg: "linear-gradient(135deg,#0a1060,#141898)" }, // wind chime
  // ── Cocktail & social club ───────────────────────────────────────────────────
  { id: "🥂", bg: "linear-gradient(135deg,#282808,#404808)" }, // champagne toast
  { id: "🍸", bg: "linear-gradient(135deg,#083028,#0c4838)" }, // martini
  { id: "🍷", bg: "linear-gradient(135deg,#3a0818,#600820)" }, // wine
  { id: "🥃", bg: "linear-gradient(135deg,#3a1808,#6a2808)" }, // whiskey / old fashioned
  { id: "🫖", bg: "linear-gradient(135deg,#381020,#601838)" }, // teapot
  { id: "🍵", bg: "linear-gradient(135deg,#082808,#104018)" }, // matcha
  // ── Elegant nature ───────────────────────────────────────────────────────────
  { id: "🦚", bg: "linear-gradient(135deg,#083a28,#105840)" }, // peacock
  { id: "🦋", bg: "linear-gradient(135deg,#0a1870,#1428b0)" }, // butterfly
  { id: "🌸", bg: "linear-gradient(135deg,#4a0838,#7a1058)" }, // cherry blossom
  { id: "🌺", bg: "linear-gradient(135deg,#4a0840,#880860)" }, // hibiscus
  { id: "🌷", bg: "linear-gradient(135deg,#400868,#6a10a0)" }, // tulip
  { id: "🪷", bg: "linear-gradient(135deg,#38086a,#601098)" }, // lotus
  { id: "🌙", bg: "linear-gradient(135deg,#060620,#0a0a38)" }, // moon
  // ── Luxury symbols ───────────────────────────────────────────────────────────
  { id: "💎", bg: "linear-gradient(135deg,#080a60,#1018a8)" }, // diamond
  { id: "👑", bg: "linear-gradient(135deg,#280858,#4a0890)" }, // crown
  { id: "✨", bg: "linear-gradient(135deg,#080830,#100850)" }, // sparkles
  { id: "🎀", bg: "linear-gradient(135deg,#500828,#8a1040)" }, // bow
  { id: "💐", bg: "linear-gradient(135deg,#0e2808,#183a10)" }, // bouquet
];

const AVATAR_BG_MAP = new Map(AVATAR_DEFS.map(d => [d.id, d.bg]));
const avatarBg = (av) => AVATAR_BG_MAP.get(av) || "var(--avatar-bubble-bg)";

function AvatarImg({ av, size }) {
  return <span style={{ fontSize: size * 0.54, lineHeight: 1 }}>{av}</span>;
}

/* ── AUTH SCREEN ── */
const AUTH_AVATARS = AVATAR_DEFS.map(d => d.id);
const randAvatar = () => AUTH_AVATARS[Math.floor(Math.random() * AUTH_AVATARS.length)];

function AuthScreen() {
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [avatar, setAvatar] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const [forgotSent, setForgotSent] = useState(false);

  const switchMode = (m) => { setMode(m); setError(""); setForgotSent(false); };

  const fmtFirebaseError = (code) => {
    const map = {
      "auth/user-not-found": "No account found with that email.",
      "auth/wrong-password": "Incorrect password.",
      "auth/invalid-credential": "Incorrect email or password.",
      "auth/email-already-in-use": "An account with that email already exists.",
      "auth/weak-password": "Password must be at least 6 characters.",
      "auth/invalid-email": "Please enter a valid email address.",
      "auth/too-many-requests": "Too many attempts. Please try again later.",
      "auth/popup-closed-by-user": "Sign-in popup was closed.",
      "auth/unauthorized-domain": `This domain isn't authorized for Google sign-in. Add "${window.location.hostname}" to Firebase Console → Authentication → Settings → Authorized domains.`,
    };
    return map[code] || "Something went wrong. Please try again.";
  };

  const handleLogin = async () => {
    setError("");
    if (!email.trim() || !password.trim()) { setError("Please enter your email and password."); return; }
    setLoading(true);
    try {
      await signInWithEmailAndPassword(auth, email.trim(), password);
      // Token refresh handled by onAuthStateChanged — do not double-register here.
    } catch (e) {
      setError(fmtFirebaseError(e.code));
    } finally {
      setLoading(false);
    }
  };

  const handleSignUp = async () => {
    setError("");
    if (!firstName.trim()) { setError("First name is required."); return; }
    if (!lastName.trim()) { setError("Last name is required."); return; }
    if (!email.trim()) { setError("Email is required."); return; }
    if (!/\S+@\S+\.\S+/.test(email.trim())) { setError("Please enter a valid email."); return; }
    if (!password.trim() || password.length < 6) { setError("Password must be at least 6 characters."); return; }
    setLoading(true);
    try {
      const { user: fbUser } = await createUserWithEmailAndPassword(auth, email.trim(), password);
      const chosenAvatar = avatar || randAvatar();
      const profile = {
        name: `${firstName.trim()} ${lastName.trim()}`,
        email: email.trim().toLowerCase(),
        phone: phone.trim(),
        avatar: chosenAvatar,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        loginProvider: "email",
      };
      await setDoc(doc(db, "users", fbUser.uid), profile);
      // Token refresh handled by onAuthStateChanged.
    } catch (e) {
      setError(fmtFirebaseError(e.code));
    } finally {
      setLoading(false);
    }
  };

  const handleGoogle = async () => {
    setError("");
    setLoading(true);
    try {
      if (Capacitor.isNativePlatform()) {
        await GoogleAuth.initialize({ scopes: ["profile", "email"], grantOfflineAccess: true });
        const { authentication } = await GoogleAuth.signIn({
          scopes: ["profile", "email"],
          serverClientId: GOOGLE_WEB_CLIENT_ID,
          grantOfflineAccess: true,
        });
        await signInWithCredential(
          auth, GoogleAuthProvider.credential(authentication.idToken)
        );
        // Token refresh handled by onAuthStateChanged.
      } else {
        await signInWithPopup(auth, googleProvider);
        // Token refresh handled by onAuthStateChanged.
      }
    } catch (e) {
      setError(fmtFirebaseError(e.code));
    } finally {
      setLoading(false);
    }
  };

  const handleForgotPassword = async () => {
    setError("");
    if (!email.trim() || !/\S+@\S+\.\S+/.test(email.trim())) {
      setError("Please enter a valid email address.");
      return;
    }
    setLoading(true);
    try {
      // Write a request doc — the sendPasswordReset Cloud Function picks it up,
      // verifies the account exists, applies the admin-editable template, and sends.
      await addDoc(collection(db, "passwordResetRequests"), {
        email: email.trim().toLowerCase(),
        requestedAt: serverTimestamp(),
      });
    } catch {
      // Swallow all errors — never reveal whether the account exists
    } finally {
      setLoading(false);
      setForgotSent(true);
    }
  };

  const TILES = ["🀄","🀅","🀆","🀇","🀙","🀃","🀈","🀆"];
  const TILE_POS = [
    { top: "4%",  left: "3%",   a: "f0", d: "0s",    s: 30 },
    { top: "7%",  right: "4%",  a: "f1", d: "0.4s",  s: 24 },
    { top: "20%", left: "6%",   a: "f2", d: "0.8s",  s: 20 },
    { top: "24%", right: "8%",  a: "f0", d: "1.1s",  s: 22 },
    { bottom: "32%", left: "2%",  a: "f1", d: "1.4s", s: 26 },
    { bottom: "30%", right: "3%", a: "f2", d: "0.2s", s: 20 },
    { bottom: "16%", left: "10%", a: "f0", d: "0.6s", s: 18 },
    { bottom: "13%", right: "7%", a: "f1", d: "1.0s", s: 24 },
  ];

  return (
    <div style={{
      height: "100%",
      overflowY: "auto", WebkitOverflowScrolling: "touch",
      background: "var(--header-gradient2)",
      position: "relative",
    }}>
      {/* Shimmer overlay — fixed to the scroll container */}
      <div style={{ position: "sticky", top: 0, height: 0, pointerEvents: "none" }}>
        <div style={{ position: "absolute", inset: 0, height: "100vh", background: "linear-gradient(135deg,rgba(255,255,255,0.12) 0%,transparent 60%)" }} />
      </div>

      {/* Animated tiles */}
      {TILE_POS.map((p, i) => (
        <div key={i} style={{
          position: "fixed", fontSize: p.s, opacity: 0.18, pointerEvents: "none",
          top: p.top, bottom: p.bottom, left: p.left, right: p.right,
          animation: `${p.a} ${2.4 + i * 0.3}s ${p.d} ease-in-out infinite`, filter: "blur(0.5px)",
        }}>{TILES[i]}</div>
      ))}

      {/* Inner centred layout — grows taller than 100% when content overflows */}
      <div style={{
        minHeight: "100%",
        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
        padding: "24px 20px", position: "relative",
      }}>

      {/* Logo */}
      <div style={{ textAlign: "center", marginBottom: 24, position: "relative" }}>
        <div style={{ fontSize: 55, filter: "drop-shadow(0 6px 18px rgba(0,0,0,.3))", marginBottom: 10 }}>🀄</div>
        <h1 style={{ fontFamily: "'Shippori Mincho',serif", fontSize: 31, color: "#fff", textShadow: "0 2px 12px rgba(0,0,0,.25)", letterSpacing: 2, lineHeight: 1.1 }}>Mahjong Club</h1>
        <p style={{ color: "rgba(255,255,255,.72)", fontSize: 13, fontFamily: "'Inter',sans-serif", letterSpacing: 1, marginTop: 5 }}>Schedule · Play · Enjoy</p>
      </div>

      {/* Card */}
      <div className="bIn" style={{
        background: "linear-gradient(160deg,var(--bg-popup) 0%,var(--bg-card-alt) 100%)",
        borderRadius: 28, padding: "26px 22px 22px", maxWidth: 420, width: "100%",
        boxShadow: "0 28px 72px rgba(100,30,60,0.38), inset 0 1px 0 var(--shadow-inset)",
        border: "1px solid rgba(var(--border-light-rgb),0.5)", position: "relative",
      }}>
        {/* Tab toggle — hidden in forgot-password mode */}
        {mode !== "forgot" && (
          <div style={{ display: "flex", background: "rgba(240,217,227,0.55)", borderRadius: 999, padding: 4, marginBottom: 20 }}>
            {[["login","Sign In"],["signup","Create Account"]].map(([m, label]) => (
              <button key={m} onClick={() => switchMode(m)} style={{
                flex: 1, padding: "9px 0", borderRadius: 999, fontSize: 14, fontWeight: 700,
                fontFamily: "'Inter',sans-serif", border: "none", cursor: "pointer", transition: "all .2s",
                background: mode === m ? "var(--active-tab-gradient)" : "transparent",
                color: mode === m ? "#fff" : "var(--primary-subtle)",
                boxShadow: mode === m ? "0 3px 12px rgba(var(--shadow-rgb),0.3)" : "none",
              }}>{label}</button>
            ))}
          </div>
        )}

        {mode === "forgot" ? (
          forgotSent ? (
            <>
              <div style={{ textAlign: "center", marginBottom: 20 }}>
                <div style={{ fontSize: 40, marginBottom: 12 }}>📬</div>
                <div style={{ fontFamily: "'Inter',sans-serif", fontSize: 15, fontWeight: 700, color: "var(--section-title)", marginBottom: 8 }}>Check your inbox</div>
                <div style={{ fontSize: 13, color: "var(--text-muted)", fontFamily: "'Inter',sans-serif", lineHeight: 1.6 }}>
                  If you have an account with that email address, you'll receive an email with instructions to reset your password.
                </div>
              </div>
              <ABtn onClick={() => switchMode("login")}>Back to Sign In</ABtn>
            </>
          ) : (
            <>
              <div style={{ fontFamily: "'Inter',sans-serif", fontSize: 16, fontWeight: 700, color: "var(--section-title)", marginBottom: 4 }}>Reset your password</div>
              <div style={{ fontSize: 13, color: "var(--text-muted)", fontFamily: "'Inter',sans-serif", marginBottom: 16, lineHeight: 1.5 }}>Enter your email and we'll send you a reset link.</div>
              <AInput label="Email" type="email" value={email} set={setEmail} placeholder="you@email.com" />
              {error && <ErrMsg msg={error} />}
              <ABtn onClick={handleForgotPassword} disabled={loading}>{loading ? "Sending…" : "Send Reset Link"}</ABtn>
              <p style={{ fontSize: 12, color: "#c0a0b0", textAlign: "center", marginTop: 14, fontFamily: "'Inter',sans-serif" }}>
                <span onClick={() => switchMode("login")} style={{ color: "var(--primary)", fontWeight: 700, cursor: "pointer" }}>Back to Sign In</span>
              </p>
            </>
          )
        ) : mode === "login" ? (
          <>
            <AInput label="Email" type="email" value={email} set={setEmail} placeholder="you@email.com" />
            <AInput label="Password" type="password" value={password} set={setPassword} placeholder="••••••••" />
            <p style={{ fontSize: 12, textAlign: "right", marginTop: -8, marginBottom: 12, fontFamily: "'Inter',sans-serif" }}>
              <span onClick={() => switchMode("forgot")} style={{ color: "var(--primary)", fontWeight: 600, cursor: "pointer" }}>Forgot password?</span>
            </p>
            {error && <ErrMsg msg={error} />}
            <ABtn onClick={handleLogin} disabled={loading}>{loading ? "Signing in…" : "Sign In 🀄"}</ABtn>
            <Divider />
            <GoogleSignInBtn onClick={handleGoogle} disabled={loading} />
          </>
        ) : (
          <>
            <div style={{ display: "flex", gap: 10 }}>
              <div style={{ flex: 1 }}><AInput label="First Name" value={firstName} set={setFirstName} placeholder="Jane" /></div>
              <div style={{ flex: 1 }}><AInput label="Last Name" value={lastName} set={setLastName} placeholder="Smith" /></div>
            </div>
            <AInput label="Email" type="email" value={email} set={setEmail} placeholder="you@email.com" />
            <AInput label="Password" type="password" value={password} set={setPassword} placeholder="Min. 6 characters" />
            <AInput label="Phone (optional)" type="tel" value={phone} set={setPhone} placeholder="+1 (555) 000-0000" />

            {/* Avatar picker */}
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "var(--primary-subtle)", marginBottom: 9, textTransform: "uppercase", letterSpacing: .5, fontFamily: "'Inter',sans-serif" }}>
                Avatar <span style={{ fontWeight: 400, color: "var(--primary-faint)", textTransform: "none", letterSpacing: 0, fontSize: 12 }}>— auto-selected if skipped</span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 7 }}>
                {AVATAR_DEFS.map(({ id, bg }) => (
                  <div key={id} onClick={() => setAvatar(avatar === id ? null : id)} style={{
                    aspectRatio: "1", borderRadius: 13, background: bg,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 24, cursor: "pointer",
                    border: `2px solid ${avatar === id ? "var(--primary)" : "transparent"}`,
                    boxShadow: avatar === id
                      ? "0 0 0 1px var(--primary), 0 4px 14px rgba(var(--primary-rgb),0.45)"
                      : "0 2px 8px rgba(0,0,0,0.35)",
                    transform: avatar === id ? "scale(1.08)" : "scale(1)",
                    transition: "all .15s",
                  }}>{id}</div>
                ))}
              </div>
            </div>

            {error && <ErrMsg msg={error} />}
            <ABtn onClick={handleSignUp} disabled={loading}>{loading ? "Creating account…" : "Create Account ✨"}</ABtn>
            <Divider />
            <GoogleSignInBtn onClick={handleGoogle} disabled={loading} />
          </>
        )}

        {mode !== "forgot" && (
          <p style={{ fontSize: 12, color: "#c0a0b0", textAlign: "center", marginTop: 14, fontFamily: "'Inter',sans-serif" }}>
            {mode === "login" ? "Don't have an account? " : "Already have an account? "}
            <span onClick={() => switchMode(mode === "login" ? "signup" : "login")} style={{ color: "var(--primary)", fontWeight: 700, cursor: "pointer" }}>
              {mode === "login" ? "Create one" : "Sign in"}
            </span>
          </p>
        )}
      </div>
      </div>{/* end inner centred layout */}
    </div>
  );
}

function AInput({ label, type = "text", value, set, placeholder }) {
  return (
    <div style={{ marginBottom: 11 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: "var(--primary-subtle)", marginBottom: 5, textTransform: "uppercase", letterSpacing: .5, fontFamily: "'Inter',sans-serif" }}>{label}</div>
      <input type={type} value={value} onChange={(e) => set(e.target.value)} placeholder={placeholder}
        style={{ ...inputSt, marginBottom: 0 }} />
    </div>
  );
}
function ABtn({ children, onClick, disabled }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      width: "100%", padding: "14px", borderRadius: 999,
      background: disabled ? "#e5d5dc" : "var(--active-tab-gradient)", color: disabled ? "#bbb" : "#fff",
      fontSize: 16, fontWeight: 700, border: "none", cursor: disabled ? "not-allowed" : "pointer",
      fontFamily: "'Inter',sans-serif", boxShadow: disabled ? "none" : "0 6px 20px rgba(var(--shadow-rgb),0.38)",
      letterSpacing: 0.3, transition: "transform .15s",
    }}
      onMouseDown={(e) => { if (!disabled) e.currentTarget.style.transform = "scale(.97)"; }}
      onMouseUp={(e) => e.currentTarget.style.transform = "scale(1)"}
      onTouchStart={(e) => { if (!disabled) e.currentTarget.style.transform = "scale(.97)"; }}
      onTouchEnd={(e) => e.currentTarget.style.transform = "scale(1)"}
    >{children}</button>
  );
}
function GoogleSignInBtn({ onClick, disabled }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      width: "100%", padding: "13px", borderRadius: 999,
      background: "#fff", color: disabled ? "#aaa" : "#3c3c3c", fontSize: 15, fontWeight: 600,
      border: "2px solid #e8e0e4", cursor: disabled ? "not-allowed" : "pointer", fontFamily: "'Inter',sans-serif",
      display: "flex", alignItems: "center", justifyContent: "center", gap: 10,
      boxShadow: "0 2px 10px rgba(0,0,0,0.08)", transition: "all .15s",
    }}
      onMouseDown={(e) => { if (!disabled) e.currentTarget.style.transform = "scale(.97)"; }}
      onMouseUp={(e) => e.currentTarget.style.transform = "scale(1)"}
      onTouchStart={(e) => { if (!disabled) e.currentTarget.style.transform = "scale(.97)"; }}
      onTouchEnd={(e) => e.currentTarget.style.transform = "scale(1)"}
    >
      <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
        <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908C16.657 14.013 17.64 11.71 17.64 9.2z" fill="#4285F4"/>
        <path d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z" fill="#34A853"/>
        <path d="M3.964 10.707A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.707V4.961H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.039l3.007-2.332z" fill="#FBBC05"/>
        <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.961L3.964 6.293C4.672 4.166 6.656 3.58 9 3.58z" fill="#EA4335"/>
      </svg>
      Continue with Google
    </button>
  );
}
function ErrMsg({ msg }) {
  return <div style={{ color: "var(--primary)", fontSize: 14, fontWeight: 600, marginBottom: 12, textAlign: "center", fontFamily: "'Inter',sans-serif", background: "rgba(var(--primary-rgb),0.08)", borderRadius: 10, padding: "8px 12px" }}>{msg}</div>;
}
function Divider() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "14px 0" }}>
      <div style={{ flex: 1, height: 1, background: "linear-gradient(90deg,transparent,#f0c0d0,transparent)" }} />
      <span style={{ fontSize: 13, color: "var(--primary-faint)", fontFamily: "'Inter',sans-serif", fontWeight: 600 }}>or</span>
      <div style={{ flex: 1, height: 1, background: "linear-gradient(90deg,transparent,#f0c0d0,transparent)" }} />
    </div>
  );
}

/* ── ADMIN PANEL ── */
function AdminPanel({ onImpersonate }) {
  const [query_, setQuery_] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);

  const search = async () => {
    const q = query_.trim().toLowerCase();
    if (!q) return;
    setSearching(true);
    setSearched(true);
    try {
      // Search by exact email first, then by name prefix
      const byEmail = await getDocs(query(collection(db, "users"), where("email", "==", q)));
      const byEmailUp = await getDocs(query(collection(db, "users"), where("email", "==", query_.trim())));
      const seen = new Set();
      const combined = [];
      [...byEmail.docs, ...byEmailUp.docs].forEach((d) => {
        if (!seen.has(d.id)) { seen.add(d.id); combined.push({ uid: d.id, ...d.data() }); }
      });
      setResults(combined);
    } catch { setResults([]); }
    setSearching(false);
  };

  return (
    <div style={{
      background: "linear-gradient(135deg,rgba(45,27,78,0.08),rgba(90,45,107,0.06))",
      borderRadius: 20, padding: "18px", marginBottom: 14,
      border: "1.5px solid rgba(90,45,107,0.2)",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
        <span style={{ fontSize: 19 }}>🔐</span>
        <span style={{ fontFamily: "'Inter',sans-serif", fontSize: 17, color: "#2d1b4e", fontWeight: 700 }}>Admin Panel</span>
        <span style={{ marginLeft: "auto", fontSize: 11, fontWeight: 800, color: "var(--secondary-accent)", background: "rgba(155,110,168,0.12)", borderRadius: 999, padding: "2px 8px", textTransform: "uppercase", letterSpacing: 1 }}>Admin Only</span>
      </div>

      <div style={{ fontSize: 13, color: "#7a5090", marginBottom: 12, fontFamily: "'Inter',sans-serif" }}>
        Search for a user by email to view the app as them.
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <input
          value={query_}
          onChange={(e) => setQuery_(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && search()}
          placeholder="User email address"
          style={{ flex: 1, padding: "10px 14px", borderRadius: 12, fontSize: 14, border: "1.5px solid rgba(90,45,107,0.25)", background: "rgba(255,255,255,0.8)", color: "#2d1b4e", fontFamily: "'Inter',sans-serif", outline: "none" }}
        />
        <button onClick={search} disabled={searching || !query_.trim()} style={{ background: "linear-gradient(135deg,#2d1b4e,#5a2d6b)", border: "none", borderRadius: 12, padding: "10px 16px", color: "#fff", fontWeight: 700, fontSize: 14, cursor: "pointer", fontFamily: "'Inter',sans-serif", opacity: (!query_.trim() || searching) ? 0.5 : 1 }}>
          {searching ? "…" : "Search"}
        </button>
      </div>

      {searched && results.length === 0 && !searching && (
        <div style={{ fontSize: 13, color: "var(--secondary-accent)", fontFamily: "'Inter',sans-serif" }}>No user found with that email.</div>
      )}

      {results.map((u) => (
        <div key={u.uid} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: 12, background: "rgba(255,255,255,0.7)", marginBottom: 8, border: "1px solid rgba(90,45,107,0.15)" }}>
          <div style={{ width:28,height:28,borderRadius:999,background:avatarBg(u.avatar),overflow:"hidden",display:"flex",alignItems:"center",justifyContent:"center" }}><AvatarImg av={u.avatar} size={28}/></div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: "#2d1b4e", fontFamily: "'Inter',sans-serif" }}>{u.name}</div>
            <div style={{ fontSize: 12, color: "var(--secondary-accent)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{u.email}</div>
          </div>
          <button onClick={() => onImpersonate(u)} style={{ background: "linear-gradient(135deg,#2d1b4e,#5a2d6b)", border: "none", borderRadius: 10, padding: "6px 12px", color: "#fff", fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "'Inter',sans-serif", flexShrink: 0 }}>
            View as
          </button>
        </div>
      ))}
    </div>
  );
}

/* ── MANAGE PLAN PAGE ── */

function ManagePlan({ uid, user, setUser, planConfigs, go, flash }) {
  const [loading,         setLoading]         = useState(false);
  const [cancelConfirm,   setCancelConfirm]   = useState(false);
  const [cancelling,      setCancelling]      = useState(false);

  const currentPlan = getPlan(user);
  const isOnTrial   = user?.subscription?.isTrial === true && currentPlan !== "free";
  const trialEndsAt = user?.subscription?.trialEndsAt;

  const clubCfg  = planConfigs["club"];
  const freeCfg  = planConfigs["free"];

  const clubPrice    = clubCfg?.price ?? 4.99;
  const clubInterval = clubCfg?.interval ?? "month";

  const clubFeatures = clubCfg?.features?.length ? clubCfg.features : [
    "Unlimited groups",
    "Unlimited hosted games",
    "Recurring game scheduling",
    "Priority support",
  ];

  const freeLimits = getPlanLimits(freeCfg ?? null);

  // Dates
  const trialBillingDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const billingDateStr   = trialBillingDate.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  const trialDaysLeft    = trialEndsAt ? Math.max(0, Math.ceil((trialEndsAt - Date.now()) / 86400000)) : 0;
  const trialEndStr      = trialEndsAt
    ? new Date(trialEndsAt).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
    : "";

  // Redirect to a plan's Stripe payment link with uid + email pre-filled
  const handleSubscribe = (plan) => {
    const link = plan?.paymentLink;
    if (!link) { flash("No payment link configured for this plan."); return; }
    const params = new URLSearchParams({
      client_reference_id: uid,
      prefilled_email:     user.email || "",
    });
    window.location.href = `${link}?${params.toString()}`;
  };

  // Cancel via Cloud Function → Stripe → Firestore
  const handleCancel = async () => {
    if (!cancelConfirm) { setCancelConfirm(true); return; }
    setCancelling(true);
    try {
      const fn = hostingFn("cancelSubscription");
      await fn({});
      setUser(prev => ({
        ...prev,
        subscription: {
          ...prev?.subscription,
          plan: "free", isTrial: false, trialEndsAt: null,
          stripeSubscriptionId: null, stripeStatus: "cancelled",
        },
      }));
      flash("Subscription cancelled — you're on the Free plan", "👋");
      go("account");
    } catch {
      flash("Could not cancel. Please try again.", "❌");
      setCancelling(false);
      setCancelConfirm(false);
    }
  };

  // Cancel button shown on active/trial states
  const CancelButton = () => (
    <div style={{ marginTop: 24, paddingTop: 20, borderTop: "1px solid var(--border-card)" }}>
      {cancelConfirm ? (
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 14, color: "var(--text-muted)", fontFamily: "'Inter',sans-serif", marginBottom: 12 }}>
            Are you sure? You'll lose access to Club features immediately.
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <button
              onClick={() => setCancelConfirm(false)}
              style={{ flex: 1, padding: "11px 0", background: "rgba(var(--primary-rgb),0.1)", border: "1px solid rgba(var(--primary-rgb),0.2)", borderRadius: 12, fontSize: 14, fontWeight: 700, color: "var(--primary)", cursor: "pointer", fontFamily: "'Inter',sans-serif" }}
            >
              Keep plan
            </button>
            <button
              onClick={handleCancel}
              disabled={cancelling}
              style={{ flex: 1, padding: "11px 0", background: "none", border: "1px solid rgba(var(--shadow-rgb),0.25)", borderRadius: 12, fontSize: 14, fontWeight: 700, color: "var(--text-muted)", cursor: cancelling ? "default" : "pointer", fontFamily: "'Inter',sans-serif" }}
            >
              {cancelling ? "Cancelling…" : "Yes, cancel"}
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={handleCancel}
          style={{ width: "100%", padding: "11px 0", background: "none", border: "none", fontSize: 13, color: "var(--text-muted)", cursor: "pointer", fontFamily: "'Inter',sans-serif", textDecoration: "underline" }}
        >
          Cancel subscription
        </button>
      )}
    </div>
  );

  const wrap  = { minHeight: "100%", background: "var(--bg-surface)", paddingBottom: 40 };
  const card  = {
    background: "linear-gradient(135deg,var(--bg-card-base),var(--bg-card-alt))",
    backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)",
    borderRadius: 20, padding: "20px 18px", marginBottom: 12,
    boxShadow: "0 4px 20px rgba(var(--shadow-rgb),0.09), inset 0 1px 0 var(--shadow-inset)",
    border: "1px solid var(--border-card)",
  };
  const backBtn = {
    position: "absolute", top: HEADER_BTN_TOP, left: 14,
    background: "none", border: "none", fontSize: 24, cursor: "pointer",
    padding: "4px 8px 4px 0", color: "rgba(255,255,255,0.9)", lineHeight: 1,
  };
  const planHeader = {
    background: "var(--header-gradient)",
    position: "relative",
    padding: `${HEADER_BTN_TOP}px 22px 28px`,
    boxShadow: "0 8px 32px rgba(var(--shadow-rgb),0.25)",
    textAlign: "center",
  };

  /* ── Already on trial ── */
  if (isOnTrial) {
    return (
      <div style={wrap}>
        <div style={planHeader}>
          <button onClick={() => go("account")} style={backBtn}>‹</button>
          <div style={{ fontSize: 36, marginBottom: 8 }}>✨</div>
          <div style={{ fontFamily: "'Inter',sans-serif", fontSize: 22, fontWeight: 700, color: "#fff" }}>Your Plan</div>
          <div style={{ fontSize: 13, color: "rgba(255,255,255,0.75)", marginTop: 4, fontFamily: "'Inter',sans-serif" }}>Club trial active</div>
        </div>
        <div style={{ padding: "0 16px" }}>

          {/* Trial status hero */}
          <div style={{ background: "linear-gradient(145deg,#1a0a2e,#2d1048)", borderRadius: 22, padding: "22px 20px", border: "2px solid rgba(245,158,11,0.45)", boxShadow: "0 8px 32px rgba(245,158,11,0.12)", marginBottom: 12, position: "relative", overflow: "hidden" }}>
            <div style={{ position: "absolute", top: -30, right: -30, width: 120, height: 120, borderRadius: "50%", background: "radial-gradient(circle,rgba(245,158,11,0.2) 0%,transparent 70%)", pointerEvents: "none" }} />
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
              <div style={{ width: 46, height: 46, borderRadius: 14, background: "linear-gradient(135deg,#f59e0b,#d97706)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22 }}>✨</div>
              <div>
                <div style={{ fontFamily: "'Inter',sans-serif", fontSize: 20, fontWeight: 700, color: "#fde68a" }}>Club Plan</div>
                <div style={{ fontSize: 12, color: "rgba(253,230,138,0.65)", fontFamily: "'Inter',sans-serif" }}>Free trial active</div>
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "stretch", gap: 10 }}>
              <div style={{ flex: 1, background: "rgba(245,158,11,0.12)", borderRadius: 14, padding: "14px 16px", border: "1px solid rgba(245,158,11,0.2)", display: "flex", flexDirection: "column", justifyContent: "center" }}>
                <div style={{ fontSize: 11, color: "rgba(253,230,138,0.65)", fontFamily: "'Inter',sans-serif", marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>Days remaining</div>
                <div style={{ fontSize: 40, fontWeight: 800, color: "#fde68a", fontFamily: "'Inter',sans-serif", lineHeight: 1 }}>{trialDaysLeft}</div>
              </div>
              <div style={{ flex: 1, background: "rgba(245,158,11,0.12)", borderRadius: 14, padding: "14px 16px", border: "1px solid rgba(245,158,11,0.2)" }}>
                <div style={{ fontSize: 11, color: "rgba(253,230,138,0.65)", fontFamily: "'Inter',sans-serif", marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>First charge</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: "#fde68a", fontFamily: "'Inter',sans-serif", lineHeight: 1.3 }}>{trialEndStr}</div>
                <div style={{ fontSize: 12, color: "rgba(253,230,138,0.45)", fontFamily: "'Inter',sans-serif", marginTop: 4 }}>${clubPrice}/{clubInterval}</div>
              </div>
            </div>
          </div>

          {/* Club features */}
          <div style={card}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 10, fontFamily: "'Inter',sans-serif" }}>Everything included in your trial</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
              {clubFeatures.map(f => (
                <div key={f} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 14, color: "var(--text-body)", fontFamily: "'Inter',sans-serif" }}>
                  <span style={{ width: 20, height: 20, borderRadius: 999, background: "linear-gradient(135deg,#f59e0b,#d97706)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: "#fff", fontWeight: 800, flexShrink: 0 }}>✓</span>
                  {f}
                </div>
              ))}
            </div>
            <CancelButton />
          </div>

        </div>
      </div>
    );
  }

  /* ── Already on paid Club ── */
  if (currentPlan === "club") {
    return (
      <div style={wrap}>
        <div style={planHeader}>
          <button onClick={() => go("account")} style={backBtn}>‹</button>
          <div style={{ fontSize: 36, marginBottom: 8 }}>✨</div>
          <div style={{ fontFamily: "'Inter',sans-serif", fontSize: 22, fontWeight: 700, color: "#fff" }}>Your Plan</div>
          <div style={{ fontSize: 13, color: "rgba(255,255,255,0.75)", marginTop: 4, fontFamily: "'Inter',sans-serif" }}>Club — enjoy unlimited mahjong</div>
        </div>
        <div style={{ padding: "0 16px" }}>
          <div style={{ ...card, border: "2px solid rgba(245,158,11,0.3)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ fontSize: 36, lineHeight: 1 }}>✨</div>
              <div>
                <div style={{ fontFamily: "'Inter',sans-serif", fontSize: 18, fontWeight: 700, color: "var(--section-title)" }}>Club Plan</div>
                <div style={{ fontSize: 13, color: "var(--text-muted)", fontFamily: "'Inter',sans-serif", marginTop: 2 }}>You're all set — enjoy unlimited mahjong</div>
              </div>
            </div>
            <CancelButton />
          </div>
        </div>
      </div>
    );
  }

  /* ── All plans page (upgrade + downgrade) ── */
  const currentCfg    = planConfigs[currentPlan] ?? freeCfg;
  const currentPrice  = currentCfg?.price ?? 0;
  const currentLimits = getPlanLimits(currentCfg ?? null);

  // Every plan except the one the user is currently on, sorted cheapest → most expensive
  const otherPlans = Object.values(planConfigs)
    .filter(p => p.planKey !== currentPlan)
    .sort((a, b) => (a.price ?? 0) - (b.price ?? 0));

  // Highest-priced upgrade (above current) gets the gold featured treatment
  const upgradePlans = otherPlans.filter(p => (p.price ?? 0) > currentPrice);
  const topPlan      = upgradePlans.length > 0 ? upgradePlans[upgradePlans.length - 1] : null;

  // All plans for comparison table (free + all paid), sorted by price
  const allPlans = Object.values(planConfigs).sort((a, b) => (a.price ?? 0) - (b.price ?? 0));

  return (
    <div style={wrap}>
      {/* Header */}
      <div style={planHeader}>
        <button onClick={() => go("account")} style={backBtn}>‹</button>
        <div style={{ fontSize: 36, marginBottom: 8 }}>🎯</div>
        <div style={{ fontFamily: "'Inter',sans-serif", fontSize: 22, fontWeight: 700, color: "#fff" }}>Plans & Pricing</div>
        <div style={{ fontSize: 13, color: "rgba(255,255,255,0.75)", marginTop: 4, fontFamily: "'Inter',sans-serif" }}>Start free for 30 days, upgrade when ready</div>
      </div>

      <div style={{ padding: "16px 16px 0" }}>

        {/* Current plan — muted */}
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--text-muted)", marginBottom: 6, paddingLeft: 4, fontFamily: "'Inter',sans-serif" }}>Your current plan</div>
          <div style={{ ...card, opacity: 0.7, padding: "14px 16px", marginBottom: 0 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div>
                <div style={{ fontFamily: "'Inter',sans-serif", fontSize: 16, fontWeight: 700, color: "var(--section-title)" }}>{currentCfg?.name || "Basic"}</div>
                <div style={{ fontSize: 12, color: "var(--text-muted)", fontFamily: "'Inter',sans-serif", marginTop: 2 }}>
                  Up to {isFinite(currentLimits.maxGroups) ? currentLimits.maxGroups : "∞"} groups · {isFinite(currentLimits.gamesPerCycle) ? currentLimits.gamesPerCycle : "∞"} hosted game / {currentLimits.cycleDays} days
                </div>
              </div>
              <div style={{ fontSize: 20, fontWeight: 800, color: "var(--text-muted)", fontFamily: "'Inter',sans-serif" }}>${currentPrice}</div>
            </div>
          </div>
        </div>

        {/* Plan cards — upgrades and downgrades */}
        {otherPlans.map(plan => {
          const isTop      = plan.planKey === topPlan?.planKey;
          const isClub     = plan.planKey === "club";
          const planPrice  = plan.price ?? 0;
          const isDowngrade = planPrice < currentPrice;
          const planFeats  = plan.features?.length ? plan.features : ["Everything in lower plans"];

          if (isTop) {
            // Premium / featured card (gold treatment)
            return (
              <div key={plan.planKey} style={{ marginBottom: 4 }}>
                <div style={{ background: "linear-gradient(145deg,#1a0a2e 0%,#2d1048 60%,#1a0a2e 100%)", borderRadius: 22, padding: "22px 20px", border: "2px solid rgba(245,158,11,0.5)", boxShadow: "0 8px 32px rgba(245,158,11,0.18), 0 2px 8px rgba(0,0,0,0.3)", position: "relative", overflow: "hidden", marginBottom: 4 }}>
                  <div style={{ position: "absolute", top: -40, right: -40, width: 130, height: 130, borderRadius: "50%", background: "radial-gradient(circle,rgba(245,158,11,0.22) 0%,transparent 70%)", pointerEvents: "none" }} />
                  <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 14 }}>
                    <div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                        <span style={{ fontSize: 22 }}>✨</span>
                        <span style={{ fontFamily: "'Inter',sans-serif", fontSize: 24, fontWeight: 700, color: "#fde68a" }}>{plan.name}</span>
                      </div>
                      {isClub && (
                        <div style={{ background: "rgba(245,158,11,0.18)", borderRadius: 999, padding: "3px 12px", display: "inline-block", border: "1px solid rgba(245,158,11,0.4)" }}>
                          <span style={{ fontSize: 12, fontWeight: 700, color: "#fde68a", fontFamily: "'Inter',sans-serif" }}>30-day free trial</span>
                        </div>
                      )}
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontSize: 30, fontWeight: 800, color: "#fde68a", fontFamily: "'Inter',sans-serif", lineHeight: 1 }}>${planPrice}</div>
                      <div style={{ fontSize: 12, color: "rgba(253,230,138,0.55)", fontFamily: "'Inter',sans-serif" }}>/{plan.interval || "month"}</div>
                    </div>
                  </div>
                  <div style={{ borderTop: "1px solid rgba(245,158,11,0.18)", marginBottom: 16 }} />
                  <div style={{ display: "flex", flexDirection: "column", gap: 11, marginBottom: 22 }}>
                    {planFeats.map(f => (
                      <div key={f} style={{ display: "flex", alignItems: "center", gap: 11, fontSize: 14, color: "rgba(253,230,138,0.9)", fontFamily: "'Inter',sans-serif" }}>
                        <span style={{ width: 20, height: 20, borderRadius: 999, background: "linear-gradient(135deg,#f59e0b,#d97706)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: "#fff", fontWeight: 800, flexShrink: 0 }}>✓</span>
                        {f}
                      </div>
                    ))}
                  </div>
                  <button
                    onClick={() => handleSubscribe(plan)}
                    disabled={loading}
                    style={{ width: "100%", padding: "16px 20px", background: loading ? "rgba(245,158,11,0.4)" : "linear-gradient(135deg,#f59e0b,#d97706)", border: "none", borderRadius: 14, fontSize: 16, fontWeight: 800, color: "#1a0a2e", fontFamily: "'Inter',sans-serif", cursor: loading ? "default" : "pointer", letterSpacing: 0.3, boxShadow: loading ? "none" : "0 4px 18px rgba(245,158,11,0.45)", transition: "all .2s" }}
                    onMouseDown={e => { if (!loading) e.currentTarget.style.transform = "scale(.98)"; }}
                    onMouseUp={e => { e.currentTarget.style.transform = "scale(1)"; }}
                    onTouchStart={e => { if (!loading) e.currentTarget.style.transform = "scale(.98)"; }}
                    onTouchEnd={e => { e.currentTarget.style.transform = "scale(1)"; }}
                  >
                    {loading ? "Starting…" : isClub ? "Start your free 30-day trial →" : `Upgrade to ${plan.name} →`}
                  </button>
                </div>
                {isClub && (
                  <div style={{ textAlign: "center", padding: "14px 8px 4px", display: "flex", flexDirection: "column", gap: 3 }}>
                    <div style={{ fontSize: 13, color: "var(--text-muted)", fontFamily: "'Inter',sans-serif" }}>No payment today</div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: "var(--section-title)", fontFamily: "'Inter',sans-serif" }}>First charge on {billingDateStr}</div>
                    <div style={{ fontSize: 12, color: "var(--text-muted)", fontFamily: "'Inter',sans-serif" }}>Cancel any time before then and pay nothing</div>
                  </div>
                )}
              </div>
            );
          }

          // Standard (non-top) paid plan card
          return (
            <div key={plan.planKey} style={{ ...card, marginBottom: 10 }}>
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 12 }}>
                <div>
                  <div style={{ fontFamily: "'Inter',sans-serif", fontSize: 18, fontWeight: 700, color: "var(--section-title)", marginBottom: 4 }}>{plan.name}</div>
                  {plan.description && <div style={{ fontSize: 12, color: "var(--text-muted)", fontFamily: "'Inter',sans-serif" }}>{plan.description}</div>}
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 22, fontWeight: 800, color: "var(--section-title)", fontFamily: "'Inter',sans-serif", lineHeight: 1 }}>${planPrice}</div>
                  <div style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "'Inter',sans-serif" }}>/{plan.interval || "month"}</div>
                </div>
              </div>
              <div style={{ borderTop: "1px solid var(--border-card)", paddingTop: 12, marginBottom: 14 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8, fontFamily: "'Inter',sans-serif" }}>Included</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  {planFeats.map(f => (
                    <div key={f} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--text-body)", fontFamily: "'Inter',sans-serif" }}>
                      <span style={{ color: "var(--secondary-accent)", fontWeight: 700 }}>✓</span> {f}
                    </div>
                  ))}
                </div>
              </div>
              <button
                onClick={() => handleSubscribe(plan)}
                style={{ width: "100%", padding: "11px 16px", background: isDowngrade ? "rgba(var(--shadow-rgb),0.06)" : "linear-gradient(135deg,rgba(var(--primary-rgb),0.15),rgba(var(--primary-rgb),0.08))", border: isDowngrade ? "1px solid rgba(var(--shadow-rgb),0.2)" : "1px solid rgba(var(--primary-rgb),0.3)", borderRadius: 12, fontSize: 14, fontWeight: 700, color: isDowngrade ? "var(--text-muted)" : "var(--primary)", cursor: "pointer", fontFamily: "'Inter',sans-serif", transition: "all .2s" }}
                onMouseDown={e => e.currentTarget.style.opacity = "0.7"}
                onMouseUp={e => e.currentTarget.style.opacity = "1"}
                onTouchStart={e => e.currentTarget.style.opacity = "0.7"}
                onTouchEnd={e => e.currentTarget.style.opacity = "1"}
              >
                {isDowngrade ? `Downgrade to ${plan.name} →` : `Upgrade to ${plan.name} →`}
              </button>
            </div>
          );
        })}

        {/* Comparison table — structured limit rows, one column per plan */}
        {allPlans.length > 1 && (() => {
          const fmt = (v) => (v == null || v === 0 || v > 999) ? "Unlimited" : String(v);
          const colW = Math.floor(196 / allPlans.length);

          const rows = [
            {
              label: "Groups",
              values: allPlans.map(p => fmt(p.limits?.maxGroups)),
            },
            {
              label: "Hosted games / 30d",
              values: allPlans.map(p => fmt(p.limits?.gamesPerCycle)),
            },
            {
              label: "Recurring games",
              values: allPlans.map(p => p.limits?.allowRecurring ? "✓" : "✕"),
              boolean: true,
            },
          ];

          // Shared features (present in every plan) shown as a simple list below
          const sharedFeatures = (allPlans[0]?.features ?? []).filter(f =>
            allPlans.every(p => p.features?.includes(f))
          );

          return (
            <div style={{ marginTop: 28 }}>
              <div style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--text-muted)", marginBottom: 10, paddingLeft: 4, fontFamily: "'Inter',sans-serif" }}>Compare plans</div>
              <div style={card}>
                {rows.map((row, i) => (
                  <div key={row.label} style={{ display: "flex", alignItems: "center", paddingBottom: i < rows.length - 1 ? 12 : 0, marginBottom: i < rows.length - 1 ? 12 : 0, borderBottom: i < rows.length - 1 ? "1px solid var(--border-card)" : "none" }}>
                    <div style={{ flex: 1, fontSize: 13, color: "var(--text-body)", fontFamily: "'Inter',sans-serif" }}>{row.label}</div>
                    {row.values.map((val, ci) => {
                      const isTop = allPlans[ci]?.planKey === topPlan?.planKey;
                      const positive = val === "✓" || (val !== "✕" && val !== "0");
                      return (
                        <div key={allPlans[ci].planKey} style={{ width: colW, textAlign: "center", fontSize: row.boolean ? 15 : 12, fontWeight: 700, color: isTop ? "#f59e0b" : positive ? "var(--secondary-accent)" : "var(--text-muted)", fontFamily: "'Inter',sans-serif", opacity: (!positive && row.boolean) ? 0.35 : 1 }}>
                          {val}
                        </div>
                      );
                    })}
                  </div>
                ))}

                {/* Plan name header */}
                <div style={{ display: "flex", marginTop: 12, borderTop: "1px solid var(--border-card)", paddingTop: 10 }}>
                  <div style={{ flex: 1 }} />
                  {allPlans.map(p => (
                    <div key={p.planKey} style={{ width: colW, textAlign: "center", fontSize: 10, fontWeight: 800, color: p.planKey === topPlan?.planKey ? "#f59e0b" : "var(--text-muted)", fontFamily: "'Inter',sans-serif", textTransform: "uppercase", letterSpacing: 0.4 }}>
                      {p.name?.replace(" Plan", "") || p.planKey}
                    </div>
                  ))}
                </div>
              </div>

              {/* Shared features */}
              {sharedFeatures.length > 0 && (
                <div style={{ marginTop: 10, paddingLeft: 4 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--text-muted)", marginBottom: 8, fontFamily: "'Inter',sans-serif" }}>All plans include</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {sharedFeatures.map(f => (
                      <div key={f} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--text-body)", fontFamily: "'Inter',sans-serif" }}>
                        <span style={{ color: "var(--secondary-accent)", fontWeight: 700 }}>✓</span> {f}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })()}

      </div>
    </div>
  );
}

/* ── ACCOUNT PAGE ── */
function Account({ uid, user, setUser, groups, guestGames, flash, go, onSignOut, isAdmin, onImpersonate, isImpersonating, activeThemeId, onThemeChange, planCfg, onInstallPWA, canInstallPWA, isIOSWeb }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email);
  const [notifEnabled, setNotifEnabled] = useState(user.notificationsEnabled === true);
  const [notifDebug, setNotifDebug] = useState(null);
  const [notifPermRevoked, setNotifPermRevoked] = useState(false);
  const [showIOSInstallSteps, setShowIOSInstallSteps] = useState(false);
  const isStandalone = !Capacitor.isNativePlatform() && (
    window.matchMedia("(display-mode: standalone)").matches ||
    ("standalone" in window.navigator && window.navigator.standalone)
  );
  const showInstallRow = !Capacitor.isNativePlatform() && !isStandalone && (canInstallPWA || isIOSWeb);
  const AVATARS = AUTH_AVATARS;
  const [avatar, setAvatar] = useState(user.avatar);
  const [skillLevel, setSkillLevel] = useState(user.skillLevel || "");
  const [timezone, setTimezone] = useState(user.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone);

  const save = async () => {
    const newName = name.trim() || user.name;
    try {
      await updateDoc(doc(db, "users", uid), { name: newName, avatar, skillLevel, timezone });
      setUser({ ...user, name: newName, avatar, skillLevel, timezone });
      setEditing(false);
      flash("Profile updated!", "✨");
    } catch { flash("Error saving profile", "❌"); }
  };

  const isNative = Capacitor.isNativePlatform();
  const isIOS = isNative
    ? Capacitor.getPlatform() === "ios"
    : /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  // Chrome/Firefox/Edge on iOS use WKWebView which blocks the Push API entirely.
  // Only Safari 16.4+ (as an installed PWA) supports web push on iOS.
  const isNonSafariIOS = !isNative && isIOS && !/^((?!chrome|android).)*safari/i.test(navigator.userAgent);
  const notifUnsupported = !isNative && typeof Notification === "undefined";

  // Detect OS/Firestore mismatch: Firestore says enabled but OS permission was revoked.
  // This is the most common reason a user has notificationsEnabled:true but no tokens.
  useEffect(() => {
    if (!notifEnabled) return;
    if (isNative) {
      PushNotifications.checkPermissions().then(({ receive }) => {
        setNotifPermRevoked(receive !== "granted");
      }).catch(() => {});
    } else if (typeof Notification !== "undefined") {
      setNotifPermRevoked(Notification.permission !== "granted");
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleNotifications = async () => {
    if (!notifEnabled) {
      if (isNonSafariIOS) {
        flash("Chrome on iPhone can't receive push notifications — open in Safari and add to Home Screen instead", "🔕");
        return;
      }
      if (notifUnsupported) {
        await updateDoc(doc(db, "users", uid), { notificationsEnabled: true });
        setNotifEnabled(true);
        if (isIOS) {
          flash("On iPhone, add app to Home Screen first", "📱");
        } else {
          flash("Open in Chrome or Firefox to enable notifications", "🌐");
        }
        return;
      }

      const log = [];
      if (!isNative) {
        log.push(`UA: ${navigator.userAgent.slice(0, 80)}`);
        log.push(`Permission before: ${Notification.permission}`);
      }

      let result;
      try {
        result = await enablePushNotificationsWithLog(uid, log);
      } catch (e) {
        log.push(`FATAL: ${e.name} — ${e.message}`);
        result = "error:threw";
      }
      setNotifDebug([...log]);

      if (result === "ok") {
        setNotifEnabled(true);
        flash("Notifications enabled!", "🔔");
      } else if (result === "denied") {
        flash("Notifications blocked — check device settings", "🔕");
      } else if (result === "no-permission") {
        flash("Notifications not granted — tap Allow when asked", "🔕");
      } else if (result === "unsupported") {
        flash("Push notifications not supported in this browser. Try Chrome on desktop or Android.", "⚠️");
      } else if (result === "empty-token") {
        flash("Could not get a push token — on iPhone, add to Home Screen first", "⚠️");
      } else {
        flash(`Could not enable notifications (${result})`, "⚠️");
      }
    } else {
      await updateDoc(doc(db, "users", uid), { notificationsEnabled: false });
      setNotifEnabled(false);
      setNotifDebug(null);
      flash("Notifications disabled", "🔕");
    }
  };

  const activeGroups = groups.filter((g) => g.status !== "archived" && g.status !== "deleted");

  return (
    <div style={{ minHeight: "100%", background: `linear-gradient(170deg,var(--bg-shell-start) 0%,var(--bg-shell-mid) 40%,var(--bg-shell-end) 100%)` }}>
      {/* Header */}
      <div style={{
        background: "var(--header-gradient)",
        backdropFilter: "blur(14px)", WebkitBackdropFilter: "blur(14px)",
        padding: `${HEADER_BTN_TOP}px 22px 30px`, textAlign: "center",
        boxShadow: "0 8px 32px rgba(var(--shadow-rgb),0.25)",
        position: "relative", overflow: "hidden",
      }}>
        <div style={{ position: "absolute", inset: 0, background: "linear-gradient(135deg,rgba(255,255,255,0.15) 0%,transparent 55%)", pointerEvents: "none" }} />
        {/* Avatar */}
        <div style={{
          width: 84, height: 84, borderRadius: 999, margin: "0 auto 12px",
          background: avatarBg(user.avatar),
          display: "flex", alignItems: "center", justifyContent: "center",
          overflow: "hidden", border: "3px solid rgba(255,255,255,0.30)",
          boxShadow: "0 6px 24px rgba(0,0,0,0.35), 0 0 0 1px rgba(255,255,255,0.12)",
          position: "relative",
        }}>
          <AvatarImg av={user.avatar} size={78} />
        </div>
        <h1 style={{ fontFamily: "'Inter',sans-serif", fontSize: 23, color: "#fff", textShadow: "0 2px 8px rgba(0,0,0,.2)", letterSpacing: 0.5 }}>{user.name}</h1>
        <p style={{ color: "rgba(255,255,255,.7)", fontSize: 14, marginTop: 4, fontFamily: "'Inter',sans-serif" }}>{user.email}</p>

      </div>

      <div style={{ padding: "22px 16px" }}>
        {/* Profile card */}
        <div style={{
          background: "linear-gradient(135deg,var(--bg-card-base),var(--bg-card-alt))",
          backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)",
          borderRadius: 20, padding: "20px 18px", marginBottom: 14,
          boxShadow: "0 4px 20px rgba(var(--shadow-rgb),0.09), inset 0 1px 0 var(--shadow-inset)",
          border: "1px solid var(--border-card)",
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
            <span style={{ fontFamily: "'Inter',sans-serif", fontSize: 17, color: "var(--section-title)", fontWeight: 700 }}>My Profile</span>
<button onClick={() => setEditing(!editing)} style={{ background: editing ? "var(--active-tab-gradient)" : "rgba(var(--primary-rgb),0.12)", border: "none", borderRadius: 999, padding: "5px 14px", fontSize: 13, fontWeight: 700, color: editing ? "#fff" : "var(--primary)", cursor: "pointer", fontFamily: "'Inter',sans-serif", transition: "all .2s" }}>
              {editing ? "Cancel" : "Edit ✏️"}
            </button>
          </div>

          {editing ? (
            <>
              <Lbl>Display Name</Lbl>
              <input value={name} onChange={(e) => setName(e.target.value)} style={inputSt} />
              <Lbl mt>Email</Lbl>
              <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" style={inputSt} />
              <Lbl mt>Skill Level</Lbl>
              <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
                {[["Beginner","🌱"],["Intermediate","🀄"],["Advanced","🏆"]].map(([lvl, icon]) => (
                  <div key={lvl} onClick={() => setSkillLevel(lvl)} style={{
                    flex: 1, padding: "10px 6px", borderRadius: 12, textAlign: "center", cursor: "pointer",
                    background: skillLevel === lvl ? `linear-gradient(135deg,var(--primary),var(--primary-dark))` : "var(--border-card)",
                    border: `2px solid ${skillLevel === lvl ? "transparent" : "rgba(var(--primary-rgb),0.15)"}`,
                    boxShadow: skillLevel === lvl ? "0 4px 12px rgba(var(--shadow-rgb),0.2)" : "none",
                    transition: "all .18s",
                  }}>
                    <div style={{ fontSize: 20, marginBottom: 4 }}>{icon}</div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: skillLevel === lvl ? "#fff" : "var(--text-body)", fontFamily: "'Inter',sans-serif" }}>{lvl}</div>
                  </div>
                ))}
              </div>
              <Lbl mt>Timezone</Lbl>
              <select value={timezone} onChange={(e) => setTimezone(e.target.value)} style={{ width: "100%", padding: "10px 12px", borderRadius: 10, border: "1.5px solid var(--border-input)", background: "var(--bg-input)", color: "var(--text-body)", fontSize: 14, fontFamily: "'Inter',sans-serif", marginBottom: 14, outline: "none" }}>
                {TIMEZONES.filter((v, i, a) => a.indexOf(v) === i).map((tz) => (
                  <option key={tz} value={tz}>{tz.replace(/_/g, " ")}</option>
                ))}
              </select>
              <Lbl mt>Avatar</Lbl>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 8, marginBottom: 18 }}>
                {AVATAR_DEFS.map(({ id, bg }) => (
                  <div key={id} onClick={() => setAvatar(id)} style={{
                    aspectRatio: "1", borderRadius: 14, background: bg,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 26, cursor: "pointer",
                    border: `2px solid ${avatar === id ? "var(--primary)" : "transparent"}`,
                    boxShadow: avatar === id
                      ? "0 0 0 1px var(--primary), 0 4px 16px rgba(var(--primary-rgb),0.45)"
                      : "0 2px 10px rgba(0,0,0,0.38)",
                    transform: avatar === id ? "scale(1.1)" : "scale(1)",
                    transition: "all .15s",
                  }}>{id}</div>
                ))}
              </div>
              <Btn full onClick={save}>Save Changes ✨</Btn>
            </>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {[["👤", "Name", user.name], ["📧", "Email", user.email]].map(([icon, lbl, val]) => (
                <div key={lbl} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 17 }}>{icon}</span>
                  <div>
                    <div style={{ fontSize: 11, color: "var(--primary-faint)", fontWeight: 700, textTransform: "uppercase", letterSpacing: .5 }}>{lbl}</div>
                    <div style={{ fontSize: 15, color: "var(--text-body)", fontWeight: 500, marginTop: 1 }}>{val}</div>
                  </div>
                </div>
              ))}
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 17 }}>🎯</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 11, color: "var(--primary-faint)", fontWeight: 700, textTransform: "uppercase", letterSpacing: .5 }}>Skill Level</div>
                  {user.skillLevel ? (
                    <div style={{ fontSize: 15, color: "var(--text-body)", fontWeight: 500, marginTop: 1 }}>{user.skillLevel}</div>
                  ) : (
                    <div style={{ fontSize: 13, color: "var(--primary)", fontWeight: 700, marginTop: 1, cursor: "pointer" }} onClick={() => setEditing(true)}>
                      Please select your skill level →
                    </div>
                  )}
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 17 }}>🌐</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 11, color: "var(--primary-faint)", fontWeight: 700, textTransform: "uppercase", letterSpacing: .5 }}>Timezone</div>
                  <div style={{ fontSize: 15, color: "var(--text-body)", fontWeight: 500, marginTop: 1 }}>{(user.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone).replace(/_/g, " ")}</div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ── Subscription plan card ── */}
        {(() => {
          const plan = getPlan(user);
          const lim = getPlanLimits(planCfg);
          const hostCheck = canHostGame(user, groups, planCfg);
          const groupsUsed = activeGroups.length;
          const futureHostedCount = activeGroups.reduce((n, g) =>
            n + (g.games || []).filter(gm => gm.hostId === user?.uid && gm.date > Date.now() && gm.status !== "archived" && gm.status !== "deleted").length, 0);

          const Bar = ({ used, max, color }) => (
            <div style={{ height: 6, background: "rgba(var(--primary-rgb),0.1)", borderRadius: 999, overflow: "hidden", marginTop: 6 }}>
              <div style={{ height: "100%", width: `${Math.min(100, (used / max) * 100)}%`, background: used >= max ? "var(--primary)" : color || "var(--secondary-accent)", borderRadius: 999, transition: "width .4s" }} />
            </div>
          );

          const isTrial     = user?.subscription?.isTrial === true && plan !== "free";
          const trialEndsAt = user?.subscription?.trialEndsAt;
          const trialDaysLeft = trialEndsAt ? Math.max(0, Math.ceil((trialEndsAt - Date.now()) / 86400000)) : 0;
          const trialEndStr   = trialEndsAt
            ? new Date(trialEndsAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
            : "";

          return (
            <div style={{
              background: "linear-gradient(135deg,var(--bg-card-base),var(--bg-card-alt))",
              backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)",
              borderRadius: 20, padding: "20px 18px", marginBottom: 14,
              boxShadow: "0 4px 20px rgba(var(--shadow-rgb),0.09), inset 0 1px 0 var(--shadow-inset)",
              border: isTrial ? "1.5px solid rgba(245,158,11,0.4)" : "1px solid var(--border-card)",
            }}>
              {/* Header */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: isTrial ? 10 : 16 }}>
                <span style={{ fontFamily: "'Inter',sans-serif", fontSize: 17, color: "var(--section-title)", fontWeight: 700 }}>Subscription</span>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
                  {isTrial ? (
                    <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: 0.5, textTransform: "uppercase", background: "linear-gradient(135deg,rgba(245,158,11,0.2),rgba(245,158,11,0.1))", color: "#d97706", borderRadius: 999, padding: "4px 12px", border: "1px solid rgba(245,158,11,0.35)", fontFamily: "'Inter',sans-serif" }}>
                      {planCfg?.name || "Club"} · Trial
                    </span>
                  ) : (
                    <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: 0.5, textTransform: "uppercase", background: "linear-gradient(135deg,rgba(var(--primary-rgb),0.12),rgba(var(--primary-rgb),0.06))", color: "var(--primary)", borderRadius: 999, padding: "4px 12px", border: "1px solid rgba(var(--primary-rgb),0.2)", fontFamily: "'Inter',sans-serif" }}>
                      {planCfg?.name || "Basic"}
                    </span>
                  )}
                </div>
              </div>

              {/* Trial info strip */}
              {isTrial && (
                <div style={{ background: "rgba(245,158,11,0.1)", borderRadius: 10, padding: "10px 12px", marginBottom: 14, border: "1px solid rgba(245,158,11,0.2)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div style={{ fontSize: 13, color: "#d97706", fontFamily: "'Inter',sans-serif", fontWeight: 600 }}>🎁 Free trial</div>
                  <div style={{ fontSize: 12, color: "#d97706", fontFamily: "'Inter',sans-serif" }}>
                    {trialDaysLeft}d left · billed {trialEndStr}
                  </div>
                </div>
              )}

              {/* Usage rows */}
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                {/* Groups */}
                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-body)", fontFamily: "'Inter',sans-serif" }}>👥 Groups</div>
                    <div style={{ fontSize: 13, color: isFinite(lim.maxGroups) && groupsUsed >= lim.maxGroups ? "var(--primary)" : "var(--text-muted)", fontWeight: 700, fontFamily: "'Inter',sans-serif" }}>
                      {groupsUsed} / {isFinite(lim.maxGroups) ? lim.maxGroups : "∞"}
                    </div>
                  </div>
                  <Bar used={groupsUsed} max={isFinite(lim.maxGroups) ? lim.maxGroups : groupsUsed + 1} />
                  {isFinite(lim.maxGroups) && groupsUsed >= lim.maxGroups && (
                    <div style={{ fontSize: 12, color: "var(--primary)", marginTop: 5, fontFamily: "'Inter',sans-serif" }}>
                      Group limit reached
                    </div>
                  )}
                </div>

                {/* Hosted games */}
                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-body)", fontFamily: "'Inter',sans-serif" }}>🀄 Upcoming hosted games</div>
                    <div style={{ fontSize: 13, color: isFinite(lim.gamesPerCycle) && futureHostedCount >= lim.gamesPerCycle ? "var(--primary)" : "var(--text-muted)", fontWeight: 700, fontFamily: "'Inter',sans-serif" }}>
                      {futureHostedCount} / {isFinite(lim.gamesPerCycle) ? lim.gamesPerCycle : "∞"}
                    </div>
                  </div>
                  <Bar used={futureHostedCount} max={isFinite(lim.gamesPerCycle) ? lim.gamesPerCycle : futureHostedCount + 1} />
                  <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 5, fontFamily: "'Inter',sans-serif" }}>
                    {isFinite(lim.gamesPerCycle) && futureHostedCount >= lim.gamesPerCycle
                      ? "Limit reached — archive or wait for a game to pass to free up a slot"
                      : "Slot available — schedule a game"}
                  </div>
                </div>

                {/* Divider */}
                {(() => {
                  const feats = planCfg?.features?.length
                    ? planCfg.features
                    : ["Group & game chat", "Send group and game invites", "Add games to calendar"];
                  return (
                    <div style={{ borderTop: "1px solid var(--border-card)", paddingTop: 12 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8, fontFamily: "'Inter',sans-serif" }}>Included</div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                        {feats.map((f) => (
                          <div key={f} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--text-body)", fontFamily: "'Inter',sans-serif" }}>
                            <span style={{ color: "var(--secondary-accent)", fontWeight: 700 }}>✓</span> {f}
                          </div>
                        ))}
                      </div>
                      <button
                        onClick={() => go("managePlan")}
                        style={{ marginTop: 14, width: "100%", padding: "12px 16px", background: "linear-gradient(135deg,rgba(var(--primary-rgb),0.12),rgba(var(--primary-rgb),0.06))", border: "1px solid rgba(var(--primary-rgb),0.25)", borderRadius: 12, fontSize: 14, fontWeight: 700, color: "var(--primary)", cursor: "pointer", fontFamily: "'Inter',sans-serif", transition: "all .2s" }}
                        onMouseDown={e => e.currentTarget.style.opacity = "0.7"}
                        onMouseUp={e => e.currentTarget.style.opacity = "1"}
                        onTouchStart={e => e.currentTarget.style.opacity = "0.7"}
                        onTouchEnd={e => e.currentTarget.style.opacity = "1"}
                      >
                        Manage Subscription →
                      </button>
                    </div>
                  );
                })()}
              </div>
            </div>
          );
        })()}

        {/* Notification settings */}
        <div style={{
          background: "linear-gradient(135deg,var(--bg-card-base),var(--bg-card-alt))",
          backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)",
          borderRadius: 20, padding: "20px 18px", marginBottom: 14,
          boxShadow: "0 4px 20px rgba(var(--shadow-rgb),0.09), inset 0 1px 0 var(--shadow-inset)",
          border: "1px solid var(--border-card)",
        }}>
          <span style={{ fontFamily: "'Inter',sans-serif", fontSize: 17, color: "var(--section-title)", fontWeight: 700 }}>Notifications</span>
          <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 12 }}>

            {/* Add to Home Screen — web only, hidden once already installed */}
            {showInstallRow && (
              <div style={{ borderRadius: 14, background: "var(--bg-surface)", border: "1px solid rgba(var(--border-light-rgb),0.3)", overflow: "hidden" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px" }}>
                  <div style={{ width: 40, height: 40, borderRadius: 12, background: "rgba(var(--primary-rgb),0.1)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 21, flexShrink: 0 }}>📲</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-body)" }}>Add to Home Screen</div>
                    <div style={{ fontSize: 13, color: "#b08090", marginTop: 2 }}>
                      {isIOSWeb ? "Required for push notifications on iPhone" : "Install the app for the best experience"}
                    </div>
                  </div>
                  {canInstallPWA ? (
                    <button onClick={onInstallPWA} style={{
                      background: "var(--active-tab-gradient)", border: "none", borderRadius: 10,
                      padding: "8px 14px", color: "#fff", fontSize: 13, fontWeight: 700,
                      cursor: "pointer", fontFamily: "'Inter',sans-serif", flexShrink: 0,
                    }}>Install</button>
                  ) : (
                    <button onClick={() => setShowIOSInstallSteps(v => !v)} style={{
                      background: "rgba(var(--primary-rgb),0.12)", border: "1px solid rgba(var(--primary-rgb),0.2)",
                      borderRadius: 10, padding: "8px 14px", color: "var(--primary)", fontSize: 13, fontWeight: 700,
                      cursor: "pointer", fontFamily: "'Inter',sans-serif", flexShrink: 0,
                    }}>How to</button>
                  )}
                </div>
                {showIOSInstallSteps && (
                  <div style={{ padding: "0 14px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
                    {[
                      ["1", "Tap the Share button", "at the bottom of Safari (the box with an arrow)"],
                      ["2", "Scroll down and tap", '"Add to Home Screen"'],
                      ["3", "Tap Add", "in the top-right corner"],
                    ].map(([n, bold, rest]) => (
                      <div key={n} style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                        <div style={{ width: 22, height: 22, borderRadius: 999, background: "var(--active-tab-gradient)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 800, color: "#fff", flexShrink: 0, marginTop: 1 }}>{n}</div>
                        <div style={{ fontSize: 13, color: "var(--text-body)", fontFamily: "'Inter',sans-serif", lineHeight: 1.5 }}>
                          <strong>{bold}</strong> {rest}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", borderRadius: 14, background: "var(--bg-surface)", border: "1px solid rgba(var(--border-light-rgb),0.3)" }}>
              <div style={{ width: 40, height: 40, borderRadius: 12, background: notifEnabled ? "var(--active-tab-gradient)" : "rgba(var(--primary-rgb),0.1)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 21, transition: "all .2s" }}>
                {notifEnabled ? "🔔" : "🔕"}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-body)" }}>Push Notifications</div>
                <div style={{ fontSize: 13, color: "#b08090", marginTop: 2 }}>
                  {notifEnabled
                    ? "You'll be notified of new messages and game updates"
                    : isNonSafariIOS
                      ? "Not supported in Chrome on iPhone — open in Safari and add to Home Screen"
                      : notifUnsupported && isIOS
                        ? "Tap Share → Add to Home Screen, then re-enable"
                        : "Enable to get alerts for group chats and games"}
                </div>
              </div>
              {/* Toggle switch */}
              <div onClick={toggleNotifications} style={{
                width: 50, height: 28, borderRadius: 999, cursor: "pointer",
                background: notifEnabled ? "var(--active-tab-gradient)" : "rgba(var(--primary-rgb),0.18)",
                position: "relative", transition: "all .22s", flexShrink: 0,
                border: `2px solid ${notifEnabled ? "transparent" : "rgba(var(--primary-rgb),0.2)"}`,
              }}>
                <div style={{
                  position: "absolute", top: 2, left: notifEnabled ? 22 : 2,
                  width: 20, height: 20, borderRadius: 999,
                  background: notifEnabled ? "#fff" : "rgba(var(--primary-rgb),0.4)",
                  transition: "left .22s, background .22s",
                  boxShadow: notifEnabled ? "0 2px 6px rgba(var(--shadow-rgb),0.3)" : "none",
                }} />
              </div>
            </div>
          </div>

          {/* OS permission revoked warning — Firestore says enabled but OS disagrees */}
          {notifEnabled && notifPermRevoked && (
            <div style={{ marginTop: 8, padding: "10px 14px", borderRadius: 12, background: "rgba(220,80,60,0.10)", border: "1px solid rgba(220,80,60,0.25)", display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 18 }}>⚠️</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-body)", marginBottom: 2 }}>Notifications permission was revoked</div>
                <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                  {isIOS ? "Re-enable below, then allow in the system prompt or check Settings → Mahjong Club." : "Tap the toggle to re-grant notification permission."}
                </div>
              </div>
              <div onClick={async () => {
                setNotifEnabled(false);
                setNotifPermRevoked(false);
                const log = [];
                let result;
                try { result = await enablePushNotificationsWithLog(uid, log); } catch (e) { log.push(`FATAL: ${e.name} — ${e.message}`); result = "error:threw"; }
                setNotifDebug([...log]);
                if (result === "ok") { setNotifEnabled(true); flash("Notifications re-enabled!", "🔔"); }
                else if (result === "denied") { flash("Still blocked — check Settings → Mahjong Club → Notifications", "🔕"); setNotifPermRevoked(true); }
                else { flash(`Could not re-enable (${result})`, "⚠️"); }
              }} style={{ fontSize: 12, fontWeight: 700, color: "var(--primary)", cursor: "pointer", flexShrink: 0, padding: "6px 10px", borderRadius: 8, background: "rgba(var(--primary-rgb),0.1)" }}>
                Fix →
              </div>
            </div>
          )}

          {/* FCM debug log — shows after a failed enable attempt */}
          {notifDebug && (
            <div style={{ marginTop: 10, background: "rgba(0,0,0,0.06)", borderRadius: 12, padding: "10px 14px" }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", marginBottom: 6, letterSpacing: "0.05em", textTransform: "uppercase" }}>Notification Debug</div>
              {notifDebug.map((line, i) => (
                <div key={i} style={{ fontSize: 11, fontFamily: "monospace", color: line.startsWith("FAIL") ? "#e05050" : "var(--text-body)", lineHeight: 1.6, wordBreak: "break-all" }}>{line}</div>
              ))}
              <div onClick={() => setNotifDebug(null)} style={{ marginTop: 8, fontSize: 11, color: "var(--text-muted)", cursor: "pointer", textDecoration: "underline" }}>Dismiss</div>
            </div>
          )}
        </div>

        {/* Theme picker */}
        <div style={{
          background: "linear-gradient(135deg,var(--bg-card-base),var(--bg-card-alt))",
          backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)",
          borderRadius: 20, padding: "20px 18px", marginBottom: 14,
          boxShadow: "0 4px 20px rgba(var(--shadow-rgb),0.09), inset 0 1px 0 var(--shadow-inset)",
          border: "1px solid var(--border-card)",
        }}>
          <span style={{ fontFamily: "'Inter',sans-serif", fontSize: 17, color: "var(--section-title)", fontWeight: 700 }}>Appearance</span>
          <div style={{ display: "flex", gap: 10, marginTop: 14, flexWrap: "wrap" }}>
            {Object.values(themes).map((t) => {
              const active = activeThemeId === t.id;
              return (
                <button
                  key={t.id}
                  onClick={() => onThemeChange(t.id)}
                  style={{
                    flex: 1, minWidth: 120,
                    padding: "14px 12px",
                    borderRadius: 16,
                    border: active ? `2px solid ${t.primary}` : "2px solid var(--border-card)",
                    background: active
                      ? `linear-gradient(135deg,${t.bgShellStart},${t.bgShellEnd})`
                      : `linear-gradient(135deg,${t.bgShellStart}66,${t.bgShellEnd}44)`,
                    cursor: "pointer",
                    textAlign: "left",
                    boxShadow: active ? `0 4px 16px ${t.shadowPrimary}` : "none",
                    transition: "all .2s",
                    position: "relative",
                    fontFamily: "'Inter',sans-serif",
                  }}
                >
                  {active && (
                    <div style={{
                      position: "absolute", top: 7, right: 8,
                      width: 18, height: 18, borderRadius: "50%",
                      background: t.primary,
                      display: "flex", alignItems: "center", justifyContent: "center",
                      fontSize: 10, color: "#fff", fontWeight: 900,
                    }}>✓</div>
                  )}
                  <div style={{ marginBottom: 6, height: 28, display: "flex", alignItems: "center" }}>
                    {t.id === "forest" ? (
                      <svg viewBox="0 0 62 26" width="40" height="17" style={{ fill: t.primary, display: "block" }}>
                        {/* Side-profile bird, facing left, wings raised mid-flap */}
                        {/* Body + wing + tail silhouette */}
                        <path d="M2,18 L5,14 C8,11 12,10 14,11 C18,6 26,2 34,2 C42,2 48,8 50,16 C52,15 56,13 59,14 C58,18 56,21 53,22 C46,24 34,24 22,23 C14,22 8,20 6,20 Z"/>
                        {/* Round head overlapping beak joint */}
                        <circle cx="9" cy="14" r="4.5"/>
                      </svg>
                    ) : (
                      <span style={{ fontSize: 22 }}>{t.emoji}</span>
                    )}
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: t.textBody }}>{t.name}</div>
                  {/* Colour swatches */}
                  <div style={{ display: "flex", gap: 4, marginTop: 8 }}>
                    {[t.primary, t.bgShellStart, t.bgShellMid, t.bgShellEnd, t.primaryFaint].map((c, i) => (
                      <div key={i} style={{ width: 14, height: 14, borderRadius: "50%", background: c, border: "1.5px solid rgba(255,255,255,0.6)" }} />
                    ))}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* About */}
        <div style={{
          background: "linear-gradient(135deg,var(--bg-surface),var(--bg-card-alt))",
          backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)",
          borderRadius: 20, padding: "18px", textAlign: "center",
          border: "1px solid rgba(var(--border-light-rgb),0.4)",
        }}>
          <div style={{ fontSize: 23, marginBottom: 6 }}>🀄</div>
          <div style={{ fontFamily: "'Inter',sans-serif", fontSize: 15, color: "var(--primary-muted)", fontWeight: 600 }}>Mahjong Club</div>
          <div style={{ fontSize: 12, color: "#c0a0b0", marginTop: 4, fontFamily: "'Inter',sans-serif" }}>Version 1.0 · Made with ❤️</div>
        </div>

        {/* Admin Panel */}
        {isAdmin && !isImpersonating && <AdminPanel onImpersonate={onImpersonate} />}

        {/* Sign Out */}
        <button onClick={onSignOut} style={{
          width: "100%", padding: "13px", marginTop: 6, borderRadius: 999,
          background: "transparent", border: "2px solid rgba(var(--primary-rgb),0.35)",
          color: "var(--primary)", fontSize: 15, fontWeight: 700,
          fontFamily: "'Inter',sans-serif", cursor: "pointer",
          transition: "all .18s", letterSpacing: 0.3,
        }}
          onMouseDown={(e) => e.currentTarget.style.transform = "scale(.97)"}
          onMouseUp={(e) => e.currentTarget.style.transform = "scale(1)"}
          onTouchStart={(e) => e.currentTarget.style.transform = "scale(.97)"}
          onTouchEnd={(e) => e.currentTarget.style.transform = "scale(1)"}
        >
          Sign Out 👋
        </button>
      </div>
    </div>
  );
}

/* ── RSVP AVATAR STACK ── */
// Small red circle with white number, positioned top-right of a `position: relative` parent.
// Hidden entirely when count is 0; caps display at "99+".
function Badge({ count }) {
  if (!count || count <= 0) return null;
  return (
    <span style={{
      position: "absolute", top: -6, right: -6, zIndex: 1,
      minWidth: 18, height: 18, padding: "0 4px",
      borderRadius: 999, background: "#e53e3e", color: "#fff",
      fontSize: 11, fontWeight: 700, lineHeight: "18px", textAlign: "center",
      fontFamily: "'Inter',sans-serif", boxShadow: "0 1px 4px rgba(0,0,0,0.35)",
      border: "1.5px solid var(--bg-card-base)", pointerEvents: "none",
    }}>{count > 99 ? "99+" : count}</span>
  );
}

function RsvpStack({ players, max = 5, size = 30, onClick }) {
  const ins = players.filter(p => p.state === "in");
  const shown = ins.slice(0, max);
  const overflow = ins.length - shown.length;
  const overlap = -Math.round(size * 0.27);
  const fontSize = Math.round(size * 0.37);

  // Disambiguate initials: if two shown players share a first letter, use two chars
  const rawInits = shown.map(p => (p.name || "?")[0].toUpperCase());
  const labels = shown.map((p, i) => {
    const init = rawInits[i];
    const isDupe = rawInits.some((c, j) => j !== i && c === init);
    return isDupe ? (p.name || "??").slice(0, 2) : init;
  });

  if (ins.length === 0) {
    return (
      <button onClick={onClick} aria-label="0 going. Tap to see all."
        style={{ display: "flex", alignItems: "center", background: "transparent", border: "none", padding: 0, cursor: onClick ? "pointer" : "default" }}>
        <span style={{
          width: size, height: size, borderRadius: size / 2,
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          border: "1.5px dashed var(--border-input)",
          fontSize: Math.round(size * 0.4), fontWeight: 600,
          color: "var(--text-subtle)", opacity: 0.45,
          boxSizing: "border-box",
        }}>+</span>
      </button>
    );
  }

  return (
    <button onClick={onClick} aria-label={`${ins.length} going. Tap to see all.`}
      style={{ display: "flex", alignItems: "center", background: "transparent", border: "none", padding: 0, cursor: onClick ? "pointer" : "default" }}>
      {shown.map((p, i) => (
        <span key={p.id || i} title={p.name} aria-label={p.name}
          style={{
            width: size, height: size, borderRadius: size / 2,
            background: "var(--primary)",
            color: "#fff",
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            fontFamily: "'Inter',sans-serif",
            fontSize, fontWeight: 600,
            border: "2px solid var(--bg-card-base)",
            marginLeft: i === 0 ? 0 : overlap,
            position: "relative", zIndex: max - i,
            boxSizing: "border-box", flexShrink: 0,
          }}
        >{labels[i]}</span>
      ))}
      {overflow > 0 && (
        <span aria-label={`${overflow} more going`}
          style={{
            height: size, padding: "0 9px", borderRadius: size / 2,
            background: "var(--bg-surface)",
            border: "2px solid var(--bg-card-base)",
            color: "var(--text-muted)",
            display: "inline-flex", alignItems: "center",
            fontFamily: "'Inter',sans-serif",
            fontVariantNumeric: "tabular-nums",
            fontSize: Math.round(size * 0.4), fontWeight: 600,
            marginLeft: overlap,
            boxSizing: "border-box", flexShrink: 0,
          }}
        >+{overflow}</span>
      )}
    </button>
  );
}

/* ── SHARED GAME CARD ── */
function GameCard({ gm, groups, user, go, animDelay = 0, unreadCounts = {} }) {
  const MON_ABR = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
  const DOW_ABR = ["SUN","MON","TUE","WED","THU","FRI","SAT"];

  const resolveName = (playerId) => {
    if (playerId === user?.uid && user?.name) return user.name;
    if (playerId === gm.hostId && gm.host) return gm.host;
    const grp = groups.find(g => g.id === gm.groupId);
    const members = grp?.members || gm.groupMembers || [];
    const member = members.find(m => m.id === playerId);
    if (member) return member.name || "?";
    const allG = [...(gm.guests||[]), ...(gm.registeredGuests||[])];
    const guest = allG.find(g => g.id === playerId);
    if (guest) return guest.name || "?";
    return "?";
  };

  const d = new Date(gm.date);
  const monAbbr = MON_ABR[d.getMonth()];
  const dayNum = d.getDate();
  const dowAbbr = DOW_ABR[d.getDay()];
  const wl = gm.waitlist || [];
  const yesUids = Object.entries(gm.rsvps || {}).filter(([,v]) => v === "yes").map(([id]) => id);
  const maybeUids = Object.entries(gm.rsvps || {}).filter(([,v]) => v === "maybe").map(([id]) => id);
  const confirmedG = (gm.guests || []).filter(g => !wl.includes(g.id));
  const yesCount = yesUids.length + confirmedG.length;
  const maybeCount = maybeUids.length;
  const isHostCard = gm.hostId === user?.uid;
  const stackPlayers = [
    ...yesUids.map(id => ({ id, name: resolveName(id), state: "in" })),
    ...confirmedG.map(g => ({ id: g.id, name: g.name || "?", state: "in" })),
  ];
  const gameHash = (gm.id||"").split("").reduce((h,c) => (Math.imul(31,h) + c.charCodeAt(0))|0, 0);
  const gameNum = ((gameHash >>> 0) % 900) + 100;
  const isPast = gm.date < startOfTodayInTz(user?.timezone);
  const winnerFirstName = gm.winner ? (gm.winner.uid === user?.uid ? "You" : (gm.winner.name || "").split(" ")[0]) : null;
  const unread = unreadCounts[gm.id] || 0;

  return (
    <div className="sUp" style={{ animationDelay: `${animDelay}s`, marginBottom: 10, cursor: "pointer" }}
      onClick={() => go(gm.isStandalone ? "standaloneGame" : gm.isGuestGame ? "guestGame" : "game", gm.groupId, gm.id)}>
      <div style={{ background: "var(--bg-card-base)", borderRadius: 16, border: "1px solid var(--border-card)", overflow: "hidden", boxShadow: "0 2px 10px rgba(var(--shadow-rgb),0.06)" }}>
        <div style={{ display: "flex", gap: 12, padding: "12px 14px 10px", alignItems: "center" }}>
          <div style={{ position: "relative", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", width: 54, minWidth: 54, padding: "6px 4px", background: "var(--date-block-bg)", border: "1px solid rgba(var(--primary-rgb),0.20)", borderRadius: 10, flexShrink: 0 }}>
            <span style={{ fontSize: 9, fontWeight: 700, color: "var(--primary)", letterSpacing: 1.2, fontFamily: "'Inter',sans-serif" }}>{monAbbr}</span>
            <span style={{ fontSize: 24, fontWeight: 700, color: "var(--text-body)", fontFamily: "'Inter',sans-serif", lineHeight: 1.1 }}>{dayNum}</span>
            <span style={{ fontSize: 9, fontWeight: 700, color: "var(--primary)", letterSpacing: 1.2, fontFamily: "'Inter',sans-serif" }}>{dowAbbr}</span>
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <span style={{ fontSize: 16, fontWeight: 700, color: "var(--text-body)", fontFamily: "'Inter',sans-serif", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{gm.title}</span>
              {isHostCard && !isPast && (
                <span style={{ display: "flex", alignItems: "center", gap: 3, flexShrink: 0 }}>
                  <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--primary)", display: "inline-block" }} />
                  <span style={{ fontSize: 10, fontWeight: 700, color: "var(--primary)", letterSpacing: 1, fontFamily: "'Inter',sans-serif" }}>HOSTING</span>
                </span>
              )}
            </div>
            {isPast ? (
              <div style={{ fontSize: 12, fontFamily: "'Inter',sans-serif", display: "flex", alignItems: "center", gap: 4 }}>
                <span style={{ color: "var(--text-muted)", flexShrink: 0 }}>Winner:</span>
                <span style={{ color: "var(--text-body)", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{winnerFirstName || "—"}</span>
              </div>
            ) : (gm.time || gm.location) && (
              <div style={{ fontSize: 12, color: "var(--text-muted)", fontFamily: "'Inter',sans-serif", display: "flex", flexDirection: "column", gap: 2, overflow: "hidden" }}>
                {gm.time && <span style={{ flexShrink: 0 }}>⏱ {fmtRange(gm.time, gm.endTime)}</span>}
                {gm.location && <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>📍 {gm.location}</span>}
              </div>
            )}
          </div>
        </div>
        <div style={{ height: 1, background: "var(--border-input)", margin: "0 14px 0 80px" }} />
        <div style={{ display: "flex", alignItems: "center", padding: "8px 14px", gap: 8 }}>
          <RsvpStack players={stackPlayers} max={4} size={26} />
          <span style={{ fontSize: 12, color: "var(--text-muted)", fontFamily: "'Inter',sans-serif", flex: 1 }}>
            {isPast
              ? <>{yesCount > 0 ? `${yesCount} played` : "No players"}</>
              : <>{yesCount > 0 && `${yesCount} in`}{yesCount > 0 && maybeCount > 0 ? " · " : ""}{maybeCount > 0 && `${maybeCount} maybe`}{yesCount === 0 && maybeCount === 0 && "No responses yet"}</>
            }
          </span>
          {unread > 0 && (
            <div style={{ position: "relative", display: "inline-flex" }}>
              <span style={{ fontSize: 16 }}>💬</span>
              <Badge count={unread} />
            </div>
          )}
          <span style={{ fontSize: 11, color: "var(--text-subtle)", fontFamily: "'Inter',sans-serif", fontWeight: 600, flexShrink: 0 }}># {gameNum}</span>
        </div>
      </div>
    </div>
  );
}

/* ── ALL GAMES PANEL (shared by Home + Account) ── */
function AllGamesPanel({ groups, guestGames = [], standaloneGames = [], go, user, unreadCounts = {} }) {
  const todayStart = startOfTodayInTz(user?.timezone);
  const memberGames = groups.flatMap((g) =>
    g.games.map((gm) => ({ ...gm, groupName: g.name, groupColor: g.color, groupId: g.id, groupEmoji: g.emoji }))
  );
  const seenKeys = new Set(memberGames.map((gm) => `${gm.groupId || ""}:${gm.id}`));
  const dedupedGuest = guestGames.filter((gm) => !seenKeys.has(`${gm.groupId || ""}:${gm.id}`));
  const dedupedStandalone = standaloneGames.filter((gm) => !seenKeys.has(`:${gm.id}`));
  const allGames = [...memberGames, ...dedupedGuest, ...dedupedStandalone];
  const upcoming = allGames.filter((gm) => gm.status !== "archived" && gm.date >= todayStart).sort((a, b) => a.date !== b.date ? a.date - b.date : (a.time || "").localeCompare(b.time || ""));
  const list = upcoming.slice(0, 3);

  return (
    <div style={{ marginTop: 4 }}>
      <h2 style={{ fontFamily: "'Inter',sans-serif", fontSize: 23, color: "var(--section-title)", letterSpacing: 0.5, marginBottom: 14 }}>Your Upcoming Games</h2>

      {list.length === 0 ? (
        <div style={{ textAlign: "center", padding: "22px 0", color: "#c0a0b0" }}>
          <div style={{ fontSize: 31 }}>📅</div>
          <p style={{ fontSize: 14, marginTop: 8, fontFamily: "'Inter',sans-serif" }}>
            No upcoming games yet — time to schedule one!
          </p>
        </div>
      ) : (
        <>
          {list.map((gm, i) => (
            <GameCard key={`${gm.groupId}-${gm.id}`} gm={gm} groups={groups} user={user} go={go} animDelay={i * 0.05} unreadCounts={unreadCounts} />
          ))}
          {upcoming.length > 3 && (
            <button onClick={() => go("games")} style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: "100%", padding: "12px 16px", cursor: "pointer", marginTop: 2,
              background: "linear-gradient(135deg,rgba(var(--primary-rgb),0.08),rgba(var(--primary-rgb),0.04))",
              border: "1px solid rgba(var(--primary-rgb),0.14)",
              borderRadius: 14,
              boxShadow: "inset 0 1px 0 rgba(255,255,255,0.5)",
            }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: "var(--primary)", fontFamily: "'Inter',sans-serif" }}>
                +{upcoming.length - 3} more upcoming games &nbsp;›
              </span>
            </button>
          )}
        </>
      )}
    </div>
  );
}

/* HOME */
function Home({ groups, guestGames, standaloneGames, go, user, activeTheme, planCfg, flash, onNew, unreadCounts = {} }) {
  const todayStart = startOfTodayInTz(user?.timezone);

  // Background pattern — roses for Flowers, birds for Bam Bird, dragons for Dragons, tiles for all others
  const color = activeTheme?.primary || "#a0456e";
  const isFlowers = activeTheme?.id === "sakura";
  const isBamBird = activeTheme?.id === "forest";
  const isDragons = activeTheme?.id === "jadeDragon";

  // Rose SVG — teardrop petals (5 outer + 5 inner), curved stem, and two leaves.
  // Two roses per 160px tile: main (top-left area) and accent (bottom-right, 68% scale).
  // Petal path: M0,0 symmetric cubic bezier to tip then back — true teardrop shape.
  const roseMotif = (r) => [
    // 5 outer petals at 72° intervals (first pointing up)
    ...[0,72,144,216,288].map(a =>
      `<path d="M0,0 C-7,-5 -3.5,-${r} 0,-${r} C3.5,-${r} 7,-5 0,0Z" transform="rotate(${a})"/>`
    ),
    // 5 inner petals offset 36°, shorter
    ...[36,108,180,252,324].map(a =>
      `<path d="M0,0 C-4.5,-3 -2,-${Math.round(r*0.68)} 0,-${Math.round(r*0.68)} C2,-${Math.round(r*0.68)} 4.5,-3 0,0Z" transform="rotate(${a})"/>`
    ),
    // Centre
    `<circle r="${Math.round(r*0.24)}"/>`,
    // Curved stem
    `<path d="M0,${Math.round(r*0.28)} Q${Math.round(r*0.18)},${Math.round(r*1.1)} ${Math.round(r*0.06)},${Math.round(r*2.3)}" fill="none" stroke="${color}" stroke-width="${(r*0.115).toFixed(1)}" stroke-linecap="round"/>`,
    // Right leaf (upper, pointing up-right from stem)
    `<path d="M${Math.round(r*0.1)},${Math.round(r*0.9)} C${Math.round(r*0.25)},${Math.round(r*0.6)} ${Math.round(r*0.95)},${Math.round(r*0.55)} ${Math.round(r*0.8)},${Math.round(r*0.78)} C${Math.round(r*0.55)},${Math.round(r*0.95)} ${Math.round(r*0.15)},${Math.round(r*0.96)} ${Math.round(r*0.1)},${Math.round(r*0.9)}Z"/>`,
    // Left leaf (lower, pointing down-left from stem)
    `<path d="M${Math.round(r*0.12)},${Math.round(r*1.46)} C-${Math.round(r*0.1)},${Math.round(r*1.16)} -${Math.round(r*0.92)},${Math.round(r*1.14)} -${Math.round(r*0.76)},${Math.round(r*1.38)} C-${Math.round(r*0.5)},${Math.round(r*1.54)} ${Math.round(r*0.08)},${Math.round(r*1.54)} ${Math.round(r*0.12)},${Math.round(r*1.46)}Z"/>`,
  ].join("");

  const flowerSvg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160">`,
    `<g opacity="0.13" fill="${color}">`,
    // Main rose — head at (48, 34), petal radius 19
    `<g transform="translate(48,34)">${roseMotif(19)}</g>`,
    // Accent rose — head at (118, 112), scaled 68%
    `<g transform="translate(118,112) scale(0.68)">${roseMotif(19)}</g>`,
    `</g></svg>`,
  ].join("");
  const flowerSVG = `url("data:image/svg+xml,${encodeURIComponent(flowerSvg)}")`;

  // Bird silhouette — each motif has 6 clearly connected parts:
  //   body (ellipse), head (circle that overlaps body's front-top), beak (triangle
  //   extending from head), raised wing (crescent arch above body), and two spread
  //   tail feathers (wedges off the body's rear). Bird faces right by default;
  //   flipX mirrors it left. bounding box at scale 1: ~56px wide × 32px tall.
  const birdMotif = (tx, ty, s, flipX = false) => {
    const sx = (flipX ? -s : s).toFixed(3);
    return [
      `<g transform="translate(${tx},${ty}) scale(${sx},${s})">`,
      // Body — pear-shaped oval, body center at (0,2)
      `<ellipse cx="0" cy="2" rx="16" ry="8"/>`,
      // Head — circle overlapping the front-top of body
      `<circle cx="14" cy="-7" r="8"/>`,
      // Beak — triangle extending from front of head, pointing forward (right)
      `<path d="M22,-9 L30,-7 L22,-5Z"/>`,
      // Wing — crescent arch raised well above body
      `<path d="M-8,-5 C-4,-18 8,-18 10,-6 C5,-10 0,-10 -8,-5Z"/>`,
      // Upper tail feather — wedge fanning back and up from body rear
      `<path d="M-14,0 C-20,-6 -26,-4 -24,2 C-20,2 -18,0 -14,4Z"/>`,
      // Lower tail feather — wedge fanning back and down from body rear
      `<path d="M-14,4 C-20,4 -26,8 -24,14 C-20,12 -16,8 -14,4Z"/>`,
      `</g>`,
    ].join("");
  };

  const birdSvg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180">`,
    `<g opacity="0.11" fill="${color}">`,
    birdMotif(65,  68,  1.00, false),  // main bird,  facing right, upper-left
    birdMotif(130, 34,  0.68, true),   // medium bird, facing left,  upper-right
    birdMotif(34,  148, 0.52, false),  // small bird,  facing right, lower-left
    `</g></svg>`,
  ].join("");
  const birdSVG = `url("data:image/svg+xml,${encodeURIComponent(birdSvg)}")`;

  // Mahjong tile SVG pattern — used by all themes except Flowers and Bam Bird
  const tileColor = encodeURIComponent(color);
  const tileSVG = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Crect width='120' height='120' fill='none'/%3E%3Cg opacity='0.07' fill='${tileColor}'%3E%3Crect x='10' y='10' width='28' height='38' rx='5' fill='none' stroke='${tileColor}' stroke-width='2'/%3E%3Crect x='14' y='16' width='20' height='4' rx='2'/%3E%3Crect x='14' y='23' width='20' height='4' rx='2'/%3E%3Crect x='14' y='30' width='20' height='4' rx='2'/%3E%3Crect x='64' y='10' width='28' height='38' rx='5' fill='none' stroke='${tileColor}' stroke-width='2'/%3E%3Ccircle cx='78' cy='24' r='5' fill='none' stroke='${tileColor}' stroke-width='2'/%3E%3Ccircle cx='78' cy='37' r='3'/%3E%3Crect x='10' y='68' width='28' height='38' rx='5' fill='none' stroke='${tileColor}' stroke-width='2'/%3E%3Cpath d='M18 78 Q24 72 30 78 Q24 84 18 78Z'/%3E%3Cpath d='M18 90 Q24 84 30 90 Q24 96 18 90Z'/%3E%3Crect x='64' y='68' width='28' height='38' rx='5' fill='none' stroke='${tileColor}' stroke-width='2'/%3E%3Crect x='70' y='75' width='16' height='18' rx='3' fill='none' stroke='${tileColor}' stroke-width='1.5'/%3E%3Cline x1='78' y1='75' x2='78' y2='93' stroke='${tileColor}' stroke-width='1.5'/%3E%3C/g%3E%3C/svg%3E")`;

  const bgSVG = isFlowers ? flowerSVG : isBamBird ? birdSVG : isDragons ? null : tileSVG;

  const BT = ["🀄","🀇","🀅","🀙","🀃","🀆"];
  const pos = [
    { top: "8%", left: "4%", a: "f0" }, { top: "10%", right: "6%", a: "f1" },
    { top: "32%", left: "1%", a: "f2" }, { top: "30%", right: "2%", a: "f0" },
    { top: "50%", left: "6%", a: "f1" }, { top: "48%", right: "5%", a: "f2" },
  ];

  return (
    <div style={{ minHeight: "100%", background: bgSVG ? `${bgSVG}, linear-gradient(170deg,var(--bg-shell-start) 0%,var(--bg-shell-mid) 40%,var(--bg-shell-end) 100%)` : `linear-gradient(170deg,var(--bg-shell-start) 0%,var(--bg-shell-mid) 40%,var(--bg-shell-end) 100%)`, backgroundSize: bgSVG ? `${isFlowers ? "160px 160px" : isBamBird ? "180px 180px" : "120px 120px"}, cover` : "cover" }}>
      {/* Hero header — glassy */}
      <div style={{
        background: "var(--header-gradient2)",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
        padding: `${HEADER_BTN_TOP}px 24px 28px`,
        position: "relative",
        overflow: "hidden",
        boxShadow: "0 8px 32px rgba(var(--shadow-rgb),0.25)",
      }}>
        {/* Frosted shimmer overlay */}
        <div style={{ position: "absolute", inset: 0, background: "linear-gradient(135deg,rgba(255,255,255,0.12) 0%,transparent 60%)", pointerEvents: "none" }} />
        {pos.map((p, i) => (
          <div key={i} style={{ position: "absolute", fontSize: 23, opacity: .15, pointerEvents: "none", top: p.top, left: p.left, right: p.right, animation: `${p.a} ${2.4 + i * 0.35}s ${i * 0.4}s ease-in-out infinite`, filter: "blur(0.5px)" }}>{BT[i]}</div>
        ))}
        <div style={{ textAlign: "center", position: "relative", display: "flex", alignItems: "center", justifyContent: "center", gap: 12 }}>
          <div style={{ fontSize: 39, filter: "drop-shadow(0 4px 10px rgba(0,0,0,.25))" }}>🀄</div>
          <div>
            <h1 style={{ fontFamily: "'Shippori Mincho',serif", fontSize: 31, color: "#fff", textShadow: "0 2px 12px rgba(0,0,0,.25)", letterSpacing: 2, lineHeight: 1.1 }}>Mahjong Club</h1>
            <p style={{ color: "rgba(255,255,255,.78)", fontWeight: 400, fontSize: 13, marginTop: 3, fontFamily: "'Inter',sans-serif", letterSpacing: 1 }}>Schedule · Play · Enjoy</p>
          </div>
        </div>
      </div>

      {/* Content panel */}
      <div style={{
        borderRadius: "28px 28px 0 0",
        marginTop: -18,
        padding: "26px 16px 40px",
        minHeight: "68vh",
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <h2 style={{ fontFamily: "'Inter',sans-serif", fontSize: 23, color: "var(--section-title)", letterSpacing: 0.5 }}>Your Groups</h2>
          <div style={{ display: "flex", gap: 8 }}>
            <Btn sm outline onClick={() => go("joinGroup")}>Join</Btn>
            <Btn sm onClick={onNew}>+ New</Btn>
          </div>
        </div>

        {groups.filter(g => g.status !== "archived").length === 0 ? (
          <div style={{ textAlign: "center", padding: "44px 0", color: "var(--primary-subtle)" }}>
            <div style={{ fontSize: 49 }}>🀆</div>
            <p style={{ fontWeight: 700, marginTop: 10, fontSize: 17, fontFamily: "'Inter',sans-serif", color: "var(--primary-muted)" }}>No groups yet</p>
            <p style={{ fontSize: 14, marginTop: 4 }}>Create or join one to get started!</p>
          </div>
        ) : (
          <>
            {groups.filter(g => g.status !== "archived").slice(0, 3).map((g, i) => (
              <div key={g.id} className="sUp" style={{ animationDelay: `${i * 0.07}s`, cursor: "pointer" }} onClick={() => go("group", g.id)}>
                <div style={{
                  background: "linear-gradient(135deg,var(--bg-card-base) 0%,var(--bg-card-alt) 100%)",
                  backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)",
                  borderRadius: 20, padding: "15px 16px", marginBottom: 13,
                  display: "flex", alignItems: "center", gap: 13,
                  boxShadow: "0 4px 20px rgba(var(--shadow-rgb),0.10), inset 0 1px 0 var(--shadow-inset)",
                  border: "1px solid var(--border-card)", borderLeft: `4px solid ${g.color}`,
                }}>
                  <div style={{ position: "relative", width: 50, height: 50, borderRadius: 15, flexShrink: 0, background: `linear-gradient(135deg,${g.color}33,${g.color}18)`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 27, boxShadow: "inset 0 1px 0 var(--border-card)" }}>
                    {g.emoji}
                    <Badge count={unreadCounts[g.id]} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700, fontSize: 17, color: "var(--text-body)", fontFamily: "'Inter',sans-serif" }}>{g.name}</div>
                    <div style={{ fontSize: 13, color: "#b08090", marginTop: 2 }}>{g.members.length} members</div>
                  </div>
                  {g.games.filter((gm) => gm.status !== "archived" && gm.date >= todayStart).length > 0 && (
                    <div style={{ background: `linear-gradient(135deg,${g.color},${g.color}cc)`, color: "#fff", borderRadius: 999, width: 26, height: 26, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 900, boxShadow: `0 2px 8px ${g.color}55` }}>{g.games.filter((gm) => gm.status !== "archived" && gm.date >= todayStart).length}</div>
                  )}
                  <span style={{ color: "var(--primary-faint)", fontSize: 21 }}>›</span>
                </div>
              </div>
            ))}
            {groups.filter(g => g.status !== "archived").length > 3 && (
              <button onClick={() => go("groups")} style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                width: "100%", padding: "12px 16px", cursor: "pointer", marginBottom: 16,
                background: "linear-gradient(135deg,rgba(var(--primary-rgb),0.08),rgba(var(--primary-rgb),0.04))",
                border: "1px solid rgba(var(--primary-rgb),0.14)",
                borderRadius: 14,
                boxShadow: "inset 0 1px 0 rgba(255,255,255,0.5)",
              }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: "var(--primary)", fontFamily: "'Inter',sans-serif" }}>
                  +{groups.filter(g => g.status !== "archived").length - 3} more groups &nbsp;›
                </span>
              </button>
            )}

            {/* All-groups games tabs */}
            <AllGamesPanel groups={groups} guestGames={guestGames} standaloneGames={standaloneGames} go={go} user={user} unreadCounts={unreadCounts} />
          </>
        )}
      </div>
    </div>
  );
}

/* GAMES PAGE */
function GamesPage({ groups, guestGames = [], standaloneGames = [], go, user, unreadCounts = {} }) {
  const [tab, setTab] = useState("upcoming");
  const [menuOpen, setMenuOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const gamesMenuBtnRef = useRef(null);
  const [gamesMenuRect, setGamesMenuRect] = useState(null);

  const todayStart = startOfTodayInTz(user?.timezone);
  const memberGames = groups.flatMap((g) =>
    g.games.map((gm) => ({ ...gm, groupName: g.name, groupColor: g.color, groupId: g.id, groupEmoji: g.emoji }))
  );
  const seenGameKeys = new Set(memberGames.map((gm) => `${gm.groupId || ""}:${gm.id}`));
  const dedupedGuestGames = guestGames.filter((gm) => !seenGameKeys.has(`${gm.groupId || ""}:${gm.id}`));
  const dedupedStandaloneGames = standaloneGames.filter((gm) => !seenGameKeys.has(`:${gm.id}`));
  const allGames = [...memberGames, ...dedupedGuestGames, ...dedupedStandaloneGames];
  const upcoming = allGames.filter((gm) => gm.status !== "archived" && gm.date >= todayStart).sort((a, b) => a.date !== b.date ? a.date - b.date : (a.time || "").localeCompare(b.time || ""));
  const completed = allGames.filter((gm) => gm.status !== "archived" && gm.date < todayStart).sort((a, b) => a.date !== b.date ? b.date - a.date : (b.time || "").localeCompare(a.time || ""));
  const archived = allGames.filter((gm) => gm.status === "archived").sort((a, b) => b.date - a.date);
  const list = tab === "upcoming" ? upcoming : tab === "completed" ? completed : archived;

  // Header week indicator
  const _now = new Date();
  const currentMonthName = _now.toLocaleDateString("en-US", { month: "long" }).toUpperCase();
  const currentWeekNum = (() => {
    const d = new Date(Date.UTC(_now.getFullYear(), _now.getMonth(), _now.getDate()));
    const day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - day);
    const y0 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil(((d - y0) / 86400000 + 1) / 7);
  })();

  return (
    <div style={{ minHeight: "100%", background: "linear-gradient(170deg,var(--bg-shell-start) 0%,var(--bg-shell-mid) 40%,var(--bg-shell-end) 100%)" }}>

      {/* ── Header ── */}
      <div style={{ background: "var(--header-gradient2)", position: "relative", overflow: "hidden" }}>
        {/* Decorative tile glyphs */}
        <div style={{ position: "absolute", inset: 0, pointerEvents: "none", overflow: "hidden" }}>
          {["🀄","🀇","🀙","🀅","🀃"].map((t, i) => (
            <span key={i} style={{
              position: "absolute", fontSize: [42,30,38,28,44][i], opacity: [0.08,0.05,0.07,0.05,0.06][i],
              top: ["14%","62%","8%","72%","40%"][i], left: ["10%","70%","55%","15%","85%"][i],
              transform: `rotate(${[-10,20,-6,18,-14][i]}deg)`, userSelect: "none",
            }}>{t}</span>
          ))}
          <div style={{ position: "absolute", inset: 0, background: "linear-gradient(135deg,rgba(255,255,255,0.10) 0%,transparent 60%)", pointerEvents: "none" }} />
        </div>

        <div style={{
          position: "relative",
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: `${HEADER_BTN_TOP}px 20px 20px`, gap: 12,
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "rgba(255,255,255,0.65)", letterSpacing: 2, fontFamily: "'Inter',sans-serif", marginBottom: 5 }}>
              {currentMonthName} · WEEK {currentWeekNum}
            </div>
            <h1 style={{
              fontFamily: "'Shippori Mincho',serif", fontSize: 31, fontWeight: 700,
              color: "#fff", textShadow: "0 2px 12px rgba(0,0,0,0.25)",
              margin: 0, lineHeight: 1.1, letterSpacing: 2,
            }}>Your Games</h1>
          </div>

          <div ref={gamesMenuBtnRef} style={{ position: "relative", flexShrink: 0 }}>
            <button onClick={() => {
              if (gamesMenuBtnRef.current) setGamesMenuRect(gamesMenuBtnRef.current.getBoundingClientRect());
              setMenuOpen(o => !o); setInviteOpen(false);
            }} style={{
              background: "rgba(255,255,255,0.2)", border: "1.5px solid rgba(255,255,255,0.55)",
              borderRadius: 999, width: 36, height: 36, display: "flex", alignItems: "center", justifyContent: "center",
              cursor: "pointer", fontSize: 20, color: "#fff", lineHeight: 1,
            }}>⋮</button>
            {menuOpen && gamesMenuRect && (
              <>
                <div onClick={() => { setMenuOpen(false); setInviteOpen(false); }} style={{ position: "fixed", inset: 0, zIndex: 999 }} />
                <div style={{
                  position: "fixed",
                  top: gamesMenuRect.bottom + 6,
                  right: window.innerWidth - gamesMenuRect.right,
                  zIndex: 1000,
                  background: "var(--bg-card-base)", borderRadius: 16,
                  boxShadow: "0 8px 32px rgba(0,0,0,0.18)", border: "1px solid var(--border-card)",
                  minWidth: 220, overflow: "hidden",
                }}>
                  {[
                    { icon: "📅", label: "Schedule new game", action: () => { setMenuOpen(false); go("newChoice"); } },
                    { icon: "🔑", label: "Join with code",     action: () => { setMenuOpen(false); go("joinGroup"); } },
                  ].map(({ icon, label, action }) => (
                    <button key={label} onClick={action} style={{
                      display: "flex", alignItems: "center", gap: 12, width: "100%",
                      padding: "14px 16px", background: "none", border: "none",
                      borderBottom: "1px solid var(--border-card)", cursor: "pointer",
                      fontFamily: "'Inter',sans-serif", fontSize: 14, fontWeight: 600,
                      color: "var(--text-body)", textAlign: "left",
                    }}>
                      <span style={{ fontSize: 18 }}>{icon}</span>{label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* ── Tab pills ── */}
      <div style={{ display: "flex", gap: 8, padding: "18px 16px 0", overflowX: "auto", WebkitOverflowScrolling: "touch", scrollbarWidth: "none", marginBottom: 0 }}>
        {[["upcoming","Upcoming"],["completed","Completed"],["archived","Archived"]].map(([t, label]) => (
          <button key={t} onClick={() => setTab(t)} style={{
            padding: "7px 18px", borderRadius: 999, fontSize: 13, fontWeight: 700,
            fontFamily: "'Inter',sans-serif", cursor: "pointer", border: "none",
            background: tab === t ? "var(--active-tab-gradient)" : "var(--bg-surface)",
            color: tab === t ? "#fff" : "var(--text-muted)",
            boxShadow: tab === t ? "0 2px 10px var(--shadow-btn)" : "none",
            transition: "all .15s", flexShrink: 0, whiteSpace: "nowrap",
          }}>
            {label}
            {t === "upcoming" && upcoming.length > 0 ? ` (${upcoming.length})` : ""}
            {t === "completed" && completed.length > 0 ? ` (${completed.length})` : ""}
            {t === "archived" && archived.length > 0 ? ` (${archived.length})` : ""}
          </button>
        ))}
      </div>
      {tab === "archived" && (
        <div style={{ margin: "12px 16px 0", padding: "10px 14px", borderRadius: 12, background: "rgba(156,163,175,0.10)", border: "1px dashed rgba(156,163,175,0.30)", display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 15 }}>📦</span>
          <span style={{ fontSize: 12, color: "var(--text-muted)", fontFamily: "'Inter',sans-serif" }}>Archived games auto-delete after 60 days and don't count toward your plan.</span>
        </div>
      )}

      {/* ── Game list ── */}
      <div style={{ padding: "16px 16px 24px" }}>
        {list.length === 0 ? (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "52px 24px", textAlign: "center" }}>
            <div style={{ fontSize: 48, marginBottom: 16, opacity: 0.4 }}>{tab === "upcoming" ? "📅" : tab === "completed" ? "✅" : "📦"}</div>
            <h2 style={{ fontFamily: "'Inter',sans-serif", fontSize: 20, color: "var(--primary-muted)", marginBottom: 8 }}>
              {tab === "upcoming" ? "No upcoming games" : tab === "completed" ? "No completed games yet" : "No archived games"}
            </h2>
            <p style={{ fontSize: 14, color: "var(--text-muted)", lineHeight: 1.6, maxWidth: 260 }}>
              {tab === "upcoming" ? "Head to a group and schedule your next session." : tab === "completed" ? "Completed games will appear here." : "Archived games will appear here."}
            </p>
          </div>
        ) : tab === "upcoming" ? (() => {
          // Section grouping: THIS WEEK / NEXT WEEK / IN [MONTH]
          const todayDate = new Date(todayStart);
          const dow = todayDate.getDay();
          const thisMon = todayStart - (dow === 0 ? 6 : dow - 1) * 86400000;
          const nextMon = thisMon + 7 * 86400000;
          const weekAfter = nextMon + 7 * 86400000;

          const sections = [];
          const thisWeek = upcoming.filter(gm => gm.date < nextMon);
          const nextWeek = upcoming.filter(gm => gm.date >= nextMon && gm.date < weekAfter);
          const later = upcoming.filter(gm => gm.date >= weekAfter);
          if (thisWeek.length) sections.push({ label: "THIS WEEK", games: thisWeek });
          if (nextWeek.length) sections.push({ label: "NEXT WEEK", games: nextWeek });
          const laterMonths = {};
          later.forEach(gm => {
            const d = new Date(gm.date);
            const key = d.toLocaleDateString("en-US", { month: "long" }).toUpperCase();
            const sk = d.getFullYear() * 100 + d.getMonth();
            if (!laterMonths[key]) laterMonths[key] = { sk, games: [] };
            laterMonths[key].games.push(gm);
          });
          Object.entries(laterMonths).sort((a,b) => a[1].sk - b[1].sk).forEach(([month, {games}]) => {
            sections.push({ label: "IN " + month, games });
          });

          let gIdx = 0;
          return sections.map(({ label, games: sGames }) => (
            <div key={label}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", letterSpacing: 1.5, fontFamily: "'Inter',sans-serif", marginBottom: 10, marginTop: gIdx === 0 ? 0 : 18, paddingLeft: 2 }}>
                {label}
              </div>
              {sGames.map(gm => {
                const idx = gIdx++;
                return <GameCard key={`${gm.groupId}-${gm.id}`} gm={gm} groups={groups} user={user} go={go} animDelay={idx * 0.04} unreadCounts={unreadCounts} />;
              })}
            </div>
          ));
        })() : tab === "completed" ? (() => {
          const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];
          const monthMap = {};
          completed.forEach(gm => {
            const d = new Date(gm.date);
            const key = MONTH_NAMES[d.getMonth()].toUpperCase() + " " + d.getFullYear();
            const sortKey = d.getFullYear() * 100 + d.getMonth();
            if (!monthMap[key]) monthMap[key] = { sortKey, games: [] };
            monthMap[key].games.push(gm);
          });
          const monthGroups = Object.entries(monthMap).sort((a, b) => b[1].sortKey - a[1].sortKey);
          let cardIndex = 0;
          return monthGroups.map(([monthLabel, { games: mGames }]) => (
            <div key={monthLabel}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", letterSpacing: 1.5, fontFamily: "'Inter',sans-serif", marginBottom: 10, marginTop: cardIndex === 0 ? 0 : 18, paddingLeft: 2 }}>
                {monthLabel}
              </div>
              {mGames.map((gm) => <GameCard key={`${gm.groupId}-${gm.id}`} gm={gm} groups={groups} user={user} go={go} animDelay={(cardIndex++) * 0.04} unreadCounts={unreadCounts} />)}
            </div>
          ));
        })() : (
          /* Archived tab */
          list.map((gm, i) => <GameCard key={`${gm.groupId}-${gm.id}`} gm={gm} groups={groups} user={user} go={go} animDelay={i * 0.04} unreadCounts={unreadCounts} />)
        )}
      </div>
    </div>
  );
}

/* GROUPS PAGE */
function GroupsPage({ groups, go, user, planCfg, flash, onNew, unreadCounts = {} }) {
  const [groupFilter, setGroupFilter] = useState("active");
  const [menuOpen, setMenuOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const groupsMenuBtnRef = useRef(null);
  const [groupsMenuRect, setGroupsMenuRect] = useState(null);
  const todayStart = startOfTodayInTz(user?.timezone);
  const activeGroups = groups.filter(g => g.status !== "archived");
  const archivedGroups = groups.filter(g => g.status === "archived");
  const displayGroups = groupFilter === "active" ? activeGroups : archivedGroups;
  const totalUpcoming = activeGroups.reduce((sum, g) => sum + g.games.filter((gm) => gm.date >= todayStart && gm.status !== "archived").length, 0);

  return (
    <div style={{ minHeight: "100%", background: "linear-gradient(170deg,var(--bg-shell-start) 0%,var(--bg-shell-mid) 40%,var(--bg-shell-end) 100%)" }}>

      {/* ── Header ── */}
      <div style={{ background: "var(--header-gradient2)", position: "relative", overflow: "hidden" }}>
        {/* Decorative tile glyphs */}
        <div style={{ position: "absolute", inset: 0, pointerEvents: "none", overflow: "hidden" }}>
          {["🀇","🀙","🀀","🀄","🀅"].map((t, i) => (
            <span key={i} style={{
              position: "absolute", fontSize: [38,28,44,32,36][i], opacity: [0.07,0.05,0.09,0.06,0.05][i],
              top: ["18%","60%","10%","70%","38%"][i], left: ["8%","72%","58%","18%","88%"][i],
              transform: [`rotate(${[-12,18,-8,22,-15][i]}deg)`],
              userSelect: "none",
            }}>{t}</span>
          ))}
          <div style={{ position: "absolute", inset: 0, background: "linear-gradient(135deg,rgba(255,255,255,0.10) 0%,transparent 60%)", pointerEvents: "none" }} />
        </div>

        <div style={{
          position: "relative",
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: `${HEADER_BTN_TOP}px 20px 20px`, gap: 12,
        }}>
          <h1 style={{
            fontFamily: "'Shippori Mincho',serif", fontSize: 31, fontWeight: 700,
            color: "#fff", textShadow: "0 2px 12px rgba(0,0,0,0.25)",
            margin: 0, lineHeight: 1.1, letterSpacing: 2,
          }}>Your Groups</h1>

          <div ref={groupsMenuBtnRef} style={{ position: "relative", flexShrink: 0 }}>
            <button onClick={() => {
              if (groupsMenuBtnRef.current) setGroupsMenuRect(groupsMenuBtnRef.current.getBoundingClientRect());
              setMenuOpen(o => !o); setInviteOpen(false);
            }} style={{
              background: "rgba(255,255,255,0.2)", border: "1.5px solid rgba(255,255,255,0.55)",
              borderRadius: 999, width: 36, height: 36, display: "flex", alignItems: "center", justifyContent: "center",
              cursor: "pointer", fontSize: 20, color: "#fff", lineHeight: 1,
            }}>⋮</button>
            {menuOpen && groupsMenuRect && (
              <>
                <div onClick={() => { setMenuOpen(false); setInviteOpen(false); }} style={{ position: "fixed", inset: 0, zIndex: 999 }} />
                <div style={{
                  position: "fixed",
                  top: groupsMenuRect.bottom + 6,
                  right: window.innerWidth - groupsMenuRect.right,
                  zIndex: 1000,
                  background: "var(--bg-card-base)", borderRadius: 16,
                  boxShadow: "0 8px 32px rgba(0,0,0,0.18)", border: "1px solid var(--border-card)",
                  minWidth: 220, overflow: "hidden",
                }}>
                  {[
                    { icon: "👥", label: "Create new group", action: () => { setMenuOpen(false); onNew(); } },
                    { icon: "🔑", label: "Join with code",   action: () => { setMenuOpen(false); go("joinGroup"); } },
                  ].map(({ icon, label, action }) => (
                    <button key={label} onClick={action} style={{
                      display: "flex", alignItems: "center", gap: 12, width: "100%",
                      padding: "14px 16px", background: "none", border: "none",
                      borderBottom: "1px solid var(--border-card)", cursor: "pointer",
                      fontFamily: "'Inter',sans-serif", fontSize: 14, fontWeight: 600,
                      color: "var(--text-body)", textAlign: "left",
                    }}>
                      <span style={{ fontSize: 18 }}>{icon}</span>{label}
                    </button>
                  ))}
                  <button onClick={() => setInviteOpen(o => !o)} style={{
                    display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%",
                    padding: "14px 16px", background: "none", border: "none", cursor: "pointer",
                    fontFamily: "'Inter',sans-serif", fontSize: 14, fontWeight: 600,
                    color: "var(--text-body)", textAlign: "left",
                    borderBottom: inviteOpen ? "1px solid var(--border-card)" : "none",
                  }}>
                    <span style={{ display: "flex", alignItems: "center", gap: 12 }}><span style={{ fontSize: 18 }}>✉️</span>Invite a friend</span>
                    <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{inviteOpen ? "▲" : "▼"}</span>
                  </button>
                  {inviteOpen && (() => {
                    const appUrl = APP_PUBLIC_URL;
                    const txt = `Join me on Mahjong Club!\n\n${appUrl}`;
                    const share = (method) => {
                      if (method === "sms") window.open(`sms:?body=${encodeURIComponent(txt)}`);
                      else if (method === "email") window.open(`mailto:?subject=${encodeURIComponent("Join me on Mahjong Club!")}&body=${encodeURIComponent(txt)}`);
                      else if (method === "copy") navigator.clipboard.writeText(appUrl).catch(() => {});
                      else if (method === "share") { if (navigator.share) navigator.share({ title: "Mahjong Club", url: appUrl }).catch(() => {}); else navigator.clipboard.writeText(appUrl).catch(() => {}); }
                    };
                    return [
                      { icon: "💬", label: "Text Message", method: "sms" },
                      { icon: "🔗", label: "Copy link",    method: "copy" },
                      { icon: "📤", label: "Share…",       method: "share" },
                    ].map(({ icon, label, method }) => (
                      <button key={method} onClick={() => { share(method); setMenuOpen(false); setInviteOpen(false); }} style={{
                        display: "flex", alignItems: "center", gap: 12, width: "100%",
                        padding: "12px 16px 12px 44px", background: "rgba(var(--primary-rgb),0.04)",
                        border: "none", borderBottom: "1px solid var(--border-card)", cursor: "pointer",
                        fontFamily: "'Inter',sans-serif", fontSize: 13, fontWeight: 500,
                        color: "var(--text-body)", textAlign: "left",
                      }}>
                        <span style={{ fontSize: 16 }}>{icon}</span>{label}
                      </button>
                    ));
                  })()}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* ── Active / Archived filter pills ── */}
      <div style={{ display: "flex", gap: 8, padding: "14px 16px 0" }}>
        {[["active","Active"],["archived","Archived"]].map(([val, label]) => (
          <button key={val} onClick={() => setGroupFilter(val)} style={{
            padding: "7px 18px", borderRadius: 999, fontSize: 13, fontWeight: 700,
            fontFamily: "'Inter',sans-serif", cursor: "pointer", border: "none",
            background: groupFilter === val ? "var(--active-tab-gradient)" : "var(--bg-surface)",
            color: groupFilter === val ? "#fff" : "var(--text-muted)",
            boxShadow: groupFilter === val ? "0 2px 10px var(--shadow-btn)" : "none",
            transition: "all .15s",
          }}>{label}{val === "archived" && archivedGroups.length > 0 ? ` (${archivedGroups.length})` : ""}</button>
        ))}
      </div>
      {groupFilter === "archived" && (
        <div style={{ margin: "12px 16px 0", padding: "10px 14px", borderRadius: 12, background: "rgba(156,163,175,0.10)", border: "1px dashed rgba(156,163,175,0.30)", display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 15 }}>📦</span>
          <span style={{ fontSize: 12, color: "var(--text-muted)", fontFamily: "'Inter',sans-serif" }}>Archived groups auto-delete after 60 days and don't count toward your plan.</span>
        </div>
      )}

      {/* ── List ── */}
      <div style={{ padding: "18px 16px 24px" }}>
        {groupFilter === "active" && activeGroups.length === 0 ? (
          /* ── Empty state (active) ── */
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "52px 24px 24px", textAlign: "center" }}>
            <div style={{ display: "flex", gap: 10, marginBottom: 24 }}>
              {["🀇","🀙","🀅"].map((t, i) => (
                <div key={i} className="sUp" style={{ animationDelay: `${i * 0.12}s`, fontSize: 44, opacity: 0.35,
                  background: "linear-gradient(135deg,var(--bg-card-base),var(--bg-card-alt))",
                  borderRadius: 14, width: 68, height: 68, display: "flex", alignItems: "center",
                  justifyContent: "center", boxShadow: "0 4px 16px rgba(var(--shadow-rgb),0.10)",
                  border: "1px solid var(--border-card)",
                }}>{t}</div>
              ))}
            </div>
            <h2 style={{ fontFamily: "'Inter',sans-serif", fontSize: 22, color: "var(--primary-muted)", marginBottom: 8 }}>Your table awaits</h2>
            <p style={{ fontSize: 14, color: "var(--text-muted)", lineHeight: 1.6, marginBottom: 28, maxWidth: 260 }}>
              Create a group to start scheduling games and inviting your players.
            </p>
            <div style={{ display: "flex", gap: 10, width: "100%" }}>
              <button onClick={onNew} style={{
                flex: 1, padding: "14px 0", borderRadius: 999, fontSize: 15, fontWeight: 700,
                fontFamily: "'Inter',sans-serif", cursor: "pointer",
                background: "var(--active-tab-gradient)", color: "#fff",
                border: "none", boxShadow: "0 4px 16px var(--shadow-btn)",
              }}>＋ Create</button>
              <button onClick={() => go("joinGroup")} style={{
                flex: 1, padding: "14px 0", borderRadius: 999, fontSize: 15, fontWeight: 700,
                fontFamily: "'Inter',sans-serif", cursor: "pointer",
                background: "var(--bg-surface)", color: "var(--primary)",
                border: "1.5px solid rgba(var(--primary-rgb),0.25)",
              }}>Join Group</button>
            </div>
          </div>
        ) : groupFilter === "archived" && archivedGroups.length === 0 ? (
          /* ── Empty state (archived) ── */
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "52px 24px 24px", textAlign: "center" }}>
            <div style={{ fontSize: 48, marginBottom: 16, opacity: 0.4 }}>📦</div>
            <h2 style={{ fontFamily: "'Inter',sans-serif", fontSize: 20, color: "var(--primary-muted)", marginBottom: 8 }}>No archived groups</h2>
            <p style={{ fontSize: 14, color: "var(--text-muted)", lineHeight: 1.6, maxWidth: 260 }}>
              Archived groups will appear here. They don't count toward your plan limits.
            </p>
          </div>
        ) : (
          displayGroups.map((g, i) => {
            const upcoming = g.games.filter((gm) => gm.date >= todayStart && gm.status !== "archived").sort((a, b) => a.date - b.date);
            const nextGame = upcoming[0] || null;
            const isHost = g.members.some((m) => m.id === undefined ? false : m.host);
            const isArchived = g.status === "archived";
            return (
              <div key={g.id} className="sUp" style={{ animationDelay: `${i * 0.07}s`, cursor: "pointer", marginBottom: 14, opacity: isArchived ? 0.75 : 1 }}
                onClick={() => go("group", g.id)}>
                <div style={{
                  background: "linear-gradient(135deg,var(--bg-card-base) 0%,var(--bg-card-alt) 100%)",
                  backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)",
                  borderRadius: 20, padding: "17px 16px",
                  boxShadow: `0 4px 22px rgba(var(--shadow-rgb),0.09), inset 0 1px 0 var(--shadow-inset)`,
                  border: "1px solid var(--border-card)",
                  borderLeft: `4px solid ${isArchived ? "#9ca3af" : g.color}`,
                }}>
                  {/* Row 1: emoji + name + badge + chevron */}
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <div style={{
                      position: "relative",
                      width: 52, height: 52, borderRadius: 15, flexShrink: 0,
                      background: `linear-gradient(135deg,${g.color}30,${g.color}14)`,
                      display: "flex", alignItems: "center", justifyContent: "center",
                      fontSize: 27, boxShadow: `inset 0 1px 0 rgba(255,255,255,0.6), 0 2px 10px ${g.color}28`,
                      border: `1.5px solid ${g.color}22`,
                    }}>
                      {g.emoji}
                      <Badge count={unreadCounts[g.id]} />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: 18, color: "var(--text-body)", fontFamily: "'Inter',sans-serif", lineHeight: 1.2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{g.name}</div>
                      <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 3, fontFamily: "'Inter',sans-serif" }}>
                        {g.members.length} {g.members.length === 1 ? "member" : "members"}
                      </div>
                    </div>
                    {isArchived ? (
                      <div style={{
                        background: "rgba(156,163,175,0.15)", color: "#6b7280",
                        borderRadius: 999, padding: "3px 10px", fontSize: 11, fontWeight: 700,
                        fontFamily: "'Inter',sans-serif", flexShrink: 0,
                      }}>📦 Archived</div>
                    ) : upcoming.length > 0 && (
                      <div style={{
                        background: `linear-gradient(135deg,${g.color},${g.color}cc)`,
                        color: "#fff", borderRadius: 999, minWidth: 26, height: 26,
                        display: "flex", alignItems: "center", justifyContent: "center",
                        fontSize: 12, fontWeight: 900, padding: "0 8px",
                        boxShadow: `0 2px 8px ${g.color}55`, flexShrink: 0,
                      }}>{upcoming.length}</div>
                    )}
                    <span style={{ color: "var(--primary-faint)", fontSize: 22, flexShrink: 0 }}>›</span>
                  </div>

                  {/* Row 2: member avatar stack */}
                  <div style={{ display: "flex", alignItems: "center", marginTop: 13, gap: 0 }}>
                    {g.members.slice(0, 6).map((m, idx) => (
                      <div key={m.id || idx} style={{
                        width: 28, height: 28, borderRadius: 999,
                        background: avatarBg(m.avatar),
                        border: "2.5px solid var(--bg-card-base)",
                        display: "flex", alignItems: "center", justifyContent: "center",
                        overflow: "hidden", marginLeft: idx > 0 ? -9 : 0,
                        position: "relative", zIndex: 10 - idx,
                        boxShadow: "0 1px 4px rgba(var(--shadow-rgb),0.12)",
                      }}><AvatarImg av={m.avatar} size={28}/></div>
                    ))}
                    {g.members.length > 6 && (
                      <div style={{
                        width: 28, height: 28, borderRadius: 999,
                        background: `${g.color}22`,
                        border: `2.5px solid var(--bg-card-base)`,
                        display: "flex", alignItems: "center", justifyContent: "center",
                        fontSize: 10, fontWeight: 800, color: g.color,
                        marginLeft: -9, position: "relative", zIndex: 3,
                      }}>+{g.members.length - 6}</div>
                    )}
                  </div>

                  {/* Row 3: next game preview */}
                  {!isArchived && nextGame ? (
                    <div style={{
                      marginTop: 12, padding: "10px 13px",
                      background: `${g.color}0e`, borderRadius: 12,
                      border: `1px solid ${g.color}28`,
                      display: "flex", alignItems: "center", gap: 10,
                    }}>
                      <div style={{ width: 34, height: 34, borderRadius: 10, background: `${g.color}20`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 17, flexShrink: 0 }}>📅</div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-body)", fontFamily: "'Inter',sans-serif", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{nextGame.title}</div>
                        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2, fontFamily: "'Inter',sans-serif" }}>
                          {fmt(nextGame.date)}{nextGame.time ? ` · ${fmtT(nextGame.time)}` : ""}
                          {upcoming.length > 1 && <span style={{ marginLeft: 6, color: g.color, fontWeight: 700 }}>+{upcoming.length - 1} more</span>}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div style={{
                      marginTop: 12, padding: "10px 13px",
                      background: "rgba(var(--primary-rgb),0.03)", borderRadius: 12,
                      border: "1px dashed rgba(var(--primary-rgb),0.14)",
                      display: "flex", alignItems: "center", justifyContent: "space-between",
                    }}>
                      <span style={{ fontSize: 12, color: "var(--text-muted)", fontFamily: "'Inter',sans-serif" }}>No upcoming games</span>
                      <span style={{ fontSize: 12, fontWeight: 700, color: "var(--primary)", fontFamily: "'Inter',sans-serif" }}>Schedule →</span>
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

/* NEW GROUP */
function NewGroup({ onBack, onSave, themeColor }) {
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState("🀄");
  const [openInvites, setOpenInvites] = useState(false);
  const [customCode, setCustomCode] = useState("");
  const [codeError, setCodeError] = useState("");
  const [saving, setSaving] = useState(false);
  const autoCode = useRef(uid().slice(0, 5));

  const handleSave = async () => {
    const finalCode = customCode.trim() || autoCode.current;
    setSaving(true);
    setCodeError("");
    try {
      const snap = await getDocs(query(collection(db, "groups"), where("code", "==", finalCode)));
      if (!snap.empty) {
        setCodeError("That code is already taken. Try a different one.");
        setSaving(false);
        return;
      }
      onSave({ id: "G" + uid(), name: name.trim(), emoji, color: themeColor || "var(--primary)", code: finalCode, members: [{ id: "me", name: "You", avatar: "🐼", host: true }], games: [], openInvites });
    } catch { setSaving(false); }
  };

  return (
    <Shell title="New Group" onBack={onBack} color="var(--primary)">
      <Lbl>Group Name</Lbl>
      <Fld value={name} set={setName} placeholder="e.g. Tuesday Tiles" />
      <Lbl mt>Icon</Lbl>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 18 }}>
        {EMOJIS.map((e) => (
          <div key={e} onClick={() => setEmoji(e)} style={{ fontSize: 27, padding: 8, borderRadius: 12, cursor: "pointer", background: emoji === e ? "var(--input-selected-bg)" : "var(--input-unselected-bg)", border: `2px solid ${emoji === e ? "var(--primary)" : "transparent"}`, transition: "all .15s" }}>{e}</div>
        ))}
      </div>
      <Lbl mt>Group Code</Lbl>
      <Fld
        value={customCode}
        set={(v) => { setCustomCode(v.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8)); setCodeError(""); }}
        placeholder={autoCode.current}
      />
      <div style={{ fontSize: 12, color: codeError ? "var(--danger, #e05)" : "var(--text-muted)", fontFamily: "'Inter',sans-serif", marginTop: 5, marginBottom: 4 }}>
        {codeError || `Leave blank to use auto-generated code: ${autoCode.current}`}
      </div>
      <OpenInvitesToggle value={openInvites} onChange={setOpenInvites} />
      <div style={{ marginTop: 24 }}>
        <Btn full disabled={!name.trim() || saving} onClick={handleSave}>🎉 Create Group</Btn>
      </div>
    </Shell>
  );
}

/* EDIT GROUP */
function ArchiveWithGamesDialog({ group, scheduledGames, onMoveAndArchive, onArchiveAll, onCancel }) {
  const count = scheduledGames.length;
  const gWord = count === 1 ? "game" : "games";
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 10000, background: "rgba(0,0,0,0.45)", backdropFilter: "blur(6px)", WebkitBackdropFilter: "blur(6px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div className="bIn" style={{ background: "linear-gradient(160deg,var(--bg-card-base) 0%,var(--bg-card-alt) 100%)", borderRadius: 24, padding: "28px 24px 22px", maxWidth: 340, width: "100%", boxShadow: "0 20px 56px rgba(var(--shadow-rgb),0.28), inset 0 1px 0 var(--shadow-inset)", border: "1px solid rgba(var(--border-light-rgb),0.5)", textAlign: "center" }}>
        <div style={{ fontSize: 38, marginBottom: 12 }}>📦</div>
        <h3 style={{ fontFamily: "var(--font-display)", fontSize: 20, color: "var(--text-heading)", marginBottom: 10, lineHeight: 1.3 }}>Archive Group?</h3>
        <p style={{ fontSize: 14, color: "var(--text-muted)", lineHeight: 1.6, marginBottom: 22 }}>
          <strong style={{ color: "var(--text-body)" }}>"{group.name}"</strong> has {count} scheduled {gWord}. What would you like to do with {count === 1 ? "it" : "them"}?
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <Btn full onClick={onMoveAndArchive}>Move {count === 1 ? "Game" : "Games"} & Archive Group</Btn>
          <Btn full onClick={onArchiveAll}>Archive Group & {count === 1 ? "Game" : "Games"}</Btn>
          <Btn full outline onClick={onCancel}>Cancel</Btn>
        </div>
      </div>
    </div>
  );
}

function EditGroup({ group, onBack, onSave, onArchive, onArchiveAndMove, onArchiveAll }) {
  const [name, setName] = useState(group.name);
  const [emoji, setEmoji] = useState(group.emoji);
  const [openInvites, setOpenInvites] = useState(group.openInvites ?? false);
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false);
  const [archiveLoading, setArchiveLoading] = useState(false);
  const [scheduledGames, setScheduledGames] = useState([]);

  const handleArchiveClick = async () => {
    setArchiveLoading(true);
    try {
      const now = Date.now();
      const snap = await getDocs(collection(db, "groups", group.id, "games"));
      const upcoming = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(gm => gm.date >= now && gm.status !== "archived" && gm.status !== "completed" && gm.status !== "deleted");
      setScheduledGames(upcoming);
    } catch { setScheduledGames([]); }
    setArchiveDialogOpen(true);
    setArchiveLoading(false);
  };

  return (
    <Shell title="Edit Group" onBack={onBack} color={group.color}>
      <Lbl>Group Name</Lbl>
      <Fld value={name} set={setName} placeholder="e.g. Tuesday Tiles" />
      <Lbl mt>Icon</Lbl>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 18 }}>
        {EMOJIS.map((e) => (
          <div key={e} onClick={() => setEmoji(e)} style={{ fontSize: 27, padding: 8, borderRadius: 12, cursor: "pointer", background: emoji === e ? "var(--input-selected-bg)" : "var(--input-unselected-bg)", border: `2px solid ${emoji === e ? "var(--primary)" : "transparent"}`, transition: "all .15s" }}>{e}</div>
        ))}
      </div>
      <OpenInvitesToggle value={openInvites} onChange={setOpenInvites} />
      <div style={{ marginTop: 24, display: "flex", flexDirection: "column", gap: 10 }}>
        <Btn full disabled={!name.trim()} onClick={() =>
          onSave({ name: name.trim(), emoji, openInvites })
        }>Save Changes</Btn>
        <Btn full outline danger disabled={archiveLoading} onClick={handleArchiveClick}>
          {archiveLoading ? "Checking…" : "📦 Archive Group"}
        </Btn>
      </div>
      {archiveDialogOpen && scheduledGames.length === 0 && (
        <ConfirmDialog
          title="Archive Group?"
          message={`"${group.name}" will be moved to your archive. It won't count toward your plan limits and will be automatically removed after 60 days. You can still view it in the Archived tab.`}
          confirmLabel="Archive Group"
          onConfirm={() => { setArchiveDialogOpen(false); onArchive(); }}
          onCancel={() => setArchiveDialogOpen(false)}
        />
      )}
      {archiveDialogOpen && scheduledGames.length > 0 && (
        <ArchiveWithGamesDialog
          group={group}
          scheduledGames={scheduledGames}
          onMoveAndArchive={() => { setArchiveDialogOpen(false); onArchiveAndMove(scheduledGames); }}
          onArchiveAll={() => { setArchiveDialogOpen(false); onArchiveAll(scheduledGames); }}
          onCancel={() => setArchiveDialogOpen(false)}
        />
      )}
    </Shell>
  );
}

function OpenInvitesToggle({ value, onChange }) {
  return (
    <div style={{
      background: "linear-gradient(135deg,var(--bg-card-base),var(--bg-card-alt))",
      borderRadius: 16, padding: "14px 16px",
      boxShadow: "0 4px 16px rgba(var(--shadow-rgb),0.09)", border: "1px solid var(--border-card)",
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: 15, color: "var(--text-body)", fontFamily: "'Inter',sans-serif" }}>Allow Members to Invite</div>
          <div style={{ fontSize: 13, color: "#b08090", marginTop: 3, fontFamily: "'Inter',sans-serif" }}>
            {value ? "All members can invite players to this group" : "Only you (the creator) can invite players"}
          </div>
        </div>
        <div onClick={() => onChange(!value)} style={{
          width: 48, height: 27, borderRadius: 999, cursor: "pointer", flexShrink: 0,
          background: value ? "var(--active-tab-gradient)" : "rgba(200,180,190,0.4)",
          position: "relative", transition: "background .25s",
          boxShadow: value ? "0 2px 10px rgba(var(--shadow-rgb),0.35)" : "none",
          border: "1px solid var(--border-card)",
        }}>
          <div style={{
            width: 21, height: 21, borderRadius: 999, background: "#fff",
            position: "absolute", top: 2,
            left: value ? 24 : 3,
            transition: "left .22s cubic-bezier(.4,0,.2,1)",
            boxShadow: "0 1px 4px rgba(0,0,0,.2)",
          }} />
        </div>
      </div>
    </div>
  );
}

/* JOIN GROUP */
function QrScannerModal({ onDetected, onClose }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const rafRef = useRef(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let active = true;
    navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } })
      .then((stream) => {
        if (!active) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play();
        }
      })
      .catch(() => setError("Camera access denied. Please allow camera permission and try again."));

    return () => {
      active = false;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  function handleVideoPlay() {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;

    function tick() {
      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const result = jsQR(imageData.data, imageData.width, imageData.height);
        if (result) {
          // Accept plain game codes or URLs with ?gameCode=
          let gameCode = null;
          try {
            const url = new URL(result.data);
            gameCode = url.searchParams.get("gameCode") || url.searchParams.get("joinCode") || null;
          } catch {
            // Not a URL — treat raw text as a game code if it looks like one
            const raw = result.data.trim().toUpperCase();
            if (/^[A-Z0-9]{3,12}$/.test(raw)) gameCode = raw;
          }
          if (gameCode) { onDetected(gameCode.toUpperCase()); return; }
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    }
    rafRef.current = requestAnimationFrame(tick);
  }

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 9999,
      background: "rgba(0,0,0,0.92)", display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center",
    }}>
      <div style={{ width: "100%", maxWidth: 400, padding: "0 20px", boxSizing: "border-box" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
          <span style={{ color: "#fff", fontWeight: 800, fontSize: 20, fontFamily: "'Inter',sans-serif" }}>Scan QR Code</span>
          <button onClick={onClose} style={{
            background: "rgba(255,255,255,0.15)", border: "none", borderRadius: 50,
            width: 38, height: 38, fontSize: 20, color: "#fff", cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>✕</button>
        </div>

        {error ? (
          <div style={{ background: "rgba(255,60,60,0.18)", border: "1px solid rgba(255,60,60,0.4)", borderRadius: 16, padding: "20px 18px", color: "#ff9090", fontFamily: "'Inter',sans-serif", fontSize: 15, textAlign: "center" }}>
            {error}
          </div>
        ) : (
          <>
            <div style={{ position: "relative", borderRadius: 20, overflow: "hidden", boxShadow: "0 0 0 3px rgba(var(--primary-rgb),0.6)" }}>
              <video ref={videoRef} onPlay={handleVideoPlay} playsInline muted
                style={{ width: "100%", display: "block", borderRadius: 20 }} />
              {/* Aiming reticle */}
              <div style={{
                position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none",
              }}>
                <div style={{
                  width: 200, height: 200, border: "2.5px solid rgba(255,255,255,0.7)", borderRadius: 18,
                  boxShadow: "0 0 0 2000px rgba(0,0,0,0.35)",
                }} />
              </div>
            </div>
            <canvas ref={canvasRef} style={{ display: "none" }} />
            <p style={{ color: "rgba(255,255,255,0.65)", textAlign: "center", fontSize: 14, marginTop: 18, fontFamily: "'Inter',sans-serif" }}>
              Point at a Mahjong Club QR code
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function JoinGroup({ uid, groups, user, planCfg, onBack, onJoin, onJoinGame }) {
  const [mode, setMode] = useState(null); // null | "group" | "game"
  const [code, setCode] = useState("");
  const [groupMatch, setGroupMatch] = useState(null);
  const [gameMatch, setGameMatch] = useState(null);
  const [searching, setSearching] = useState(false);
  const [scanning, setScanning] = useState(false);
  const clean = code.trim().toUpperCase();

  // Reset code + results whenever mode changes
  useEffect(() => { setCode(""); setGroupMatch(null); setGameMatch(null); setSearching(false); }, [mode]);

  // Group search
  useEffect(() => {
    if (mode !== "group") return;
    setGroupMatch(null);
    if (clean.length < 4) return;
    setSearching(true);
    const variants = [...new Set([clean, clean.toLowerCase()])];
    getDocs(query(collection(db, "groups"), where("code", "in", variants)))
      .then((snap) => setGroupMatch(snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data(), games: [] }))
      .catch(() => setGroupMatch(null))
      .finally(() => setSearching(false));
  }, [clean, mode]);

  // Game search
  useEffect(() => {
    if (mode !== "game") return;
    setGameMatch(null);
    if (clean.length < 3) return;
    setSearching(true);
    const variants = [...new Set([clean, clean.toLowerCase()])];
    const doSearch = async () => {
      // Tier 1: gameCodes index (fast, works for all properly-created games)
      for (const v of variants) {
        const codeSnap = await getDoc(doc(db, "gameCodes", v));
        if (codeSnap.exists()) {
          const { groupId, gameId } = codeSnap.data();
          const gameRef = groupId ? doc(db, "groups", groupId, "games", gameId) : doc(db, "games", gameId);
          const gameSnap = await getDoc(gameRef);
          if (gameSnap.exists()) {
            setGameMatch({ ...gameSnap.data(), id: gameId, groupId: groupId || null, isStandalone: !groupId });
            return;
          }
        }
      }
      // Tier 2: direct collectionGroup query — handles games where gameCodes entry was never created
      const q = query(collectionGroup(db, "games"), where("joinCode", "in", variants));
      const qSnap = await getDocs(q);
      if (!qSnap.empty) {
        const gameDoc = qSnap.docs[0];
        const parts = gameDoc.ref.path.split("/");
        const groupId = parts.length >= 4 ? parts[1] : null;
        setGameMatch({ ...gameDoc.data(), id: gameDoc.id, groupId, isStandalone: !groupId });
        return;
      }
      setGameMatch(null);
    };
    doSearch().catch(() => setGameMatch(null)).finally(() => setSearching(false));
  }, [clean, mode]);

  const alreadyInGroup = groupMatch && (groupMatch.memberIds || []).includes(uid);
  const alreadyInGame = gameMatch && (
    (gameMatch.rsvps?.[uid] !== undefined) ||
    (gameMatch.guestIds || []).includes(uid) ||
    (gameMatch.memberIds || []).includes(uid)
  );

  const handleBack = mode !== null ? () => setMode(null) : onBack;
  const groupAtLimit = !canAddGroup(groups, user, planCfg).ok;

  // ── Choice screen ─────────────────────────────────────────────────────────
  if (!mode) {
    const options = [
      { id: "group", icon: "👥", label: "Join a Group", sub: groupAtLimit ? "Group limit reached — upgrade to join more" : "Enter a group code to become a member", disabled: groupAtLimit },
      { id: "game",  icon: "🀄", label: "Join a Game",  sub: "Enter a game code to RSVP as a guest", disabled: false },
    ];
    return (
      <Shell title="Join" onBack={handleBack} color="var(--secondary-accent)">
        <div style={{ textAlign: "center", fontSize: 49, margin: "12px 0 20px" }}>🔑</div>
        <p style={{ textAlign: "center", fontWeight: 700, fontSize: 16, color: "var(--text-body)", marginBottom: 24, fontFamily: "'Inter',sans-serif" }}>
          What would you like to join?
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 13 }}>
          {options.map(({ id, icon, label, sub, disabled }) => (
            <button key={id} onClick={() => !disabled && setMode(id)} style={{
              display: "flex", alignItems: "center", gap: 16,
              padding: "18px 20px", borderRadius: 18, cursor: disabled ? "default" : "pointer", textAlign: "left",
              background: "linear-gradient(135deg,var(--bg-card),var(--bg-card-alt))",
              border: "1.5px solid var(--border-card)",
              boxShadow: "0 4px 18px rgba(var(--shadow-rgb),0.09), inset 0 1px 0 var(--shadow-inset)",
              backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)",
              transition: "transform .14s",
              opacity: disabled ? 0.45 : 1,
            }}
              onMouseDown={(e) => { if (!disabled) e.currentTarget.style.transform = "scale(.97)"; }}
              onMouseUp={(e) => { e.currentTarget.style.transform = "scale(1)"; }}
              onTouchStart={(e) => { if (!disabled) e.currentTarget.style.transform = "scale(.97)"; }}
              onTouchEnd={(e) => { e.currentTarget.style.transform = "scale(1)"; }}
            >
              <div style={{
                width: 52, height: 52, borderRadius: 15, flexShrink: 0,
                background: "linear-gradient(135deg,rgba(var(--primary-rgb),0.14),rgba(var(--primary-rgb),0.07))",
                display: "flex", alignItems: "center", justifyContent: "center", fontSize: 26,
                border: "1.5px solid rgba(var(--primary-rgb),0.15)",
              }}>{icon}</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: 17, color: "var(--text-body)", fontFamily: "'Inter',sans-serif" }}>{label}</div>
                <div style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 3, fontFamily: "'Inter',sans-serif" }}>{sub}</div>
              </div>
              {!disabled && <span style={{ color: "var(--primary-faint)", fontSize: 22 }}>›</span>}
            </button>
          ))}
        </div>
      </Shell>
    );
  }

  // ── Group code screen ──────────────────────────────────────────────────────
  if (mode === "group") {
    return (
      <Shell title="Join a Group" onBack={handleBack} color="var(--secondary-accent)">
        <div style={{ textAlign: "center", fontSize: 49, margin: "8px 0 20px" }}>👥</div>
        <Lbl>Group Code</Lbl>
        <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="e.g. TUE42"
          autoFocus
          style={{ width: "100%", padding: "14px 16px", background: "#fff", borderRadius: 14, fontSize: 23, fontWeight: 900, textAlign: "center", letterSpacing: 6, textTransform: "uppercase", marginBottom: 14, border: "2px solid var(--border-input)", color: "var(--text-body)", boxSizing: "border-box" }} />
        {searching && <p style={{ color: "var(--secondary-accent)", fontWeight: 700, fontSize: 15, marginBottom: 14, textAlign: "center" }}>Searching…</p>}
        {!searching && clean.length >= 4 && !groupMatch && <p style={{ color: "var(--primary)", fontWeight: 800, fontSize: 15, marginBottom: 14 }}>No group found with that code</p>}
        {groupMatch && !alreadyInGroup && (
          <div className="bIn" style={{ background: "var(--bg-card)", border: "1.5px solid var(--border-card)", borderRadius: 16, padding: "14px 18px", marginBottom: 18, textAlign: "center", boxShadow: "0 4px 16px rgba(var(--shadow-rgb),0.08)" }}>
            <div style={{ fontSize: 29 }}>{groupMatch.emoji}</div>
            <div style={{ fontWeight: 800, fontSize: 18, color: "var(--text-body)", marginTop: 4 }}>{groupMatch.name}</div>
            <div style={{ fontSize: 14, color: "var(--text-muted)", marginTop: 2 }}>{(groupMatch.members || []).length} members</div>
          </div>
        )}
        {alreadyInGroup && <p style={{ color: "var(--secondary-accent)", fontWeight: 800, fontSize: 15, marginBottom: 14, textAlign: "center" }}>You're already in this group!</p>}
        <Btn full disabled={!groupMatch || !!alreadyInGroup} onClick={() => onJoin(groupMatch.id)}>Join Group</Btn>
      </Shell>
    );
  }

  // ── Game code screen ───────────────────────────────────────────────────────
  return (
    <>
      {scanning && (
        <QrScannerModal
          onDetected={(detected) => { setCode(detected); setScanning(false); }}
          onClose={() => setScanning(false)}
        />
      )}
      <Shell title="Join a Game" onBack={handleBack} color="var(--secondary-accent)">
        <div style={{ textAlign: "center", fontSize: 49, margin: "8px 0 20px" }}>🀄</div>
        <Lbl>Game Code</Lbl>
        <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="e.g. TUES7PM"
          autoFocus
          style={{ width: "100%", padding: "14px 16px", background: "#fff", borderRadius: 14, fontSize: 23, fontWeight: 900, textAlign: "center", letterSpacing: 6, textTransform: "uppercase", marginBottom: 12, border: "2px solid var(--border-input)", color: "var(--text-body)", boxSizing: "border-box" }} />
        <button onClick={() => setScanning(true)} style={{
          width: "100%", padding: "13px 16px", borderRadius: 14, border: "1.5px dashed var(--border-input)",
          background: "linear-gradient(135deg,rgba(var(--primary-rgb),0.07),rgba(var(--primary-rgb),0.03))",
          color: "var(--primary)", fontWeight: 700, fontSize: 15, cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
          fontFamily: "'Inter',sans-serif", marginBottom: 14,
          transition: "opacity .14s",
        }}
          onMouseDown={(e) => { e.currentTarget.style.opacity = "0.7"; }}
          onMouseUp={(e) => { e.currentTarget.style.opacity = "1"; }}
          onTouchStart={(e) => { e.currentTarget.style.opacity = "0.7"; }}
          onTouchEnd={(e) => { e.currentTarget.style.opacity = "1"; }}
        >
          <span style={{ fontSize: 20 }}>📷</span> Scan QR Code
        </button>
        {searching && <p style={{ color: "var(--secondary-accent)", fontWeight: 700, fontSize: 15, marginBottom: 14, textAlign: "center" }}>Searching…</p>}
        {!searching && clean.length >= 3 && !gameMatch && <p style={{ color: "var(--primary)", fontWeight: 800, fontSize: 15, marginBottom: 14, textAlign: "center" }}>No game found with that code</p>}
        {gameMatch && !alreadyInGame && (
          <div className="bIn" style={{ background: "var(--bg-card)", border: "1.5px solid var(--border-card)", borderRadius: 16, padding: "16px 18px", marginBottom: 18, boxShadow: "0 4px 16px rgba(var(--shadow-rgb),0.08)" }}>
            <div style={{ fontWeight: 800, fontSize: 17, color: "var(--text-body)", fontFamily: "'Inter',sans-serif", marginBottom: 8 }}>{gameMatch.title}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              {gameMatch.date && <div style={{ fontSize: 14, color: "var(--text-muted)" }}>📅 {fmt(gameMatch.date)}{gameMatch.time ? ` · ${fmtT(gameMatch.time)}` : ""}</div>}
              {gameMatch.location && <div style={{ fontSize: 14, color: "var(--text-muted)" }}>📍 {gameMatch.location}</div>}
              {gameMatch.host && <div style={{ fontSize: 14, color: "var(--text-muted)" }}>🎯 Host: {gameMatch.host}</div>}
            </div>
          </div>
        )}
        {alreadyInGame && <p style={{ color: "var(--secondary-accent)", fontWeight: 800, fontSize: 15, marginBottom: 14, textAlign: "center" }}>You're already in this game!</p>}
        <Btn full disabled={!gameMatch || !!alreadyInGame} onClick={() => onJoinGame(gameMatch.groupId, gameMatch.id, gameMatch.isStandalone)}>Join Game</Btn>
      </Shell>
    </>
  );
}

/* GROUP DETAIL */
function Group({ uid, group, go, flash, onLeave, onTransferAndLeave, onTransferHost, user, planCfg, groups, unreadCounts = {} }) {
  const [tab, setTab] = useState("games");
  const [gamesTab, setGamesTab] = useState("upcoming");
  const [chatOpen, setChatOpen] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [transferMode, setTransferMode] = useState(null); // null | "leave" | "standalone"
  const [selectedNewHost, setSelectedNewHost] = useState(null);
  const todayStart = startOfTodayInTz(user?.timezone);
  const upcoming = group.games.filter((g) => g.status !== "archived" && g.date >= todayStart).sort((a, b) => a.date !== b.date ? a.date - b.date : (a.time || "").localeCompare(b.time || ""));
  const completed = group.games.filter((g) => g.status !== "archived" && g.date < todayStart).sort((a, b) => a.date !== b.date ? b.date - a.date : (b.time || "").localeCompare(a.time || ""));
  const archivedGames = group.games.filter((g) => g.status === "archived").sort((a, b) => b.date - a.date);
  const gamesList = gamesTab === "upcoming" ? upcoming : gamesTab === "completed" ? completed : archivedGames;
  const isCreator = group.members.some((m) => m.id === uid && m.host);
  const canInvite = isCreator || (group.openInvites ?? false);
  const otherMembers = group.members.filter((m) => m.id !== uid);
  const groupUnread = group.status !== "archived" ? (unreadCounts[group.id] || 0) : 0;

  const handleLeaveClick = () => {
    if (isCreator && otherMembers.length > 0) {
      setSelectedNewHost(null);
      setTransferMode("leave");
    } else {
      setConfirmLeave(true);
    }
  };
  return (
    <div style={{ minHeight: "100%", background: `linear-gradient(170deg,var(--bg-shell-start) 0%,var(--bg-shell-mid) 40%,var(--bg-shell-end) 100%)` }}>
      <div style={{
        background: `linear-gradient(135deg,${group.color}f0,${group.color}bb)`,
        backdropFilter: "blur(14px)", WebkitBackdropFilter: "blur(14px)",
        padding: `${HEADER_BTN_TOP}px 22px 28px`, position: "relative", overflow: "hidden",
        boxShadow: `0 8px 32px ${group.color}44`,
      }}>
        <div style={{ position: "absolute", inset: 0, background: "linear-gradient(135deg,rgba(255,255,255,0.18) 0%,transparent 55%)", pointerEvents: "none" }} />
        {/* Back */}
        <button onClick={() => go("groups")} aria-label="Back to Groups" style={{ position: "absolute", top: HEADER_BTN_TOP, left: 8, zIndex: 2, background: "none", border: "none", color: "rgba(255,255,255,0.85)", display: "flex", alignItems: "center", gap: 2, padding: "8px 12px 8px 6px", cursor: "pointer", fontFamily: "'Inter',sans-serif", fontSize: 14, fontWeight: 500 }}>‹ Groups</button>
        {/* Action icons */}
        <div style={{ position: "absolute", top: HEADER_BTN_TOP, right: 14, display: "flex", gap: 7, zIndex: 2 }}>
          {isCreator && (
            <button onClick={() => go("editGroup", group.id)} title="Edit group" style={{ width: 38, height: 38, borderRadius: 11, background: "rgba(255,255,255,.22)", border: "1px solid rgba(255,255,255,.38)", backdropFilter: "blur(8px)", cursor: "pointer", fontSize: 18, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff" }}>✏️</button>
          )}
          <button onClick={() => setChatOpen(true)} title="Group chat" style={{ position: "relative", width: 38, height: 38, borderRadius: 11, background: "rgba(255,255,255,.22)", border: "1px solid rgba(255,255,255,.38)", backdropFilter: "blur(8px)", cursor: "pointer", fontSize: 18, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff" }}>💬<Badge count={groupUnread} /></button>
          {canInvite && (
            <button onClick={() => go("invite", group.id)} title="Invite" style={{ width: 38, height: 38, borderRadius: 11, background: "rgba(255,255,255,.22)", border: "1px solid rgba(255,255,255,.38)", backdropFilter: "blur(8px)", cursor: "pointer", fontSize: 18, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff" }}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg></button>
          )}
        </div>
        {/* Title */}
        <div style={{ textAlign: "center", position: "relative" }}>
          <div style={{ fontSize: 51, marginBottom: 6 }}>{group.emoji}</div>
          <h1 style={{ fontFamily: "'Inter',sans-serif", fontSize: 27, color: "#fff", textShadow: "0 2px 10px rgba(0,0,0,.25)", letterSpacing: 1 }}>{group.name}</h1>
          <div style={{ marginTop: 6, fontSize: 13, color: "rgba(255,255,255,0.75)", fontFamily: "'Inter',sans-serif" }}>{group.members.length} member{group.members.length !== 1 ? "s" : ""}</div>
        </div>
      </div>

      <div style={{ display: "flex", background: "var(--bg-nav)", backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)", borderBottom: "1px solid rgba(var(--border-light-rgb),.4)" }}>
        {[["games","🀀 Games"],["members","👥 Members"]].map(([t, label]) => (
          <button key={t} onClick={() => setTab(t)} style={{ flex: 1, padding: "13px 0", fontSize: 15, fontWeight: 700, background: "none", border: "none", cursor: "pointer", color: tab === t ? group.color : "var(--primary-faint)", borderBottom: `3px solid ${tab === t ? group.color : "transparent"}`, fontFamily: "'Inter',sans-serif", transition: "all .2s" }}>{label}</button>
        ))}
      </div>

      <div style={{ padding: "18px 16px 100px" }}>
        {tab === "games" && (
          <>
            <Btn full onClick={() => { const check = canHostGame(user, groups, planCfg); if (!check.ok) { flash("Hosted game limit reached — upgrade for unlimited games", "🔒"); go("account"); return; } go("newGame", group.id); }} style={{ marginBottom: 14 }}>🀄 Schedule a Game</Btn>

            {upcoming.length === 0 ? (
              <div style={{ textAlign: "center", color: "var(--primary-subtle)", padding: "36px 0" }}>
                <div style={{ fontSize: 41 }}>📅</div>
                <p style={{ fontWeight: 700, marginTop: 8, fontFamily: "'Inter',sans-serif", color: "var(--primary-muted)" }}>No upcoming games yet!</p>
                <p style={{ fontSize: 14, marginTop: 4 }}>Be the first to schedule one.</p>
              </div>
            ) : upcoming.map((gm, i) => (
              <GameCard key={gm.id}
                gm={{ ...gm, groupId: group.id, groupName: group.name, groupColor: group.color, groupEmoji: group.emoji }}
                groups={groups} user={user} go={go} animDelay={i * 0.07} unreadCounts={unreadCounts}
              />
            ))}
          </>
        )}
        {tab === "members" && (
          <>
            {group.members.map((m) => (
              <div key={m.id} style={{ background: "linear-gradient(135deg,var(--bg-card-base),var(--bg-card-alt))", backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)", borderRadius: 16, padding: "13px 15px", marginBottom: 10, display: "flex", alignItems: "center", gap: 12, boxShadow: "0 4px 16px rgba(var(--shadow-rgb),0.09)", border: "1px solid var(--border-card)" }}>
                <div style={{ width: 42, height: 42, borderRadius: 999, background: avatarBg(m.avatar), overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 2px 8px rgba(0,0,0,0.30)" }}><AvatarImg av={m.avatar} size={42}/></div>
                <div style={{ flex: 1 }}>
                  <span style={{ fontWeight: 700, color: "var(--text-body)" }}>{m.name}</span>
                  {m.id === uid && <span style={{ marginLeft: 7, background: "linear-gradient(135deg,var(--primary),#a8426b)", color: "#fff", borderRadius: 999, padding: "1px 8px", fontSize: 12, fontWeight: 700 }}>You</span>}
                  {m.host && <div style={{ fontSize: 13, color: "#c4936e", fontWeight: 700, marginTop: 2 }}>⭐ Host</div>}
                </div>
              </div>
            ))}
            <div style={{ marginTop: 18, display: "flex", flexDirection: "column", gap: 10 }}>
              {isCreator && otherMembers.length > 0 && (
                <Btn full outline onClick={() => { setSelectedNewHost(null); setTransferMode("standalone"); }}>👑 Transfer Host</Btn>
              )}
              {!isCreator && (
                <Btn full outline danger onClick={handleLeaveClick}>Leave Group</Btn>
              )}
            </div>
          </>
        )}
      </div>


      {chatOpen && (
        <GroupChat group={group} uid={uid} user={{ name: group.members.find(m => m.id === uid)?.name || "You", avatar: group.members.find(m => m.id === uid)?.avatar || "🀄" }} onClose={() => setChatOpen(false)} />
      )}
      {confirmLeave && (
        <ConfirmDialog
          title="Leave Group?"
          message={`You will be removed from "${group.name}" and will lose access to its games and chat.`}
          confirmLabel="Leave Group"
          onConfirm={() => { setConfirmLeave(false); onLeave(); }}
          onCancel={() => setConfirmLeave(false)}
        />
      )}
      {transferMode && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 2000, display: "flex", alignItems: "flex-end", justifyContent: "center" }}
          onClick={() => setTransferMode(null)}>
          <div onClick={(e) => e.stopPropagation()} style={{
            width: "100%", maxWidth: 480, background: "var(--bg-popup)",
            borderRadius: "24px 24px 0 0", padding: "24px 20px 40px",
            boxShadow: "0 -8px 40px rgba(0,0,0,0.22)",
          }}>
            <div style={{ width: 36, height: 4, borderRadius: 999, background: "rgba(var(--primary-rgb),0.2)", margin: "0 auto 20px" }} />
            <div style={{ fontSize: 28, textAlign: "center", marginBottom: 8 }}>👑</div>
            <h3 style={{ fontFamily: "'Inter',sans-serif", fontSize: 20, color: "var(--text-body)", textAlign: "center", marginBottom: 6 }}>Transfer Host</h3>
            <p style={{ fontSize: 13, color: "var(--text-muted)", textAlign: "center", marginBottom: 20, lineHeight: 1.5, fontFamily: "'Inter',sans-serif" }}>
              {transferMode === "leave" ? "Assign a new host before leaving the group." : "Choose a member to become the new host."}
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 20 }}>
              {otherMembers.map((m) => {
                const selected = selectedNewHost === m.id;
                return (
                  <div key={m.id} onClick={() => setSelectedNewHost(m.id)} style={{
                    display: "flex", alignItems: "center", gap: 12,
                    padding: "11px 14px", borderRadius: 14, cursor: "pointer", transition: "all .16s",
                    background: selected ? `${group.color}14` : "var(--bg-surface)",
                    border: selected ? `1.5px solid ${group.color}55` : "1.5px solid rgba(var(--primary-rgb),0.12)",
                    boxShadow: selected ? `0 2px 10px ${group.color}22` : "none",
                  }}>
                    <div style={{ width: 38, height: 38, borderRadius: 999, background: avatarBg(m.avatar), overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center", border: selected ? `1.5px solid ${group.color}44` : "1.5px solid var(--border-card)", transition: "all .16s" }}><AvatarImg av={m.avatar} size={38}/></div>
                    <span style={{ flex: 1, fontWeight: 600, fontSize: 15, color: "var(--text-body)", fontFamily: "'Inter',sans-serif" }}>{m.name}</span>
                    <div style={{
                      width: 22, height: 22, borderRadius: 999, flexShrink: 0, transition: "all .16s",
                      background: selected ? `linear-gradient(135deg,${group.color},${group.color}cc)` : "transparent",
                      border: selected ? "none" : "2px solid rgba(var(--primary-rgb),0.2)",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      fontSize: 12, color: "#fff", fontWeight: 800,
                    }}>{selected ? "✓" : ""}</div>
                  </div>
                );
              })}
            </div>
            <Btn full disabled={!selectedNewHost}
              onClick={() => {
                const id = selectedNewHost;
                setTransferMode(null);
                if (transferMode === "leave") onTransferAndLeave(id);
                else onTransferHost(id);
              }}
              style={{ background: selectedNewHost ? `linear-gradient(135deg,${group.color},${group.color}cc)` : undefined }}>
              {transferMode === "leave" ? "👑 Transfer & Leave" : "👑 Transfer Host"}
            </Btn>
            <button onClick={() => setTransferMode(null)} style={{ width: "100%", marginTop: 10, padding: "12px 0", background: "none", border: "none", fontSize: 14, fontWeight: 700, color: "var(--text-muted)", cursor: "pointer", fontFamily: "'Inter',sans-serif" }}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── GROUP CHAT ── */
function GroupChat({ group, uid, user, onClose }) {
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState("");
  const [replyTexts, setReplyTexts] = useState({});
  const [replyOpen, setReplyOpen] = useState({});
  const [emojiPickerOpen, setEmojiPickerOpen] = useState({});
  const [notifBanner, setNotifBanner] = useState(
    typeof Notification !== "undefined" && Notification.permission === "default"
  );
  const bottomRef = useRef(null);
  const inputRef = useRef(null);

  // Lock background scroll while chat is open
  useEffect(() => {
    const el = document.querySelector('[data-scroll-container]');
    if (!el) return;
    const prev = el.style.overflowY;
    el.style.overflowY = 'hidden';
    return () => { el.style.overflowY = prev; };
  }, []);

  useEffect(() => {
    const q = query(
      collection(db, "groups", group.id, "messages"),
      orderBy("createdAt", "asc")
    );
    const unsub = onSnapshot(q, (snap) => {
      setMessages(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
    return unsub;
  }, [group.id]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const sendMessage = async () => {
    const t = text.trim();
    if (!t) return;
    setText("");
    inputRef.current?.focus();
    await addDoc(collection(db, "groups", group.id, "messages"), {
      uid, name: user.name, avatar: user.avatar,
      text: t, createdAt: serverTimestamp(),
      reactions: {}, replies: [],
    });
  };

  const toggleReaction = async (msg, emoji) => {
    const ref = doc(db, "groups", group.id, "messages", msg.id);
    const current = msg.reactions?.[emoji] || [];
    const already = current.includes(uid);
    await updateDoc(ref, {
      [`reactions.${emoji}`]: already ? arrayRemove(uid) : arrayUnion(uid),
    });
  };

  const sendReply = async (msgId) => {
    const t = (replyTexts[msgId] || "").trim();
    if (!t) return;
    setReplyTexts((v) => ({ ...v, [msgId]: "" }));
    const ref = doc(db, "groups", group.id, "messages", msgId);
    await updateDoc(ref, {
      replies: arrayUnion({ uid, name: user.name, avatar: user.avatar, text: t, createdAt: Date.now() }),
    });
  };

  const requestNotifications = async () => {
    setNotifBanner(false);
    await enablePushNotifications(uid);
  };

  const fmtTime = (ts) => {
    if (!ts) return "";
    const d = ts.toDate ? ts.toDate() : new Date(ts);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    if (isToday) return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  };

  return (
    <>
      {/* Backdrop */}
      <div onClick={onClose} style={{
        position: "fixed", inset: 0, background: "rgba(30,10,20,0.45)",
        zIndex: 2000, backdropFilter: "blur(3px)", WebkitBackdropFilter: "blur(3px)",
      }} />

      {/* Sheet */}
      <div style={{
        position: "fixed", bottom: 74, left: "50%",
        transform: "translateX(-50%)",
        width: "100%", maxWidth: 480,
        height: "calc(88vh - 74px)",
        background: "var(--chat-sheet-bg)",
        borderRadius: "22px 22px 0 0",
        zIndex: 2001,
        display: "flex", flexDirection: "column",
        boxShadow: "0 -8px 40px rgba(var(--shadow-rgb),0.28)",
        animation: "sheetUp .28s cubic-bezier(.32,.72,0,1) both",
      }}>
        {/* Handle */}
        <div style={{ display: "flex", justifyContent: "center", padding: "10px 0 0" }}>
          <div style={{ width: 36, height: 4, borderRadius: 999, background: "rgba(var(--primary-rgb),0.25)" }} />
        </div>

        {/* Header */}
        <div style={{
          padding: "10px 16px 12px",
          borderBottom: "1px solid rgba(var(--primary-rgb),0.15)",
          display: "flex", alignItems: "center", gap: 10, flexShrink: 0,
        }}>
          <div style={{ width: 40, height: 40, borderRadius: 13, background: `linear-gradient(135deg,${group.color}33,${group.color}18)`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 21 }}>{group.emoji}</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: "'Inter',sans-serif", fontSize: 18, fontWeight: 700, color: "var(--text-body)" }}>Group Chat</div>
            <div style={{ fontSize: 13, color: "#b08090" }}>{group.name} · {group.members.length} members</div>
          </div>
          <button onClick={() => { inputRef.current?.focus(); inputRef.current?.scrollIntoView({ behavior: "smooth" }); }} style={{ background: `linear-gradient(135deg,${group.color},${group.color}cc)`, border: "none", borderRadius: 999, width: 34, height: 34, fontSize: 20, cursor: "pointer", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: `0 2px 10px ${group.color}55`, marginRight: 4 }}>+</button>
          <button onClick={onClose} style={{ background: "rgba(var(--primary-rgb),0.1)", border: "none", borderRadius: 999, width: 34, height: 34, fontSize: 18, cursor: "pointer", color: "var(--primary)", display: "flex", alignItems: "center", justifyContent: "center" }}>✕</button>
        </div>

        {/* Notification banner */}
        {notifBanner && (
          <div style={{ margin: "8px 14px 0", background: "rgba(var(--primary-rgb),0.08)", border: "1px solid rgba(var(--primary-rgb),0.2)", borderRadius: 12, padding: "9px 12px", display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
            <span style={{ fontSize: 18 }}>🔔</span>
            <div style={{ flex: 1, fontSize: 13, color: "var(--section-title)", fontFamily: "'Inter',sans-serif" }}>Get notified when members post</div>
            <button onClick={requestNotifications} style={{ background: `linear-gradient(135deg,${group.color},${group.color}cc)`, border: "none", borderRadius: 999, padding: "4px 12px", color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "'Inter',sans-serif", whiteSpace: "nowrap" }}>Enable</button>
            <button onClick={() => setNotifBanner(false)} style={{ background: "none", border: "none", color: "#c0a0b0", fontSize: 16, cursor: "pointer", padding: 0, lineHeight: 1 }}>✕</button>
          </div>
        )}

        {/* Messages */}
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "12px 14px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
          {messages.length === 0 && (
            <div style={{ textAlign: "center", color: "#c0a0b0", padding: "48px 0" }}>
              <div style={{ fontSize: 40 }}>💬</div>
              <p style={{ fontSize: 15, marginTop: 10, fontFamily: "'Inter',sans-serif", color: "var(--primary-muted)" }}>No messages yet</p>
              <p style={{ fontSize: 13, marginTop: 4 }}>Tap <b>+</b> to say hello to the group!</p>
            </div>
          )}
          {messages.map((msg, idx) => {
            const isMe = msg.uid === uid;
            const replies = msg.replies || [];
            const replyCount = replies.length;
            const showReplyInput = replyOpen[msg.id];
            return (
              <div key={msg.id}>
                {/* Divider between messages */}
                {idx > 0 && (
                  <div style={{ height: 1, background: "rgba(var(--primary-rgb),0.12)", margin: "4px 0 12px" }} />
                )}

                {/* Bubble row */}
                <div style={{ display: "flex", gap: 8, flexDirection: isMe ? "row-reverse" : "row", alignItems: "flex-end" }}>
                  {!isMe && (
                    <div style={{ width: 34, height: 34, borderRadius: 999, background: avatarBg(msg.avatar), overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, alignSelf: "flex-start", marginTop: 18 }}><AvatarImg av={msg.avatar} size={34}/></div>
                  )}
                  <div style={{ maxWidth: "74%", display: "flex", flexDirection: "column", alignItems: isMe ? "flex-end" : "flex-start" }}>
                    {!isMe && <div style={{ fontSize: 12, color: "#b08090", marginBottom: 3, fontWeight: 700, paddingLeft: 4 }}>{msg.name}</div>}
                    <div style={{
                      background: isMe ? `linear-gradient(135deg,${group.color},${group.color}bb)` : "var(--bg-msg-other)",
                      color: isMe ? "#fff" : "var(--text-body)",
                      borderRadius: isMe ? "18px 18px 4px 18px" : "18px 18px 18px 4px",
                      padding: "10px 14px", fontSize: 15, lineHeight: 1.45,
                      boxShadow: isMe ? `0 4px 14px ${group.color}44` : "0 2px 8px rgba(var(--shadow-rgb),0.09)",
                      border: isMe ? "none" : "1px solid var(--bg-card-base)",
                      wordBreak: "break-word",
                    }}>{msg.text}</div>
                    <div style={{ fontSize: 12, color: "#c0a8b8", marginTop: 3, paddingLeft: isMe ? 0 : 4, paddingRight: isMe ? 4 : 0 }}>{fmtTime(msg.createdAt)}</div>
                  </div>
                </div>

                {/* Reactions + reply button */}
                <div style={{ display: "flex", gap: 4, marginTop: 6, paddingLeft: isMe ? 0 : 42, justifyContent: isMe ? "flex-end" : "flex-start", flexWrap: "wrap", alignItems: "center" }}>
                  {/* Active reaction counts (always visible) */}
                  {REACTION_EMOJIS.filter(e => (msg.reactions?.[e] || []).length > 0).map((emoji) => {
                    const reactors = msg.reactions[emoji];
                    const reacted = reactors.includes(uid);
                    return (
                      <button key={emoji} onClick={() => toggleReaction(msg, emoji)} style={{
                        background: reacted ? `${group.color}22` : "var(--border-card)",
                        border: `1.5px solid ${reacted ? group.color : "rgba(var(--primary-rgb),0.2)"}`,
                        borderRadius: 999, padding: "2px 8px", fontSize: 14,
                        cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 3,
                        color: reacted ? group.color : "#b08090", fontWeight: reacted ? 700 : 400,
                        fontFamily: "'Inter',sans-serif", transition: "all .13s",
                      }}>
                        {emoji}<span style={{ fontSize: 12 }}>{reactors.length}</span>
                      </button>
                    );
                  })}

                  {/* Emoji face trigger — expands picker */}
                  <div style={{ position: "relative" }}>
                    <button
                      onClick={() => setEmojiPickerOpen((v) => ({ ...v, [msg.id]: !v[msg.id] }))}
                      style={{
                        background: emojiPickerOpen[msg.id] ? "rgba(var(--primary-rgb),0.12)" : "var(--border-card)",
                        border: `1.5px solid ${emojiPickerOpen[msg.id] ? "rgba(var(--primary-rgb),0.4)" : "rgba(var(--primary-rgb),0.15)"}`,
                        borderRadius: 999, height: 28, padding: "0 7px", fontSize: 13,
                        cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 3,
                        color: emojiPickerOpen[msg.id] ? "var(--primary)" : "#b08090",
                        fontWeight: 700, fontFamily: "'Inter',sans-serif",
                        transition: "all .13s",
                      }}
                    ><span style={{ fontSize: 15 }}>☺</span><span>+</span></button>
                    {emojiPickerOpen[msg.id] && (
                      <div style={{
                        position: "absolute", bottom: "calc(100% + 6px)",
                        [isMe ? "right" : "left"]: 0,
                        background: "var(--bg-popup)",
                        borderRadius: 16, padding: "8px 10px",
                        boxShadow: "0 6px 24px rgba(var(--shadow-rgb),0.18)",
                        border: "1px solid rgba(var(--primary-rgb),0.15)",
                        display: "flex", gap: 6, zIndex: 10,
                        backdropFilter: "blur(12px)",
                      }}>
                        {REACTION_EMOJIS.map((emoji) => {
                          const reacted = (msg.reactions?.[emoji] || []).includes(uid);
                          return (
                            <button key={emoji} onClick={() => { toggleReaction(msg, emoji); setEmojiPickerOpen((v) => ({ ...v, [msg.id]: false })); }} style={{
                              background: reacted ? `${group.color}22` : "none",
                              border: `1.5px solid ${reacted ? group.color : "transparent"}`,
                              borderRadius: 8, padding: "4px 5px", fontSize: 20,
                              cursor: "pointer", transition: "transform .1s",
                              transform: reacted ? "scale(1.15)" : "scale(1)",
                            }}>{emoji}</button>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  <button onClick={() => setReplyOpen((v) => ({ ...v, [msg.id]: !v[msg.id] }))} style={{
                    background: showReplyInput ? "rgba(var(--primary-rgb),0.1)" : "var(--border-card)",
                    border: `1.5px solid ${showReplyInput ? "rgba(var(--primary-rgb),0.35)" : "rgba(var(--primary-rgb),0.15)"}`,
                    borderRadius: 999, padding: "2px 9px", fontSize: 13,
                    cursor: "pointer", color: showReplyInput ? "var(--primary)" : "#b08090",
                    fontFamily: "'Inter',sans-serif", fontWeight: showReplyInput ? 700 : 400,
                    transition: "all .13s",
                  }}>
                    ↩ {replyCount > 0 ? `${replyCount} repl${replyCount === 1 ? "y" : "ies"}` : "Reply"}
                  </button>
                </div>

                {/* Inline replies — always visible when present; input shown on toggle */}
                {(replyCount > 0 || showReplyInput) && (
                  <div style={{ marginLeft: 42, marginTop: 8, borderLeft: `2px solid ${group.color}33`, paddingLeft: 10 }}>
                    {replies.map((r, ri) => (
                      <div key={ri} style={{ display: "flex", gap: 6, alignItems: "flex-start", marginBottom: 7 }}>
                        <div style={{ width: 26, height: 26, borderRadius: 999, background: avatarBg(r.avatar), overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><AvatarImg av={r.avatar} size={26}/></div>
                        <div style={{ background: "var(--bg-card-base)", borderRadius: "12px 12px 12px 3px", padding: "6px 10px", flex: 1 }}>
                          <div style={{ fontSize: 12, fontWeight: 700, color: group.color, marginBottom: 2 }}>{r.name}</div>
                          <div style={{ fontSize: 14, color: "var(--text-body)" }}>{r.text}</div>
                        </div>
                      </div>
                    ))}
                    {showReplyInput && (
                      <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                        <input
                          autoFocus
                          value={replyTexts[msg.id] || ""}
                          onChange={(e) => setReplyTexts((v) => ({ ...v, [msg.id]: e.target.value }))}
                          onKeyDown={(e) => { if (e.key === "Enter") { sendReply(msg.id); setReplyOpen((v) => ({ ...v, [msg.id]: false })); } }}
                          placeholder="Write a reply…"
                          style={{ ...inputSt, flex: 1, marginBottom: 0, fontSize: 16, padding: "7px 11px", borderRadius: 12 }}
                        />
                        <button onClick={() => { sendReply(msg.id); setReplyOpen((v) => ({ ...v, [msg.id]: false })); }} style={{
                          background: `linear-gradient(135deg,${group.color},${group.color}cc)`,
                          border: "none", borderRadius: 12, padding: "0 13px",
                          color: "#fff", fontSize: 14, fontWeight: 700, cursor: "pointer", flexShrink: 0,
                        }}>Send</button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>

        {/* Input bar — hidden while a reply input is open */}
        {!Object.values(replyOpen).some(Boolean) && <div style={{
          padding: "10px 14px calc(10px + env(safe-area-inset-bottom))",
          borderTop: "1px solid rgba(var(--primary-rgb),0.15)",
          background: "rgba(255,245,250,0.97)",
          flexShrink: 0, display: "flex", gap: 8, alignItems: "flex-end",
        }}>
          <textarea
            ref={inputRef}
            value={text}
            onChange={(e) => { setText(e.target.value); e.target.style.height = "auto"; e.target.style.height = Math.min(e.target.scrollHeight, 110) + "px"; }}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
            placeholder="Message the group…"
            rows={1}
            style={{ ...inputSt, flex: 1, marginBottom: 0, resize: "none", borderRadius: 18, padding: "10px 14px", fontSize: 16, lineHeight: 1.4, overflow: "hidden" }}
          />
          <button onClick={sendMessage} style={{
            background: text.trim() ? `linear-gradient(135deg,${group.color},${group.color}cc)` : "rgba(var(--primary-rgb),0.18)",
            border: "none", borderRadius: 18, padding: "10px 20px",
            color: text.trim() ? "#fff" : "var(--primary-faint)",
            fontSize: 15, fontWeight: 700,
            cursor: text.trim() ? "pointer" : "default",
            transition: "all .18s", flexShrink: 0,
            fontFamily: "'Inter',sans-serif",
          }}>Send</button>
        </div>}
      </div>
    </>
  );
}

/* GAME CHAT */
function GameChat({ game, group, uid, user, onClose }) {
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState("");
  const [replyTexts, setReplyTexts] = useState({});
  const [replyOpen, setReplyOpen] = useState({});
  const [emojiPickerOpen, setEmojiPickerOpen] = useState({});
  const bottomRef = useRef(null);
  const inputRef = useRef(null);

  // Standalone games store messages under games/{gameId}/messages;
  // group games store them under groups/{groupId}/games/{gameId}/messages.
  const msgCollection = group.id
    ? collection(db, "groups", group.id, "games", game.id, "messages")
    : collection(db, "games", game.id, "messages");
  const msgDoc = (msgId) => group.id
    ? doc(db, "groups", group.id, "games", game.id, "messages", msgId)
    : doc(db, "games", game.id, "messages", msgId);

  // Lock background scroll while chat is open
  useEffect(() => {
    const el = document.querySelector("[data-scroll-container]");
    if (!el) return;
    const prev = el.style.overflowY;
    el.style.overflowY = "hidden";
    return () => { el.style.overflowY = prev; };
  }, []);

  useEffect(() => {
    const q = query(msgCollection, orderBy("createdAt", "asc"));
    const unsub = onSnapshot(q, (snap) => {
      setMessages(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
    return unsub;
  }, [game.id]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const sendMessage = async () => {
    const t = text.trim();
    if (!t) return;
    setText("");
    inputRef.current?.focus();
    await addDoc(msgCollection, {
      uid, name: user.name, avatar: user.avatar,
      text: t, createdAt: serverTimestamp(),
      reactions: {}, replies: [],
    });
  };

  const toggleReaction = async (msg, emoji) => {
    const ref = msgDoc(msg.id);
    const current = msg.reactions?.[emoji] || [];
    const already = current.includes(uid);
    await updateDoc(ref, {
      [`reactions.${emoji}`]: already ? arrayRemove(uid) : arrayUnion(uid),
    });
  };

  const sendReply = async (msgId) => {
    const t = (replyTexts[msgId] || "").trim();
    if (!t) return;
    setReplyTexts((v) => ({ ...v, [msgId]: "" }));
    const ref = msgDoc(msgId);
    await updateDoc(ref, {
      replies: arrayUnion({ uid, name: user.name, avatar: user.avatar, text: t, createdAt: Date.now() }),
    });
  };

  const fmtTime = (ts) => {
    if (!ts) return "";
    const d = ts.toDate ? ts.toDate() : new Date(ts);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    if (isToday) return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  };

  return (
    <>
      {/* Backdrop */}
      <div onClick={onClose} style={{
        position: "fixed", inset: 0, background: "rgba(30,10,20,0.45)",
        zIndex: 2000, backdropFilter: "blur(3px)", WebkitBackdropFilter: "blur(3px)",
      }} />

      {/* Sheet */}
      <div style={{
        position: "fixed", bottom: 74, left: "50%",
        transform: "translateX(-50%)",
        width: "100%", maxWidth: 480,
        height: "calc(88vh - 74px)",
        background: "var(--chat-sheet-bg)",
        borderRadius: "22px 22px 0 0",
        zIndex: 2001,
        display: "flex", flexDirection: "column",
        boxShadow: "0 -8px 40px rgba(var(--shadow-rgb),0.28)",
        animation: "sheetUp .28s cubic-bezier(.32,.72,0,1) both",
      }}>
        {/* Handle */}
        <div style={{ display: "flex", justifyContent: "center", padding: "10px 0 0" }}>
          <div style={{ width: 36, height: 4, borderRadius: 999, background: "rgba(var(--primary-rgb),0.25)" }} />
        </div>

        {/* Header */}
        <div style={{
          padding: "10px 16px 12px",
          borderBottom: "1px solid rgba(var(--primary-rgb),0.15)",
          display: "flex", alignItems: "center", gap: 10, flexShrink: 0,
        }}>
          <div style={{ width: 40, height: 40, borderRadius: 13, background: `linear-gradient(135deg,${group.color}33,${group.color}18)`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 21 }}>💬</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: "'Inter',sans-serif", fontSize: 18, fontWeight: 700, color: "var(--text-body)" }}>{game.title}</div>
            <div style={{ fontSize: 13, color: "#b08090" }}>Game Chat</div>
          </div>
          <button onClick={() => { inputRef.current?.focus(); inputRef.current?.scrollIntoView({ behavior: "smooth" }); }} style={{ background: `linear-gradient(135deg,${group.color},${group.color}cc)`, border: "none", borderRadius: 999, width: 34, height: 34, fontSize: 20, cursor: "pointer", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: `0 2px 10px ${group.color}55`, marginRight: 4 }}>+</button>
          <button onClick={onClose} style={{ background: "rgba(var(--primary-rgb),0.1)", border: "none", borderRadius: 999, width: 34, height: 34, fontSize: 18, cursor: "pointer", color: "var(--primary)", display: "flex", alignItems: "center", justifyContent: "center" }}>✕</button>
        </div>

        {/* Messages */}
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "12px 14px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
          {messages.length === 0 && (
            <div style={{ textAlign: "center", color: "#c0a0b0", padding: "48px 0" }}>
              <div style={{ fontSize: 40 }}>💬</div>
              <p style={{ fontSize: 15, marginTop: 10, fontFamily: "'Inter',sans-serif", color: "var(--primary-muted)" }}>No messages yet</p>
              <p style={{ fontSize: 13, marginTop: 4 }}>Tap <b>+</b> to say hello to the game!</p>
            </div>
          )}
          {messages.map((msg, idx) => {
            const isMe = msg.uid === uid;
            const replies = msg.replies || [];
            const replyCount = replies.length;
            const showReplyInput = replyOpen[msg.id];
            return (
              <div key={msg.id}>
                {idx > 0 && (
                  <div style={{ height: 1, background: "rgba(var(--primary-rgb),0.12)", margin: "4px 0 12px" }} />
                )}
                {/* Bubble row */}
                <div style={{ display: "flex", gap: 8, flexDirection: isMe ? "row-reverse" : "row", alignItems: "flex-end" }}>
                  {!isMe && (
                    <div style={{ width: 34, height: 34, borderRadius: 999, background: avatarBg(msg.avatar), overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, alignSelf: "flex-start", marginTop: 18 }}><AvatarImg av={msg.avatar} size={34}/></div>
                  )}
                  <div style={{ maxWidth: "74%", display: "flex", flexDirection: "column", alignItems: isMe ? "flex-end" : "flex-start" }}>
                    {!isMe && <div style={{ fontSize: 12, color: "#b08090", marginBottom: 3, fontWeight: 700, paddingLeft: 4 }}>{msg.name}</div>}
                    <div style={{
                      background: isMe ? `linear-gradient(135deg,${group.color},${group.color}bb)` : "var(--bg-msg-other)",
                      color: isMe ? "#fff" : "var(--text-body)",
                      borderRadius: isMe ? "18px 18px 4px 18px" : "18px 18px 18px 4px",
                      padding: "10px 14px", fontSize: 15, lineHeight: 1.45,
                      boxShadow: isMe ? `0 4px 14px ${group.color}44` : "0 2px 8px rgba(var(--shadow-rgb),0.09)",
                      border: isMe ? "none" : "1px solid var(--bg-card-base)",
                      wordBreak: "break-word",
                    }}>{msg.text}</div>
                    <div style={{ fontSize: 12, color: "#c0a8b8", marginTop: 3, paddingLeft: isMe ? 0 : 4, paddingRight: isMe ? 4 : 0 }}>{fmtTime(msg.createdAt)}</div>
                  </div>
                </div>

                {/* Reactions + reply button */}
                <div style={{ display: "flex", gap: 4, marginTop: 6, paddingLeft: isMe ? 0 : 42, justifyContent: isMe ? "flex-end" : "flex-start", flexWrap: "wrap", alignItems: "center" }}>
                  {REACTION_EMOJIS.filter(e => (msg.reactions?.[e] || []).length > 0).map((emoji) => {
                    const reactors = msg.reactions[emoji];
                    const reacted = reactors.includes(uid);
                    return (
                      <button key={emoji} onClick={() => toggleReaction(msg, emoji)} style={{
                        background: reacted ? `${group.color}22` : "var(--border-card)",
                        border: `1.5px solid ${reacted ? group.color : "rgba(var(--primary-rgb),0.2)"}`,
                        borderRadius: 999, padding: "2px 8px", fontSize: 14,
                        cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 3,
                        color: reacted ? group.color : "#b08090", fontWeight: reacted ? 700 : 400,
                        fontFamily: "'Inter',sans-serif", transition: "all .13s",
                      }}>
                        {emoji}<span style={{ fontSize: 12 }}>{reactors.length}</span>
                      </button>
                    );
                  })}

                  <div style={{ position: "relative" }}>
                    <button
                      onClick={() => setEmojiPickerOpen((v) => ({ ...v, [msg.id]: !v[msg.id] }))}
                      style={{
                        background: emojiPickerOpen[msg.id] ? "rgba(var(--primary-rgb),0.12)" : "var(--border-card)",
                        border: `1.5px solid ${emojiPickerOpen[msg.id] ? "rgba(var(--primary-rgb),0.4)" : "rgba(var(--primary-rgb),0.15)"}`,
                        borderRadius: 999, height: 28, padding: "0 7px", fontSize: 13,
                        cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 3,
                        color: emojiPickerOpen[msg.id] ? "var(--primary)" : "#b08090",
                        fontWeight: 700, fontFamily: "'Inter',sans-serif",
                        transition: "all .13s",
                      }}
                    ><span style={{ fontSize: 15 }}>☺</span><span>+</span></button>
                    {emojiPickerOpen[msg.id] && (
                      <div style={{
                        position: "absolute", bottom: "calc(100% + 6px)",
                        [isMe ? "right" : "left"]: 0,
                        background: "var(--bg-popup)",
                        borderRadius: 16, padding: "8px 10px",
                        boxShadow: "0 6px 24px rgba(var(--shadow-rgb),0.18)",
                        border: "1px solid rgba(var(--primary-rgb),0.15)",
                        display: "flex", gap: 6, zIndex: 10,
                        backdropFilter: "blur(12px)",
                      }}>
                        {REACTION_EMOJIS.map((emoji) => {
                          const reacted = (msg.reactions?.[emoji] || []).includes(uid);
                          return (
                            <button key={emoji} onClick={() => { toggleReaction(msg, emoji); setEmojiPickerOpen((v) => ({ ...v, [msg.id]: false })); }} style={{
                              background: reacted ? `${group.color}22` : "none",
                              border: `1.5px solid ${reacted ? group.color : "transparent"}`,
                              borderRadius: 8, padding: "4px 5px", fontSize: 20,
                              cursor: "pointer", transition: "transform .1s",
                              transform: reacted ? "scale(1.15)" : "scale(1)",
                            }}>{emoji}</button>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  <button onClick={() => setReplyOpen((v) => ({ ...v, [msg.id]: !v[msg.id] }))} style={{
                    background: showReplyInput ? "rgba(var(--primary-rgb),0.1)" : "var(--border-card)",
                    border: `1.5px solid ${showReplyInput ? "rgba(var(--primary-rgb),0.35)" : "rgba(var(--primary-rgb),0.15)"}`,
                    borderRadius: 999, padding: "2px 9px", fontSize: 13,
                    cursor: "pointer", color: showReplyInput ? "var(--primary)" : "#b08090",
                    fontFamily: "'Inter',sans-serif", fontWeight: showReplyInput ? 700 : 400,
                    transition: "all .13s",
                  }}>
                    ↩ {replyCount > 0 ? `${replyCount} repl${replyCount === 1 ? "y" : "ies"}` : "Reply"}
                  </button>
                </div>

                {/* Inline replies */}
                {(replyCount > 0 || showReplyInput) && (
                  <div style={{ marginLeft: 42, marginTop: 8, borderLeft: `2px solid ${group.color}33`, paddingLeft: 10 }}>
                    {replies.map((r, ri) => (
                      <div key={ri} style={{ display: "flex", gap: 6, alignItems: "flex-start", marginBottom: 7 }}>
                        <div style={{ width: 26, height: 26, borderRadius: 999, background: avatarBg(r.avatar), overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><AvatarImg av={r.avatar} size={26}/></div>
                        <div style={{ background: "var(--bg-card-base)", borderRadius: "12px 12px 12px 3px", padding: "6px 10px", flex: 1 }}>
                          <div style={{ fontSize: 12, fontWeight: 700, color: group.color, marginBottom: 2 }}>{r.name}</div>
                          <div style={{ fontSize: 14, color: "var(--text-body)" }}>{r.text}</div>
                        </div>
                      </div>
                    ))}
                    {showReplyInput && (
                      <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                        <input
                          autoFocus
                          value={replyTexts[msg.id] || ""}
                          onChange={(e) => setReplyTexts((v) => ({ ...v, [msg.id]: e.target.value }))}
                          onKeyDown={(e) => { if (e.key === "Enter") { sendReply(msg.id); setReplyOpen((v) => ({ ...v, [msg.id]: false })); } }}
                          placeholder="Write a reply…"
                          style={{ ...inputSt, flex: 1, marginBottom: 0, fontSize: 16, padding: "7px 11px", borderRadius: 12 }}
                        />
                        <button onClick={() => { sendReply(msg.id); setReplyOpen((v) => ({ ...v, [msg.id]: false })); }} style={{
                          background: `linear-gradient(135deg,${group.color},${group.color}cc)`,
                          border: "none", borderRadius: 12, padding: "0 13px",
                          color: "#fff", fontSize: 14, fontWeight: 700, cursor: "pointer", flexShrink: 0,
                        }}>Send</button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>

        {/* Input bar */}
        {!Object.values(replyOpen).some(Boolean) && <div style={{
          padding: "10px 14px calc(10px + env(safe-area-inset-bottom))",
          borderTop: "1px solid rgba(var(--primary-rgb),0.15)",
          background: "rgba(255,245,250,0.97)",
          flexShrink: 0, display: "flex", gap: 8, alignItems: "flex-end",
        }}>
          <textarea
            ref={inputRef}
            value={text}
            onChange={(e) => { setText(e.target.value); e.target.style.height = "auto"; e.target.style.height = Math.min(e.target.scrollHeight, 110) + "px"; }}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
            placeholder="Message the game…"
            rows={1}
            style={{ ...inputSt, flex: 1, marginBottom: 0, resize: "none", borderRadius: 18, padding: "10px 14px", fontSize: 16, lineHeight: 1.4, overflow: "hidden" }}
          />
          <button onClick={sendMessage} style={{
            background: text.trim() ? `linear-gradient(135deg,${group.color},${group.color}cc)` : "rgba(var(--primary-rgb),0.18)",
            border: "none", borderRadius: 18, padding: "10px 20px",
            color: text.trim() ? "#fff" : "var(--primary-faint)",
            fontSize: 15, fontWeight: 700,
            cursor: text.trim() ? "pointer" : "default",
            transition: "all .18s", flexShrink: 0,
            fontFamily: "'Inter',sans-serif",
          }}>Send</button>
        </div>}
      </div>
    </>
  );
}

/* ADD TO CALENDAR */
function AddToCalendar({ game, groupName, compact = false }) {
  const [open, setOpen] = useState(false);
  const { googleUrl } = buildCalendarLinks(game, groupName);

  if (compact) {
    // Small inline button for the game card
    return (
      <div style={{ position: "relative" }}>
        <button
          onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
          style={{ background: "rgba(var(--primary-rgb),0.1)", border: "1px solid rgba(var(--primary-rgb),0.25)", borderRadius: 999, padding: "3px 10px", fontSize: 12, fontWeight: 700, color: "var(--primary)", cursor: "pointer", fontFamily: "'Inter',sans-serif" }}
        >📅 Add</button>
        {open && (
          <div onClick={(e) => e.stopPropagation()} style={{ position: "absolute", bottom: "calc(100% + 6px)", right: 0, background: "#fff", borderRadius: 14, boxShadow: "0 8px 28px rgba(var(--shadow-rgb),0.18)", border: "1px solid rgba(var(--primary-rgb),0.15)", overflow: "hidden", zIndex: 100, minWidth: 180 }}>
            <button onClick={() => { window.open(googleUrl, "_blank"); setOpen(false); }} style={calMenuBtn}>🗓 Google Calendar</button>
            <button onClick={() => { downloadIcs(game, groupName); setOpen(false); }} style={{ ...calMenuBtn, borderTop: "1px solid rgba(var(--primary-rgb),0.1)" }}>⬇️ Download .ics</button>
          </div>
        )}
      </div>
    );
  }

  // Full card for game detail view
  return (
    <div style={{ background: "linear-gradient(135deg,var(--bg-card),var(--bg-card-alt))", backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)", borderRadius: 16, padding: "15px 16px", marginBottom: 12, boxShadow: "0 4px 16px rgba(var(--shadow-rgb),0.08), inset 0 1px 0 var(--shadow-inset)", border: "1px solid var(--border-card)" }}>
      <div style={{ fontWeight: 700, color: "var(--text-body)", marginBottom: 12, fontFamily: "'Inter',sans-serif" }}>Add to Calendar</div>
      <div style={{ display: "flex", gap: 10 }}>
        <button onClick={() => window.open(googleUrl, "_blank")} style={calFullBtn("#4285f4")}>
          <span style={{ fontSize: 19 }}>🗓</span>
          <span>Google Calendar</span>
        </button>
        <button onClick={() => downloadIcs(game, groupName)} style={calFullBtn("var(--primary)")}>
          <span style={{ fontSize: 19 }}>📅</span>
          <span>Apple / Other</span>
        </button>
      </div>
    </div>
  );
}
const calMenuBtn = { display: "block", width: "100%", padding: "11px 16px", background: "none", border: "none", textAlign: "left", fontSize: 14, fontWeight: 700, color: "var(--text-body)", cursor: "pointer", fontFamily: "'Inter',sans-serif" };
const calFullBtn = (color) => ({ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 5, padding: "12px 8px", borderRadius: 12, background: `${color}12`, border: `1.5px solid ${color}33`, cursor: "pointer", fontFamily: "'Inter',sans-serif", fontSize: 13, fontWeight: 700, color: "var(--text-body)" });


/* NEW GAME */
function NewGame({ uid: myUid, user: myUser, group, groups = [], planCfg, onBack, onSave }) {
  const hostedGroups = !group ? groups.filter(g => g.members?.some(m => m.id === myUid && m.host) && g.status !== "archived") : [];
  const [selectedGroupId, setSelectedGroupId] = useState(null);
  const effectiveGroup = group || hostedGroups.find(g => g.id === selectedGroupId) || null;
  const [title, setTitle] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("19:00");
  const [endTime, setEndTime] = useState("22:00");
  const [loc, setLoc] = useState("");
  const [note, setNote] = useState("");
  const [tables, setTables] = useState(1);
  const [recurring, setRecurring] = useState(false);
  const [freq, setFreq] = useState("weekly");
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [coHostIds, setCoHostIds] = useState(new Set());
  const [joinCode, setJoinCode] = useState(() => generateGameCode());
  const [codeStatus, setCodeStatus] = useState("checking"); // 'checking'|'available'|'taken'|'invalid'

  const checkCode = async (rawCode) => {
    const code = rawCode.trim().toUpperCase();
    if (!isValidGameCode(code)) { setCodeStatus("invalid"); return; }
    setCodeStatus("checking");
    try {
      const snap = await getDoc(doc(db, "gameCodes", code));
      if (!snap.exists()) { setCodeStatus("available"); return; }
      if (snap.data().date < Date.now()) { setCodeStatus("available"); return; }
      setCodeStatus("taken");
    } catch { setCodeStatus("available"); }
  };

  useEffect(() => { checkCode(joinCode); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const otherMembers = effectiveGroup ? effectiveGroup.members.filter((m) => m.id !== myUid) : [];
  const allSelected = otherMembers.length > 0 && otherMembers.every((m) => selectedIds.has(m.id));
  const toggleMember = (id) => setSelectedIds((prev) => {
    const s = new Set(prev);
    if (s.has(id)) {
      s.delete(id);
      setCoHostIds((c) => { const n = new Set(c); n.delete(id); return n; });
    } else {
      s.add(id);
    }
    return s;
  });
  const toggleAll = () => setSelectedIds(allSelected ? new Set() : new Set(otherMembers.map((m) => m.id)));
  const toggleCoHost = (id) => setCoHostIds((prev) => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s; });
  const [occurrences, setOccurrences] = useState(4);

  const FREQS = [
    { id: "weekly",    label: "Weekly",     icon: "7️⃣",  days: 7   },
    { id: "biweekly",  label: "Every 2 Wks",icon: "2️⃣",  days: 14  },
    { id: "monthly",   label: "Monthly",    icon: "📆",  days: 30  },
  ];

  // Build preview dates for recurring
  const previewDates = () => {
    if (!date) return [];
    const chosen = FREQS.find((f) => f.id === freq);
    const ms = chosen.days * 86400000;
    const base = new Date(`${date}T${time}`).getTime();
    return Array.from({ length: occurrences }, (_, i) => base + i * ms);
  };

  const codeOk = recurring || codeStatus === "available";
  const ok = title.trim() && date && time && loc.trim() && codeOk;

  const handleSave = () => {
    if (!ok) return;
    const rsvps = { [myUid]: "yes" };
    selectedIds.forEach((id) => { rsvps[id] = "yes"; });
    const coHostArr = [...coHostIds];
    if (!recurring) {
      const ts = new Date(`${date}T${time}`).getTime();
      onSave({ id: "gm" + uid(), title: title.trim(), host: myUser.name, hostId: myUid, coHostIds: coHostArr, date: ts, time, endTime, location: loc.trim(), seats: tables * 4, rsvps, note, waitlist: [], joinCode: joinCode.trim().toUpperCase() }, selectedGroupId);
    } else {
      const dates = previewDates();
      const games = dates.map((ts) => ({
        id: "gm" + uid(),
        title: title.trim(),
        host: myUser.name, hostId: myUid, coHostIds: coHostArr,
        date: ts, time, endTime,
        location: loc.trim(),
        seats: tables * 4, rsvps,
        note,
        waitlist: [],
        recurring: freq,
        joinCode: generateGameCode(),
      }));
      onSave(games, selectedGroupId);
    }
  };

  return (
    <Shell title="Schedule a Game" onBack={onBack} color={effectiveGroup?.color || "#7c3aed"}>
      {!group && (
        <>
          <Lbl>Group (optional)</Lbl>
          <select
            value={selectedGroupId || ""}
            onChange={(e) => { setSelectedGroupId(e.target.value || null); setSelectedIds(new Set()); setCoHostIds(new Set()); }}
            style={{ width: "100%", padding: "10px 12px", borderRadius: 10, border: "1.5px solid var(--border-input)", background: "var(--bg-input)", color: "var(--text-body)", fontSize: 14, fontFamily: "'Inter',sans-serif", marginBottom: 14, outline: "none" }}
          >
            <option value="">No group (standalone)</option>
            {hostedGroups.map(g => <option key={g.id} value={g.id}>{g.emoji} {g.name}</option>)}
          </select>
        </>
      )}
      <Lbl>Game Title</Lbl>
      <Fld value={title} set={setTitle} placeholder="e.g. Weekly Game Night" />
      <Lbl mt>Date</Lbl>
      <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={inputSt} />
      <Lbl mt>Time</Lbl>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#b08090", textTransform: "uppercase", letterSpacing: .5, marginBottom: 6, fontFamily: "'Inter',sans-serif" }}>Start</div>
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)} style={{ ...inputSt, marginBottom: 0 }} />
        </div>
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#b08090", textTransform: "uppercase", letterSpacing: .5, marginBottom: 6, fontFamily: "'Inter',sans-serif" }}>End</div>
          <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} style={{ ...inputSt, marginBottom: 0 }} />
        </div>
      </div>
      <Lbl mt>Location</Lbl>
      <Fld value={loc} set={setLoc} placeholder="e.g. 12 Oak Street" />
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "var(--bg-input)", border: "1.5px solid var(--border-input)", borderRadius: "var(--radius-input)", padding: "10px 14px", marginBottom: 14, marginTop: 10 }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 14, color: "var(--text-body)", fontFamily: "'Inter',sans-serif" }}>Tables</div>
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 1 }}>{tables * 4} seats total</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button onClick={() => setTables((t) => Math.max(1, t - 1))} style={{ width: 32, height: 32, borderRadius: 999, border: `1.5px solid rgba(var(--primary-rgb),0.25)`, background: "var(--bg-card)", fontSize: 18, color: "var(--primary)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700 }}>−</button>
          <span style={{ minWidth: 24, textAlign: "center", fontWeight: 700, fontSize: 16, color: group?.color || "#7c3aed", fontFamily: "'Inter',sans-serif" }}>{tables}</span>
          <button onClick={() => setTables((t) => t + 1)} style={{ width: 32, height: 32, borderRadius: 999, border: `1.5px solid rgba(var(--primary-rgb),0.25)`, background: "var(--bg-card)", fontSize: 18, color: "var(--primary)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700 }}>+</button>
        </div>
      </div>
      <Lbl mt>Host Notes (optional)</Lbl>
      <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Style of play, what to bring, house rules..." rows={3} style={{ ...inputSt, resize: "none", height: "auto", padding: "12px 14px" }} />

      {/* Player picker */}
      {otherMembers.length > 0 && (
        <div style={{ marginTop: 18, marginBottom: 4 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
            <SecLbl>Invite Group Members</SecLbl>
            <button onClick={toggleAll} style={{
              background: allSelected ? `linear-gradient(135deg,${group.color},${group.color}cc)` : "var(--bg-surface)",
              border: allSelected ? "none" : `1.5px solid rgba(var(--primary-rgb),0.25)`,
              borderRadius: 999, padding: "5px 13px", fontSize: 12, fontWeight: 700,
              color: allSelected ? "#fff" : "var(--primary)", cursor: "pointer",
              fontFamily: "'Inter',sans-serif", transition: "all .18s",
              boxShadow: allSelected ? `0 2px 8px ${group.color}44` : "none",
            }}>{allSelected ? "✓ All Selected" : "Select All"}</button>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {otherMembers.map((m) => {
              const selected = selectedIds.has(m.id);
              const isCoHostMember = coHostIds.has(m.id);
              return (
                <div key={m.id} onClick={() => toggleMember(m.id)} style={{
                  display: "flex", alignItems: "center", gap: 10,
                  padding: "11px 14px", borderRadius: 14, cursor: "pointer",
                  transition: "all .18s",
                  background: selected ? `${group.color}14` : "var(--bg-surface)",
                  border: selected ? `1.5px solid ${group.color}55` : "1.5px solid rgba(var(--primary-rgb),0.12)",
                  boxShadow: selected ? `0 2px 10px ${group.color}22` : "none",
                }}>
                  <div style={{
                    width: 38, height: 38, borderRadius: 999, flexShrink: 0,
                    background: avatarBg(m.avatar),
                    display: "flex", alignItems: "center", justifyContent: "center",
                    overflow: "hidden", border: selected ? `1.5px solid ${group.color}44` : "1.5px solid var(--border-card)",
                    transition: "all .18s",
                  }}><AvatarImg av={m.avatar} size={38}/></div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 15, color: "var(--text-body)", fontFamily: "'Inter',sans-serif" }}>{m.name}</div>
                    {isCoHostMember && <div style={{ fontSize: 11, fontWeight: 700, color: "#b8860b", marginTop: 1, fontFamily: "'Inter',sans-serif" }}>👑 Co-host</div>}
                  </div>
                  {selected && (
                    <button
                      onClick={(e) => { e.stopPropagation(); toggleCoHost(m.id); }}
                      title={isCoHostMember ? "Remove co-host" : "Make co-host"}
                      style={{
                        width: 30, height: 30, borderRadius: 9, border: "none", flexShrink: 0, cursor: "pointer",
                        background: isCoHostMember ? "linear-gradient(135deg,#d4a843,#b88a2a)" : "rgba(200,180,190,0.25)",
                        fontSize: 15, display: "flex", alignItems: "center", justifyContent: "center",
                        boxShadow: isCoHostMember ? "0 2px 8px rgba(212,168,67,0.45)" : "none",
                        transition: "all .18s",
                      }}
                    >👑</button>
                  )}
                  <div style={{
                    width: 22, height: 22, borderRadius: 999, flexShrink: 0,
                    background: selected ? `linear-gradient(135deg,${group.color},${group.color}cc)` : "transparent",
                    border: selected ? "none" : `2px solid rgba(var(--primary-rgb),0.2)`,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 12, color: "#fff", fontWeight: 800,
                    transition: "all .18s",
                    boxShadow: selected ? `0 2px 6px ${group.color}44` : "none",
                  }}>{selected ? "✓" : ""}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Recurring toggle */}
      <div style={{ height: 10 }} />
      {(() => {
        const recurringLocked = getPlan(myUser) === "free" && !(planCfg?.limits?.allowRecurring);
        return (
      <div style={{
        background: "linear-gradient(135deg,var(--bg-card),var(--bg-card-alt))",
        backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)",
        borderRadius: 16, padding: "16px", marginBottom: 16,
        border: "1px solid rgba(var(--border-light-rgb),0.4)",
        boxShadow: "0 4px 16px rgba(var(--shadow-rgb),0.07), inset 0 1px 0 var(--shadow-inset)",
        opacity: recurringLocked ? 0.65 : 1,
      }}>
        {/* Toggle row */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 15, color: "var(--text-body)", fontFamily: "'Inter',sans-serif" }}>
              🔁 Recurring Game
              {recurringLocked && <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 700, background: "rgba(var(--primary-rgb),0.1)", color: "var(--primary)", borderRadius: 999, padding: "2px 8px", fontFamily: "'Inter',sans-serif" }}>Paid plan</span>}
            </div>
            <div style={{ fontSize: 13, color: "#b08090", marginTop: 2, fontFamily: "'Inter',sans-serif" }}>
              {recurringLocked ? "Upgrade to schedule repeating sessions" : "Automatically schedule repeating sessions"}
            </div>
          </div>
          {/* Toggle switch */}
          <div onClick={() => !recurringLocked && setRecurring(!recurring)} style={{
            width: 48, height: 27, borderRadius: 999, cursor: "pointer",
            background: recurring ? "var(--active-tab-gradient)" : "rgba(200,180,190,0.4)",
            position: "relative", transition: "background .25s",
            boxShadow: recurring ? "0 2px 10px rgba(var(--shadow-rgb),0.35)" : "none",
            border: "1px solid var(--border-card)",
            flexShrink: 0,
          }}>
            <div style={{
              width: 21, height: 21, borderRadius: 999,
              background: "#fff",
              position: "absolute", top: 2,
              left: recurring ? 24 : 3,
              transition: "left .22s cubic-bezier(.4,0,.2,1)",
              boxShadow: "0 1px 4px rgba(0,0,0,.2)",
            }} />
          </div>
        </div>

        {/* Recurring options — animated expand */}
        {recurring && (
          <div className="sUp" style={{ marginTop: 16 }}>
            <Lbl>Frequency</Lbl>
            <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
              {FREQS.map((f) => (
                <div key={f.id} onClick={() => setFreq(f.id)} style={{
                  flex: 1, minWidth: 90, padding: "10px 8px", borderRadius: 12,
                  textAlign: "center", cursor: "pointer", transition: "all .18s",
                  background: freq === f.id ? `linear-gradient(135deg,${group.color},${group.color}cc)` : "var(--border-card)",
                  color: freq === f.id ? "#fff" : "#7a4a58",
                  border: freq === f.id ? "none" : "1px solid rgba(var(--primary-rgb),0.2)",
                  boxShadow: freq === f.id ? `0 4px 14px ${group.color}44` : "none",
                }}>
                  <div style={{ fontSize: 19, marginBottom: 3 }}>{f.icon}</div>
                  <div style={{ fontSize: 12, fontWeight: 700, fontFamily: "'Inter',sans-serif" }}>{f.label}</div>
                </div>
              ))}
            </div>

            <Lbl>Number of Sessions</Lbl>
            <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
              {[2, 4, 6, 8, 12].map((n) => (
                <div key={n} onClick={() => setOccurrences(n)} style={{
                  width: 44, height: 44, borderRadius: 12,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  cursor: "pointer", fontWeight: 700, fontSize: 15, transition: "all .18s",
                  background: occurrences === n ? `linear-gradient(135deg,${group.color},${group.color}cc)` : "var(--border-card)",
                  color: occurrences === n ? "#fff" : "#7a4a58",
                  border: occurrences === n ? "none" : "1px solid rgba(var(--primary-rgb),0.2)",
                  boxShadow: occurrences === n ? `0 4px 12px ${group.color}44` : "none",
                  fontFamily: "'Inter',sans-serif",
                }}>{n}</div>
              ))}
            </div>

            {/* Preview dates */}
            {date && (
              <div style={{ background: "var(--bg-surface)", borderRadius: 12, padding: "12px 14px", border: "1px solid rgba(var(--border-light-rgb),0.4)" }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "var(--primary-faint)", textTransform: "uppercase", letterSpacing: .5, marginBottom: 8, fontFamily: "'Inter',sans-serif" }}>
                  Preview — {occurrences} sessions
                </div>
                {previewDates().map((ts, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: i < occurrences - 1 ? 6 : 0 }}>
                    <div style={{ width: 20, height: 20, borderRadius: 999, background: `linear-gradient(135deg,${group.color}44,${group.color}22)`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: group.color, flexShrink: 0, fontFamily: "'Inter',sans-serif" }}>{i + 1}</div>
                    <span style={{ fontSize: 14, color: "var(--text-body)", fontFamily: "'Inter',sans-serif" }}>{fmt(ts)} · {fmtT(time)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
        );
      })()}

      {/* Join Code — only for single games */}
      {!recurring && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
            <Lbl>Game Join Code</Lbl>
            <div style={{ fontSize: 12, fontWeight: 700, fontFamily: "'Inter',sans-serif",
              color: codeStatus === "available" ? "#22a722" : codeStatus === "taken" ? "#d94040" : codeStatus === "invalid" ? "#d94040" : "#b08090",
            }}>
              {codeStatus === "available" ? "✓ Available" : codeStatus === "taken" ? "✗ Already in use" : codeStatus === "invalid" ? "✗ Invalid format" : "Checking…"}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={joinCode}
              onChange={(e) => { setJoinCode(e.target.value.toUpperCase()); setCodeStatus("checking"); }}
              onBlur={() => checkCode(joinCode)}
              maxLength={20}
              placeholder="e.g. TUES7PM"
              style={{ ...inputSt, marginBottom: 0, flex: 1, fontFamily: "monospace", fontSize: 17, letterSpacing: 3, fontWeight: 700, textTransform: "uppercase",
                borderColor: codeStatus === "available" ? "#22a72244" : codeStatus === "taken" || codeStatus === "invalid" ? "#d9404044" : undefined,
              }}
            />
            <button
              onClick={() => { const c = generateGameCode(); setJoinCode(c); checkCode(c); }}
              title="Generate new code"
              style={{ width: 44, height: 44, borderRadius: "var(--radius-input)", border: `1.5px solid rgba(var(--primary-rgb),0.25)`, background: "var(--bg-card)", fontSize: 18, color: "var(--primary)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}
            >🔄</button>
          </div>
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 6, fontFamily: "'Inter',sans-serif" }}>
            Letters, numbers, _ and − allowed · 3–20 characters
          </div>
        </div>
      )}

      <Btn full disabled={!ok} onClick={handleSave}>
        {recurring ? `🔁 Schedule ${occurrences} Games` : "🀄 Schedule Game"}
      </Btn>
    </Shell>
  );
}

/* GUEST GAME VIEW — fetches game + group directly, no listener dependency */
/* ── STANDALONE GAME VIEW (host or invited guest — no group context) ── */
function StandaloneGameView({ uid, gameId, go, flash, user, unreadCounts = {} }) {
  const [game, setGame] = useState(null);
  const [view, setView] = useState("game"); // "game" | "edit" | "invite"

  useEffect(() => {
    const unsub = onSnapshot(doc(db, "games", gameId), (snap) => {
      if (!snap.exists()) return;
      setGame({ ...snap.data(), id: snap.id });
    });
    return unsub;
  }, [gameId]);

  if (!game) return (
    <div style={{ minHeight: "100%", background: "linear-gradient(170deg,var(--bg-shell-start) 0%,var(--bg-shell-mid) 40%,var(--bg-shell-end) 100%)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12 }}>
      <div style={{ fontSize: 41 }}>🀄</div>
      <div style={{ fontFamily: "'Inter',sans-serif", fontSize: 17, color: "var(--primary-muted)" }}>Loading game…</div>
    </div>
  );

  const isHost = game.hostId === uid;
  // Stub group so the Game component works — host is always in members with host: true
  const stubGroup = { id: null, name: "Open Game", color: "#7c3aed", emoji: "🀄", members: isHost ? [{ id: uid, name: user?.name || "Host", avatar: user?.avatar || "🀄", host: true }] : [], openInvites: true, games: [game] };

  // Intercept game-level navigation that requires a real group — handle inline instead
  const wrappedGo = (page, g, gm) => {
    if (page === "editGame" && isHost) { setView("edit"); return; }
    if (page === "invite" && isHost) { setView("invite"); return; }
    go(page, g, gm);
  };

  if (view === "edit" && isHost) {
    return (
      <EditGame uid={uid} game={game} group={stubGroup}
        onBack={() => setView("game")}
        onSave={async (updated) => {
          const { id: gid, ...data } = updated;
          try {
            const oldCode = game.joinCode || null;
            const newCode = data.joinCode || null;
            if (newCode !== oldCode) {
              const batch = writeBatch(db);
              batch.update(doc(db, "games", gid), data);
              if (oldCode) batch.delete(doc(db, "gameCodes", oldCode));
              if (newCode) batch.set(doc(db, "gameCodes", newCode), { groupId: null, gameId: gid, date: data.date });
              await batch.commit();
            } else {
              await updateDoc(doc(db, "games", gid), data);
            }
            setView("game"); flash("Game updated!", "✨");
          } catch { flash("Error updating game", "❌"); }
        }}
        onTransferHost={null}
      />
    );
  }

  if (view === "invite" && isHost) {
    return <Invite group={stubGroup} game={game} flash={flash} onBack={() => setView("game")} />;
  }

  return (
    <Game uid={uid} game={game} group={stubGroup} go={wrappedGo} isGuestView={!isHost} unreadCounts={unreadCounts}
      onRsvp={async (ans) => {
        try {
          await updateDoc(doc(db, "games", gameId), { [`rsvps.${uid}`]: ans });
          flash(ans === "yes" ? "You're in!" : "Got it", ans === "yes" ? "🎉" : "👍");
        } catch { flash("Error updating RSVP", "❌"); }
      }}
      onWaitlist={async (action) => {
        try {
          await updateDoc(doc(db, "games", gameId), {
            waitlist: action === "join" ? arrayUnion(uid) : arrayRemove(uid),
          });
          flash(action === "join" ? "Added to waitlist!" : "Removed from waitlist", action === "join" ? "⏳" : "👋");
        } catch { flash("Error updating waitlist", "❌"); }
      }}
      onArchive={isHost ? async () => {
        try {
          await updateDoc(doc(db, "games", gameId), { status: "archived" });
          go("home"); flash("Game cancelled", "📦");
        } catch { flash("Error cancelling game", "❌"); }
      } : null}
      onLeave={!isHost ? async () => {
        try {
          await updateDoc(doc(db, "games", gameId), {
            [`rsvps.${uid}`]: deleteField(),
            guestIds: arrayRemove(uid),
            waitlist: arrayRemove(uid),
            registeredGuests: (game.registeredGuests || []).filter(g => g.id !== uid),
          });
          await updateDoc(doc(db, "users", uid), { guestGameRefs: arrayRemove({ groupId: null, gameId }) });
          go("home"); flash("You've left the game", "👋");
        } catch { flash("Error leaving game", "❌"); }
      } : null}
      onSaveWinner={isHost ? async (winner) => {
        await updateDoc(doc(db, "games", gameId), { winner });
        flash("Winner saved!", "🏆");
      } : null}
    />
  );
}

function GuestGameView({ uid, user, groupId, gameId, go, flash, unreadCounts = {} }) {
  const [game, setGame] = useState(null);
  const [groupMeta, setGroupMeta] = useState(null);

  useEffect(() => {
    const unsub = onSnapshot(doc(db, "groups", groupId, "games", gameId), async (snap) => {
      if (!snap.exists()) return;
      setGame({ ...snap.data(), id: snap.id });
    });
    getDoc(doc(db, "groups", groupId)).then((gs) => {
      if (gs.exists()) {
        const d = gs.data();
        setGroupMeta({ id: groupId, name: d.name, color: d.color, emoji: d.emoji, members: d.members || [], openInvites: false, games: [] });
      }
    }).catch(() => {});
    return unsub;
  }, [groupId, gameId]);

  if (!game || !groupMeta) return (
    <div style={{ minHeight: "100%", background: "linear-gradient(170deg,var(--bg-shell-start) 0%,var(--bg-shell-mid) 40%,var(--bg-shell-end) 100%)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12 }}>
      <div style={{ fontSize: 41 }}>🀄</div>
      <div style={{ fontFamily: "'Inter',sans-serif", fontSize: 17, color: "var(--primary-muted)" }}>Loading game…</div>
    </div>
  );

  return (
    <Game uid={uid} user={user} game={game} group={groupMeta} go={go} isGuestView unreadCounts={unreadCounts}
      onRsvp={async (ans) => {
        try {
          await updateDoc(doc(db, "groups", groupId, "games", gameId), { [`rsvps.${uid}`]: ans });
          flash(ans === "yes" ? "You're in!" : "Got it", ans === "yes" ? "🎉" : "👍");
        } catch { flash("Error updating RSVP", "❌"); }
      }}
      onWaitlist={async (action) => {
        try {
          await updateDoc(doc(db, "groups", groupId, "games", gameId), {
            waitlist: action === "join" ? arrayUnion(uid) : arrayRemove(uid),
          });
          flash(action === "join" ? "Added to waitlist!" : "Removed from waitlist", action === "join" ? "⏳" : "👋");
        } catch { flash("Error updating waitlist", "❌"); }
      }}
      onArchive={null}
      onLeave={async () => {
        try {
          const ref = doc(db, "groups", groupId, "games", gameId);
          await updateDoc(ref, {
            [`rsvps.${uid}`]: deleteField(),
            guestIds: arrayRemove(uid),
            waitlist: arrayRemove(uid),
            registeredGuests: (game.registeredGuests || []).filter(g => g.id !== uid),
          });
          await updateDoc(doc(db, "users", uid), { guestGameRefs: arrayRemove({ groupId, gameId }) });
          go("home"); flash("You've left the game", "👋");
        } catch { flash("Error leaving game", "❌"); }
      }}
    />
  );
}

/* ── SEATING ALGORITHM ── */
function generateSeating(playerIds, skillMap, tableSize = 4) {
  const RANK = { Advanced: 3, Intermediate: 2, Beginner: 1 };
  const rank = (id) => RANK[skillMap[id]] ?? 2; // unknown → treat as Intermediate
  const shuffle = (a) => {
    const b = [...a];
    for (let i = b.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [b[i], b[j]] = [b[j], b[i]];
    }
    return b;
  };
  // Group by rank so similar-skill players end up at the same table, shuffle within each group
  const sorted = [3, 2, 1].flatMap(r => shuffle(playerIds.filter(id => rank(id) === r)));
  const n = Math.max(1, Math.ceil(playerIds.length / tableSize));
  const tables = Array.from({ length: n }, (_, i) => sorted.slice(i * tableSize, (i + 1) * tableSize));
  // Rule: never seat a Beginner at a table where 3+ players are Advanced
  for (let ti = 0; ti < tables.length; ti++) {
    if (tables[ti].filter(id => rank(id) === 3).length < 3) continue;
    const bi = tables[ti].findIndex(id => rank(id) === 1);
    if (bi < 0) continue;
    // Swap the beginner with a non-advanced player from a safer table
    for (let tj = 0; tj < tables.length; tj++) {
      if (tj === ti) continue;
      const si = tables[tj].findIndex(id => rank(id) !== 3);
      if (si >= 0 && tables[tj].filter(id => rank(id) === 3).length < 3) {
        [tables[ti][bi], tables[tj][si]] = [tables[tj][si], tables[ti][bi]];
        break;
      }
    }
  }
  return tables;
}

/* GAME DETAIL — redesigned per spec */
function Game({ uid, user, game, group, go, onRsvp, onWaitlist, onArchive, onLeave, onBack, onSaveWinner, isGuestView = false, unreadCounts = {} }) {
  // ── Design tokens — mapped to active theme CSS variables ────────────────
  // Going / positive action
  const J9  = "var(--text-heading)";
  const J5  = "var(--secondary-accent)";          // "going" pip, progress bar, confirm buttons
  const J1  = "rgba(var(--primary-rgb),0.10)";    // light tint for going pips / tally cells
  // Warning / emphasis (used for "out", host badge, open-seat count)
  const CL7 = "var(--primary)";
  const CL1 = "rgba(var(--primary-rgb),0.10)";
  // Maybe — semantic bamboo amber (fixed status-indicator colour like yellow in a traffic light;
  // doesn't clash with any theme's palette and stays visually distinct from Going/Out)
  const BM7 = "#8a6b3a";
  const BM5 = "#d6a64a";
  const BM1 = "#f5ecd8";
  // Surfaces
  const IV1 = "var(--bg-card-base)";              // card backgrounds only — not text
  const IV2 = "linear-gradient(170deg,var(--bg-shell-start) 0%,var(--bg-shell-mid) 40%,var(--bg-shell-end) 100%)";
  const IV3 = "var(--bg-surface)";
  // Text
  const TXT2 = "var(--text-muted)";
  const TXT3 = "var(--text-subtle)";
  // Borders / shadows
  const BDS = "var(--border-card)";
  const BDD = "var(--border-input)";
  const SHD = "0 4px 16px rgba(var(--shadow-rgb),0.08),inset 0 1px 0 var(--shadow-inset)";
  const FD  = "'DM Serif Display',Georgia,serif";
  const FU  = "'Geist',system-ui,sans-serif";
  const card = { background: IV1, borderRadius: 18, padding: "16px", boxShadow: SHD, border: `1px solid ${BDS}` };
  const iconBtn = { width:38,height:38,borderRadius:12,background:"rgba(255,255,255,0.12)",border:"1px solid rgba(255,255,255,0.18)",backdropFilter:"blur(6px)",WebkitBackdropFilter:"blur(6px)",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",color:"#fff",fontSize:16,flexShrink:0 };

  // ── State ────────────────────────────────────────────────────────────────
  const [rsvpFilter, setRsvpFilter] = useState("yes");
  const [rsvpExpanded, setRsvpExpanded] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [winnerPickerOpen, setWinnerPickerOpen] = useState(false);
  const [savingWinner, setSavingWinner] = useState(false);
  const [seatingOpen, setSeatingOpen] = useState(false);
  const [seating, setSeating] = useState(() => {
    const raw = game.seating;
    if (!raw || !raw.length) return null;
    return raw.map(t => (Array.isArray(t) ? t : (t.players || [])));
  });
  const [movingUid, setMovingUid] = useState(null);
  const [skillMap, setSkillMap] = useState({});
  const [seatingLoading, setSeatingLoading] = useState(false);
  const [confirmReRandomize, setConfirmReRandomize] = useState(false);
  const [gameChatOpen, setGameChatOpen] = useState(false);

  // Load display fonts
  useEffect(() => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=Geist:wght@400;500;600;700&display=swap";
    document.head.appendChild(link);
    return () => { try { document.head.removeChild(link); } catch {} };
  }, []);

  // Self-heal: ensure the gameCodes index document exists whenever the host opens a game
  useEffect(() => {
    if (!isHost || !game.joinCode || !game.id) return;
    const codeRef = doc(db, "gameCodes", game.joinCode);
    getDoc(codeRef).then(snap => {
      if (!snap.exists()) {
        setDoc(codeRef, { groupId: group.id || null, gameId: game.id, date: game.date || null }).catch(() => {});
      }
    }).catch(() => {});
  }, [game.id]);

  // ── Computed ────────────────────────────────────────────────────────────
  const isCoHost = !isGuestView && (game.coHostIds || []).includes(uid);
  const isHost = !isGuestView && (game.hostId === uid || isCoHost);
  // Allow invite for group games (group.id truthy) and standalone games where the user is host (join code exists)
  const canInvite = !isGuestView && (!!group.id || (isHost && !!game.joinCode));
  const myRsvp = game.rsvps[uid] || "pending";
  const past = game.date < startOfTodayInTz(user?.timezone);
  const gameUnread = (game.status !== "archived" && !past) ? (unreadCounts[game.id] || 0) : 0;
  const allGuests = game.guests || [];
  const registeredGuests = game.registeredGuests || [];
  const rawWaitlist = game.waitlist || [];
  const onWaitlistMe = rawWaitlist.includes(uid);
  const confirmedGuests = allGuests.filter(g => !rawWaitlist.includes(g.id));
  const yesCount = Object.values(game.rsvps).filter(v => v === "yes").length;
  const maybeCount = Object.values(game.rsvps).filter(v => v === "maybe").length;
  const noCount = Object.values(game.rsvps).filter(v => v === "no").length;
  const filledSeats = yesCount + confirmedGuests.length;
  const totalSeats = game.seats || 4;
  const isFull = filledSeats >= totalSeats;
  const seatsLeft = Math.max(0, totalSeats - filledSeats);

  const playerLookup = {};
  group.members.forEach(m => { playerLookup[m.id] = { name: m.name, avatar: m.avatar }; });
  allGuests.forEach(g => { playerLookup[g.id] = { name: g.name, avatar: g.avatar }; });
  registeredGuests.forEach(g => { playerLookup[g.id] = { name: g.name, avatar: g.avatar }; });

  const resolveName = (id) => {
    const m = group.members.find(m => m.id === id);
    if (m) return { name: m.name, avatar: m.avatar };
    // Registered guests joined via invite link / QR / game code — real app users, no "Guest" badge
    const rg = registeredGuests.find(g => g.id === id);
    if (rg) return { name: rg.name, avatar: rg.avatar };
    if ((game.guestIds || []).includes(id)) return { name: "Guest", avatar: "👤" };
    // Manual guests added by host with no app account — show "Guest" badge
    const g = allGuests.find(g => g.id === id);
    if (g) return { name: g.name, avatar: g.avatar, isGuest: true };
    return null;
  };

  const goingUids = Object.entries(game.rsvps || {}).filter(([,v]) => v === "yes").map(([id]) => id);
  const seatingPool = [...goingUids, ...confirmedGuests.map(g => g.id)];
  const SKILL_ICON = { Advanced: "🏆", Intermediate: "🀄", Beginner: "🌱" };

  useEffect(() => {
    if (!seatingOpen || !isHost) return;
    const missing = goingUids.filter(id => !(id in skillMap));
    if (!missing.length) return;
    setSeatingLoading(true);
    Promise.all(missing.map(id => getDoc(doc(db, "users", id))))
      .then(snaps => { const u = {}; snaps.forEach((s,i) => { u[missing[i]] = s.data()?.skillLevel ?? null; }); setSkillMap(p => ({...p,...u})); })
      .finally(() => setSeatingLoading(false));
  }, [seatingOpen]);

  const saveSeating = async (next) => {
    setSeating(next);
    try { await updateDoc(doc(db, "groups", group.id, "games", game.id), { seating: next.map(t => ({ players: t })) }); } catch (e) { console.error("saveSeating:", e); }
  };
  const doRandomize = () => { saveSeating(generateSeating(seatingPool, skillMap)); setMovingUid(null); setConfirmReRandomize(false); };
  const handleRandomize = () => { if (seating) { setConfirmReRandomize(true); return; } doRandomize(); };
  const handlePlayerTap = (pid) => {
    if (!movingUid) { setMovingUid(pid); return; }
    if (movingUid === pid) { setMovingUid(null); return; }
    const next = seating.map(t => [...t]);
    let [fi,fj,ti,tj] = [-1,-1,-1,-1];
    for (let r = 0; r < next.length; r++) {
      const mi = next[r].indexOf(movingUid); if (mi >= 0) { fi=r; fj=mi; }
      const pi = next[r].indexOf(pid); if (pi >= 0) { ti=r; tj=pi; }
    }
    if (fi >= 0 && ti >= 0) { next[fi][fj]=pid; next[ti][tj]=movingUid; saveSeating(next); }
    setMovingUid(null);
  };

  // Player lists for RSVP display
  const goingList = [
    ...goingUids.map(id => { const r = resolveName(id); return r ? { id, ...r } : null; }).filter(Boolean),
    ...confirmedGuests.map(g => ({ ...g, isGuest: true })),
  ];
  const maybeList = Object.entries(game.rsvps).filter(([,v]) => v === "maybe").map(([id]) => { const r = resolveName(id); return r ? { id, ...r } : null; }).filter(Boolean);
  const noList   = Object.entries(game.rsvps).filter(([,v]) => v === "no").map(([id])   => { const r = resolveName(id); return r ? { id, ...r } : null; }).filter(Boolean);
  const waitlistList = rawWaitlist.map(id => {
    const g = allGuests.find(g => g.id === id); if (g) return { id, name: g.name, avatar: g.avatar, isGuest: true };
    const m = group.members.find(m => m.id === id); if (m) return { id, name: m.name, avatar: m.avatar };
    return null;
  }).filter(Boolean);

  // Stack players — going only (maybes/outs live in the tally grid below)
  const stackPlayers = goingList.map(p => ({ id: p.id, name: p.name, state: "in" }));

  const hostInitials = (game.host || "H").split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
  const { googleUrl } = buildCalendarLinks(game, group.name);

  return (
    <>
    <div style={{ minHeight: "100%", background: IV2, fontFamily: FU }}>

      {/* ── HEADER ──────────────────────────────────────────────────────── */}
      <div style={{ background: "var(--header-gradient2)", padding: `${HEADER_BTN_TOP}px 16px 22px`, position: "relative", overflow: "hidden" }}>
        {/* Decorative tile */}
        <div style={{ position: "absolute", top: -10, right: -22, fontSize: 130, opacity: 0.1, transform: "rotate(14deg)", pointerEvents: "none", userSelect: "none", lineHeight: 1 }}>🀄</div>

        {/* Row 1 — actions */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", position: "relative", zIndex: 1 }}>
          <button onClick={() => onBack ? onBack() : (isGuestView ? go("home") : go("games"))} aria-label="Back" style={{ background: "none", border: "none", color: "rgba(255,255,255,0.85)", display: "flex", alignItems: "center", gap: 2, padding: "8px 12px 8px 6px", marginLeft: -4, cursor: "pointer", fontFamily: FU, fontSize: 14, fontWeight: 500 }}>
            ‹ Games
          </button>
          <div style={{ display: "flex", gap: 8 }}>
            {isHost && <button onClick={() => go("editGame", group.id, game.id)} aria-label="Edit" style={iconBtn}>✏️</button>}
            <button onClick={() => setGameChatOpen(true)} aria-label="Game chat" style={{ ...iconBtn, position: "relative" }}>💬<Badge count={gameUnread} /></button>
            {canInvite && <button onClick={() => go("invite", group.id, game.id)} aria-label="Invite" style={iconBtn}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg></button>}
          </div>
        </div>

        {/* Row 2 — title */}
        <h1 style={{ fontFamily: FD, fontSize: 32, lineHeight: 1.05, letterSpacing: -0.4, color: "#fff", marginTop: 14, position: "relative", zIndex: 1 }}>
          {game.title}
        </h1>

        {/* Row 3 — info strip */}
        <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 5, position: "relative", zIndex: 1 }}>
          <div style={{ fontSize: 13, color: "rgba(255,255,255,0.85)", fontFamily: FU }}>
            📅 {fmt(game.date)}{game.time ? ` · ${fmtT(game.time)}` : ""}{game.endTime ? ` – ${fmtT(game.endTime)}` : ""}
          </div>
          {game.location && (
            <div style={{ fontSize: 13, color: "rgba(255,255,255,0.70)", fontFamily: FU, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>📍 {game.location}</span>
              <button onClick={() => { window.location.href = Capacitor.getPlatform() === "ios" ? `maps://maps.apple.com/?q=${encodeURIComponent(game.location)}` : `https://maps.google.com/?q=${encodeURIComponent(game.location)}`; }} style={{ padding: "3px 9px", borderRadius: 999, background: "rgba(255,255,255,0.12)", border: "1px solid rgba(255,255,255,0.18)", color: "rgba(255,255,255,0.85)", fontSize: 11, fontWeight: 600, fontFamily: FU, cursor: "pointer", flexShrink: 0 }}>
                Directions
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ── CARDS ───────────────────────────────────────────────────────── */}
      <div style={{ padding: "14px 16px 130px", display: "flex", flexDirection: "column", gap: 12 }}>

        {/* a. Hosting card */}
        {isHost && (
          <div style={{ ...card, background: `linear-gradient(180deg,${IV1} 0%,var(--bg-card-alt) 100%)` }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ width: 32, height: 32, borderRadius: 10, background: "var(--active-tab-gradient)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, color: "#fff", flexShrink: 0 }}>★</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontFamily: FD, fontSize: 16, color: J9 }}>You're hosting</div>
                <div style={{ fontFamily: FU, fontSize: 12, color: TXT2, marginTop: 2, lineHeight: 1.4 }}>
                  {isCoHost && game.hostId !== uid ? "Co-host — always going. Host manages players in Edit." : "Always going. Step down via Edit → Players."}
                </div>
              </div>
              <span style={{ fontFamily: FU, fontSize: 11, fontWeight: 700, color: J5, background: J1, borderRadius: 999, padding: "4px 10px", flexShrink: 0, border: `1px solid rgba(var(--primary-rgb),0.15)` }}>
                {isCoHost && game.hostId !== uid ? "Co-host" : "Hosting"}
              </span>
            </div>
          </div>
        )}

        {/* b. Host + Seats card */}
        <div style={card}>
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <div style={{ position: "relative", flexShrink: 0 }}>
              <div style={{ width: 44, height: 44, borderRadius: 12, background: "var(--active-tab-gradient)", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FD, fontSize: 18, color: "#fff" }}>{hostInitials}</div>
              <div style={{ position: "absolute", bottom: -2, right: -2, width: 18, height: 18, borderRadius: 9, background: CL7, border: `2px solid ${IV1}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, color: "#fff", fontWeight: 700 }}>★</div>
            </div>
            <div>
              <div style={{ fontFamily: FU, fontSize: 10, fontWeight: 600, color: CL7, textTransform: "uppercase", letterSpacing: 1.2 }}>Hosted by</div>
              <div style={{ fontFamily: FD, fontSize: 18, color: J9, marginTop: 1 }}>{game.host}</div>
            </div>
          </div>
          <div style={{ marginTop: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
              <span style={{ fontFamily: FU, fontSize: 13, fontWeight: 500, color: TXT2 }}>Seats</span>
              <span style={{ fontFamily: FU, fontSize: 12 }}>
                <span style={{ fontWeight: 700, color: J5 }}>{filledSeats}</span>
                <span style={{ color: TXT3 }}> / {totalSeats} filled · </span>
                {seatsLeft > 0 ? <span style={{ fontWeight: 700, color: CL7 }}>{seatsLeft} open</span> : <span style={{ fontWeight: 700, color: J5 }}>Full</span>}
              </span>
            </div>
            <div style={{ display: "flex", gap: 4 }}>
              {Array.from({ length: totalSeats }).map((_,i) => (
                <div key={i} style={{ flex: 1, height: 8, borderRadius: 4, background: i < filledSeats ? J5 : IV3, border: i < filledSeats ? "none" : `1px solid ${BDD}` }} />
              ))}
            </div>
          </div>
          {isFull && waitlistList.length > 0 && (
            <div style={{ marginTop: 10, fontSize: 12, color: CL7, fontFamily: FU, fontWeight: 600 }}>
              🀄 Full · {waitlistList.length} on waitlist
            </div>
          )}
        </div>

        {/* c. Host Notes */}
        {!!game.note && (
          <div style={card}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
              <span style={{ fontSize: 12 }}>📝</span>
              <span style={{ fontFamily: FU, fontSize: 10, fontWeight: 600, color: CL7, textTransform: "uppercase", letterSpacing: 1.2 }}>Host Notes</span>
            </div>
            <div style={{ fontFamily: FU, fontSize: 14, color: J9, lineHeight: 1.45 }}>{game.note}</div>
          </div>
        )}

        {/* d. Who's in + RSVP */}
        <div style={card}>
          {/* Header row with expand toggle */}
          <button onClick={() => setRsvpExpanded(v => !v)} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", background: "none", border: "none", padding: 0, marginBottom: 12, cursor: "pointer" }}>
            <span style={{ fontFamily: FD, fontSize: 18, color: J9 }}>Who's in</span>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={TXT2} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
              style={{ transition: "transform .2s", transform: rsvpExpanded ? "rotate(180deg)" : "rotate(0deg)", flexShrink: 0 }}>
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
          {/* Avatar stack — going only; tally grid below carries the maybe/out story */}
          <div style={{ marginBottom: 14 }}>
            <RsvpStack players={stackPlayers} max={5} size={30} onClick={() => { setRsvpFilter("yes"); setRsvpExpanded(true); }} />
          </div>
          {/* Tally — clickable filter tabs; tapping one expands the list */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
            {[
              { key: "yes",   label: "Going", count: yesCount + confirmedGuests.length,
                idleBg: "rgba(var(--primary-rgb),0.10)", activeBg: "rgba(var(--primary-rgb),0.20)",
                border: J5, color: J5 },
              { key: "maybe", label: "Maybe", count: maybeCount,
                idleBg: "rgba(217,119,6,0.10)", activeBg: "rgba(217,119,6,0.20)",
                border: BM7, color: BM7 },
              { key: "no",    label: "Out",   count: noCount,
                idleBg: "rgba(156,163,175,0.14)", activeBg: "rgba(156,163,175,0.28)",
                border: "#9ca3af", color: "#6b7280" },
            ].map(({ key, label, count, idleBg, activeBg, border, color }) => {
              const active = rsvpFilter === key;
              return (
                <button key={key} onClick={() => { setRsvpFilter(key); setRsvpExpanded(true); }} style={{
                  padding: "8px 10px", borderRadius: 10, textAlign: "center", cursor: "pointer",
                  background: active ? activeBg : idleBg,
                  border: active ? `1.5px solid ${border}` : "1.5px solid transparent",
                  transition: "all .15s",
                }}>
                  <div style={{ fontFamily: FD, fontSize: 20, color }}>{count}</div>
                  <div style={{ fontFamily: FU, fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color, opacity: active ? 1 : 0.7, marginTop: 2 }}>{label}</div>
                </button>
              );
            })}
          </div>
          {/* Filtered attendee list — only shown when expanded */}
          {rsvpExpanded && (() => {
            const list = rsvpFilter === "yes" ? goingList : rsvpFilter === "maybe" ? maybeList : noList;
            if (list.length === 0) return (
              <div style={{ marginTop: 12, borderTop: `1px solid ${BDS}`, paddingTop: 10 }}>
                <span style={{ fontFamily: FU, fontSize: 13, color: TXT3 }}>No one yet.</span>
              </div>
            );
            return (
              <div style={{ marginTop: 12, borderTop: `1px solid ${BDS}`, paddingTop: 10 }}>
                {list.map(p => (
                  <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 9, padding: "5px 0", opacity: rsvpFilter === "no" ? 0.75 : 1 }}>
                    <span style={{ fontSize: 18 }}>{p.avatar}</span>
                    <span style={{ fontFamily: FU, fontSize: 14, fontWeight: 600, color: J9, flex: 1 }}>{p.name}</span>
                    {p.id === game.hostId && <span style={{ fontFamily: FU, fontSize: 11, fontWeight: 700, color: BM7, background: BM1, borderRadius: 999, padding: "2px 8px" }}>Host</span>}
                    {(game.coHostIds||[]).includes(p.id) && <span style={{ fontFamily: FU, fontSize: 11, fontWeight: 700, color: BM7, background: BM1, borderRadius: 999, padding: "2px 8px" }}>Co-host</span>}
                    {p.isGuest && <span style={{ fontFamily: FU, fontSize: 11, fontWeight: 700, color: TXT2, background: IV3, borderRadius: 999, padding: "2px 8px" }}>Guest</span>}
                    {rsvpFilter === "maybe" && <span style={{ fontFamily: FU, fontSize: 11, fontWeight: 700, color: BM7, background: BM1, borderRadius: 999, padding: "2px 8px" }}>Maybe</span>}
                    {p.id === uid && <span style={{ fontFamily: FU, fontSize: 11, fontWeight: 700, color: J5, background: J1, borderRadius: 999, padding: "2px 8px" }}>You</span>}
                  </div>
                ))}
              </div>
            );
          })()}
        </div>

        {/* Winner card — past games */}
        {past && onSaveWinner && (
          <div style={card}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: (game.winner && !winnerPickerOpen) ? 12 : 0 }}>
              <div style={{ width: 36, height: 36, borderRadius: 10, background: IV3, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, flexShrink: 0 }}>🏆</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontFamily: FD, fontSize: 17, color: J9 }}>Winner</div>
                {!game.winner && !winnerPickerOpen && <div style={{ fontFamily: FU, fontSize: 12, color: TXT3, marginTop: 2 }}>No winner recorded yet</div>}
              </div>
              {isHost && !winnerPickerOpen && (
                <button onClick={() => setWinnerPickerOpen(true)} style={{ padding: "5px 12px", borderRadius: 999, background: J1, border: `1px solid rgba(var(--primary-rgb),0.2)`, color: J5, fontFamily: FU, fontSize: 12, fontWeight: 700, cursor: "pointer", flexShrink: 0 }}>
                  {game.winner ? "Change" : "Select"}
                </button>
              )}
            </div>
            {game.winner && !winnerPickerOpen && (
              <div style={{ display: "flex", alignItems: "center", gap: 12, background: J1, borderRadius: 12, padding: "10px 14px" }}>
                <div style={{ width:32,height:32,borderRadius:999,background:avatarBg(game.winner.avatar),overflow:"hidden",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0 }}>{game.winner.avatar ? <AvatarImg av={game.winner.avatar} size={32}/> : <span style={{fontSize:18}}>🏆</span>}</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontFamily: FD, fontSize: 18, color: J9 }}>
                    {game.winner.uid === uid ? "You" : (game.winner.name || "").split(" ")[0]}
                  </div>
                  <div style={{ fontFamily: FU, fontSize: 11, fontWeight: 700, color: J5, textTransform: "uppercase", letterSpacing: 1 }}>Winner</div>
                </div>
                <span style={{ fontSize: 22 }}>🏆</span>
              </div>
            )}
            {winnerPickerOpen && isHost && (
              <div style={{ marginTop: 12 }}>
                <div style={{ fontFamily: FU, fontSize: 12, color: TXT2, marginBottom: 10 }}>Select the winner from players who attended:</div>
                {goingList.length === 0 && (
                  <div style={{ fontFamily: FU, fontSize: 13, color: TXT3, textAlign: "center", padding: "8px 0" }}>No confirmed players found.</div>
                )}
                {goingList.map(p => (
                  <button key={p.id} disabled={savingWinner} onClick={async () => {
                    setSavingWinner(true);
                    try { await onSaveWinner({ uid: p.id, name: p.name, avatar: p.avatar || "👤" }); setWinnerPickerOpen(false); } catch {}
                    setSavingWinner(false);
                  }} style={{
                    display: "flex", alignItems: "center", gap: 10, width: "100%",
                    padding: "10px 12px", marginBottom: 6, borderRadius: 12,
                    background: game.winner?.uid === p.id ? J1 : IV3,
                    border: game.winner?.uid === p.id ? `1.5px solid ${J5}` : `1px solid ${BDS}`,
                    cursor: savingWinner ? "default" : "pointer", textAlign: "left",
                  }}>
                    <span style={{ fontSize: 20, flexShrink: 0 }}>{p.avatar || "👤"}</span>
                    <span style={{ fontFamily: FU, fontSize: 14, fontWeight: 600, color: J9, flex: 1 }}>
                      {p.id === uid ? "You" : p.name}
                    </span>
                    {game.winner?.uid === p.id && <span style={{ fontFamily: FU, fontSize: 11, fontWeight: 700, color: J5 }}>Current</span>}
                  </button>
                ))}
                <button onClick={() => setWinnerPickerOpen(false)} style={{ width: "100%", padding: "10px", borderRadius: 12, border: `1px solid ${BDS}`, background: "none", color: TXT2, fontFamily: FU, fontSize: 13, fontWeight: 600, cursor: "pointer", marginTop: 4 }}>
                  Cancel
                </button>
              </div>
            )}
          </div>
        )}

        {/* Your RSVP (non-hosts only, future games) */}
        {!past && !isHost && (
          <div style={card}>
            <div style={{ fontFamily: FD, fontSize: 18, color: J9, marginBottom: 12 }}>Your RSVP</div>
            {isFull && myRsvp !== "yes" ? (
              <div>
                <div style={{ fontFamily: FU, fontSize: 13, color: TXT2, marginBottom: 12, lineHeight: 1.6 }}>
                  This game is full. {onWaitlistMe ? "You're on the waitlist — we'll notify you if a spot opens. 🌸" : "Join the waitlist to be notified when a spot opens."}
                </div>
                <button onClick={() => onWaitlist(onWaitlistMe ? "leave" : "join")} style={{ width: "100%", padding: "11px 0", borderRadius: 12, fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: FU, border: "none", background: onWaitlistMe ? J1 : J5, color: onWaitlistMe ? J5 : "#fff" }}>
                  {onWaitlistMe ? "✕ Leave Waitlist" : "⏳ Join Waitlist"}
                </button>
              </div>
            ) : (
              <div style={{ display: "flex", gap: 8 }}>
                {[{v:"yes",label:"✓ Going",bg:J5,tint:J1,text:J5},{v:"maybe",label:"? Maybe",bg:BM5,tint:BM1,text:BM7},{v:"no",label:"✕ Can't",bg:CL7,tint:CL1,text:CL7}].map(({v,label,bg,tint,text}) => (
                  <button key={v} onClick={() => onRsvp(v)} style={{ flex: 1, padding: "10px 4px", borderRadius: 12, fontSize: 13, fontWeight: 700, background: myRsvp === v ? bg : tint, color: myRsvp === v ? "#fff" : text, border: "none", cursor: "pointer", fontFamily: FU, transition: "all .18s" }}>{label}</button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* e. Table Seating */}
        {(isHost || (!isGuestView && seating)) && (
          <div style={{ ...card, padding: 0, overflow: "hidden" }}>
            <div onClick={() => setSeatingOpen(v => !v)} style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", cursor: "pointer", userSelect: "none" }}>
              <div style={{ width: 36, height: 36, borderRadius: 10, background: IV3, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, flexShrink: 0 }}>🀄</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontFamily: FD, fontSize: 17, color: J9 }}>Table seating</div>
                <div style={{ fontFamily: FU, fontSize: 12, color: TXT3, marginTop: 1 }}>{seating ? `${seating.length} table${seating.length !== 1 ? "s" : ""} assigned` : "Not assigned yet"}</div>
              </div>
              {seating && <span style={{ fontFamily: FU, fontSize: 11, fontWeight: 600, color: J5, background: J1, borderRadius: 999, padding: "3px 9px" }}>Assigned</span>}
              <span style={{ fontSize: 14, color: TXT3, transform: seatingOpen ? "rotate(180deg)" : "none", transition: "transform .2s", flexShrink: 0 }}>⌄</span>
            </div>
            {seatingOpen && (
              <div style={{ borderTop: `1px solid ${BDS}`, padding: "12px 16px 16px" }}>
                {isHost && (
                  <>
                    {movingUid && (
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: J1, border: `1px solid ${BDD}`, borderRadius: 10, padding: "8px 12px", marginBottom: 12 }}>
                        <span style={{ fontSize: 13, fontWeight: 700, color: J5, fontFamily: FU }}>Tap a player to swap with {playerLookup[movingUid]?.name || "…"}</span>
                        <button onClick={() => setMovingUid(null)} style={{ background: "none", border: "none", fontSize: 16, color: J5, cursor: "pointer" }}>✕</button>
                      </div>
                    )}
                    <button onClick={handleRandomize} disabled={seatingPool.length === 0} style={{ width: "100%", padding: "10px 0", borderRadius: 12, border: "none", background: seatingPool.length === 0 ? IV3 : J5, color: seatingPool.length === 0 ? TXT3 : "#fff", fontWeight: 700, fontSize: 14, cursor: seatingPool.length === 0 ? "default" : "pointer", fontFamily: FU, marginBottom: 14 }}>
                      🎲 Randomize Tables
                    </button>
                  </>
                )}
                {seatingLoading && <div style={{ fontSize: 13, color: TXT3, textAlign: "center", marginBottom: 10, fontFamily: FU }}>Loading profiles…</div>}
                {seating ? seating.map((table, ti) => (
                  <div key={ti} style={{ background: IV2, borderRadius: 12, padding: "10px 12px", marginBottom: 10, border: `1px solid ${BDS}` }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: TXT2, textTransform: "uppercase", letterSpacing: 1, marginBottom: 8, fontFamily: FU }}>Table {ti+1} · {table.length} players</div>
                    {table.map(pid => {
                      const p = playerLookup[pid]; const skill = skillMap[pid]; const isMoving = movingUid === pid; const isTarget = isHost && !!movingUid && movingUid !== pid;
                      return (
                        <div key={pid} onClick={isHost ? () => handlePlayerTap(pid) : undefined} style={{ display: "flex", alignItems: "center", gap: 9, padding: "6px 8px", borderRadius: 9, cursor: isHost ? "pointer" : "default", marginBottom: 2, background: isMoving ? J1 : "transparent", boxShadow: isMoving ? `0 0 0 2px ${J5}` : "none", transition: "background .15s" }}>
                          <span style={{ fontSize: 21, flexShrink: 0 }}>{p?.avatar || "👤"}</span>
                          <span style={{ flex: 1, fontWeight: 600, fontSize: 14, color: J9, fontFamily: FU }}>{p?.name || pid}</span>
                          {skill && <span style={{ fontSize: 14, flexShrink: 0 }}>{SKILL_ICON[skill]}</span>}
                          {pid === uid && <span style={{ fontFamily: FU, fontSize: 11, fontWeight: 700, color: J5, background: J1, borderRadius: 999, padding: "2px 8px" }}>You</span>}
                        </div>
                      );
                    })}
                  </div>
                )) : isHost && !seatingLoading && (
                  <div style={{ textAlign: "center", padding: "8px 0 4px", fontSize: 13, color: TXT3, fontFamily: FU }}>
                    {seatingPool.length === 0 ? "No confirmed players yet." : "Tap Randomize to assign tables."}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* f. Add to Calendar */}
        <div style={{ ...card, padding: 0, overflow: "hidden" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 16px" }}>
            <div style={{ width: 36, height: 36, borderRadius: 10, background: IV3, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, flexShrink: 0 }}>🗓</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: FD, fontSize: 17, color: J9 }}>Add to calendar</div>
              <div style={{ fontFamily: FU, fontSize: 12, color: TXT3, marginTop: 1 }}>Apple Calendar · Google · Outlook</div>
            </div>
          </div>
          <div style={{ borderTop: `1px solid ${BDS}`, display: "flex", gap: 0 }}>
            {[{label:"Google Calendar",action:()=>window.open(googleUrl,"_blank")},{label:"Apple / Download .ics",action:()=>downloadIcs(game,group.name)}].map(({label,action},i) => (
              <button key={label} onClick={action} style={{ flex: 1, padding: "12px 10px", background: "none", border: "none", borderRight: i === 0 ? `1px solid ${BDS}` : "none", cursor: "pointer", fontFamily: FU, fontSize: 13, fontWeight: 600, color: J5 }}>
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Leave / Archive */}
        {onLeave && game.hostId !== uid && myRsvp === "no" && (
          <button onClick={() => setConfirmLeave(true)} style={{ width: "100%", padding: "12px", borderRadius: 14, border: `1px solid ${BDD}`, background: CL1, color: CL7, fontFamily: FU, fontSize: 14, fontWeight: 700, cursor: "pointer" }}>
            🚪 Leave Game
          </button>
        )}
        {game.hostId === uid && (
          <button onClick={() => setConfirmArchive(true)} style={{ width: "100%", padding: "12px", borderRadius: 14, border: `1px solid ${BDD}`, background: IV3, color: TXT2, fontFamily: FU, fontSize: 14, fontWeight: 600, cursor: "pointer" }}>
            📦 Archive Game
          </button>
        )}
      </div>
    </div>

    {confirmArchive && <ConfirmDialog title="Archive Game?" message={`"${game.title}" will be moved to your archive. It won't count toward your plan limits and will be removed after 60 days.`} confirmLabel="Archive Game" onConfirm={() => { setConfirmArchive(false); onArchive(); }} onCancel={() => setConfirmArchive(false)} />}
    {confirmLeave && <ConfirmDialog title="Leave Game?" message={`You'll be removed from "${game.title}". You can rejoin via invite link or QR code.`} confirmLabel="Leave Game" onConfirm={() => { setConfirmLeave(false); onLeave(); }} onCancel={() => setConfirmLeave(false)} />}
    {confirmReRandomize && <ConfirmDialog title="Re-randomize Tables?" message="Tables are already assigned. Randomizing again will overwrite the current order." confirmLabel="Randomize Again" onConfirm={doRandomize} onCancel={() => setConfirmReRandomize(false)} />}
    {gameChatOpen && <GameChat game={game} group={group} uid={uid} user={user} onClose={() => setGameChatOpen(false)} />}
    </>
  );
}

/* EDIT GAME */
function EditGame({ uid: myUid, game, group, onBack, onSave, onTransferHost }) {
  const [title, setTitle] = useState(game.title);
  const [date, setDate] = useState(new Date(game.date).toISOString().slice(0, 10));
  const [time, setTime] = useState(game.time);
  const [endTime, setEndTime] = useState(game.endTime || "22:00");
  const [loc, setLoc] = useState(game.location);
  const [note, setNote] = useState(game.note || "");
  const [tables, setTables] = useState(() => Math.max(1, Math.round((game.seats || 4) / 4)));

  // Invited members: start with group members, track who's invited to this specific game
  const [invitedIds, setInvitedIds] = useState(() => {
    const existing = Object.keys(game.rsvps || {});
    return new Set(existing.length ? existing : group.members.map((m) => m.id));
  });
  const [coHostIds, setCoHostIds] = useState(new Set(game.coHostIds || []));
  const joinCode = game.joinCode || null;

  // Manually-added anonymous guests (no app account)
  const [guests, setGuests] = useState(game.guests || []);
  const [guestName, setGuestName] = useState("");
  // Registered app users who joined via QR / invite link
  const [registeredGuests, setRegisteredGuests] = useState(game.registeredGuests || []);
  const [tab, setTab] = useState("details");
  const [transferring, setTransferring] = useState(false);
  const [selectedNewHost, setSelectedNewHost] = useState(null);
const GUEST_AVATARS = ["🌸","🦋","🌹","🍀","🦚","🌺","🎋","🐝","🦩","🌿"];

  const toggleMember = (id) => {
    if (id === myUid) return; // can't remove yourself as host
    setInvitedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        setCoHostIds((c) => { const n = new Set(c); n.delete(id); return n; });
      } else {
        next.add(id);
      }
      return next;
    });
  };
  const toggleCoHost = (id) => setCoHostIds((prev) => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s; });

  const addGuest = () => {
    const name = guestName.trim();
    if (!name) return;
    const avatar = GUEST_AVATARS[guests.length % GUEST_AVATARS.length];
    setGuests((prev) => [...prev, { id: "guest_" + uid(), name, avatar, isGuest: true }]);
    setGuestName("");
  };

  const removeGuest = (id) => setGuests((prev) => prev.filter((g) => g.id !== id));
  const removeRegisteredGuest = (id) => setRegisteredGuests((prev) => prev.filter((g) => g.id !== id));

  const handleSave = () => {
    const ts = new Date(`${date}T${time}`).getTime();
    const totalSeats = tables * 4;
    const prevWaitlist = game.waitlist || [];

    // ── Step 1: Host always holds a seat ───────────────────────────────────
    const newRsvps = { [myUid]: game.rsvps?.[myUid] || "yes" };
    let filled = 1;

    // ── Step 2: Lock in confirmed members (currently "yes") ────────────────
    // These players already have seats — never displace them.
    group.members.forEach((m) => {
      if (m.id === myUid || !invitedIds.has(m.id)) return;
      if (game.rsvps?.[m.id] === "yes") {
        newRsvps[m.id] = "yes";
        filled++;
      }
    });

    // ── Step 3: Lock in confirmed manual guests (not currently waitlisted) ────
    const newGuests = [];
    guests.forEach((g) => {
      const wasConfirmed = (game.guests || []).some((pg) => pg.id === g.id) && !prevWaitlist.includes(g.id);
      if (wasConfirmed) { newGuests.push(g); filled++; }
    });

    // ── Step 3b: Lock in confirmed registered guests (QR / link joiners) ──────
    registeredGuests.forEach((rg) => {
      if (!prevWaitlist.includes(rg.id) && game.rsvps?.[rg.id] === "yes") {
        newRsvps[rg.id] = "yes";
        filled++;
      }
    });

    // ── Step 4: Process existing waitlist in strict join order ──────────────
    // When capacity increases, the earliest-waiting player gets the seat first,
    // regardless of whether they are a member or a guest.
    const newWaitlist = [];
    for (const id of prevWaitlist) {
      const isMember = group.members.some((m) => m.id === id) && invitedIds.has(id);
      if (isMember) {
        if (filled < totalSeats) { newRsvps[id] = "yes"; filled++; }
        else { newRsvps[id] = "pending"; newWaitlist.push(id); }
        continue;
      }
      const rgObj = registeredGuests.find((rg) => rg.id === id);
      if (rgObj) {
        if (filled < totalSeats) { newRsvps[id] = "yes"; filled++; }
        else { newRsvps[id] = "pending"; newWaitlist.push(id); }
        continue;
      }
      const guestObj = guests.find((g) => g.id === id);
      if (guestObj) {
        newGuests.push(guestObj);
        if (filled < totalSeats) { filled++; /* confirmed — not added to newWaitlist */ }
        else { newWaitlist.push(id); }
        continue;
      }
      // No longer invited / removed — drop from waitlist
    }

    // ── Step 5: Newly invited members (not yet in any rsvp state) ──────────
    group.members.forEach((m) => {
      if (m.id === myUid || !invitedIds.has(m.id)) return;
      if (newRsvps[m.id] !== undefined) return; // already handled
      const existing = game.rsvps?.[m.id];
      if (existing === "maybe" || existing === "no") {
        newRsvps[m.id] = existing; // keep intentional non-yes, no seat consumed
      } else {
        if (filled < totalSeats) { newRsvps[m.id] = "yes"; filled++; }
        else { newRsvps[m.id] = "pending"; newWaitlist.push(m.id); }
      }
    });

    // ── Step 6: Truly new guests (not previously in game.guests) ───────────
    guests.forEach((g) => {
      if (newGuests.some((ng) => ng.id === g.id)) return; // already handled
      newGuests.push(g);
      if (filled < totalSeats) { filled++; }
      else { newWaitlist.push(g.id); }
    });

    // Remove guestIds for any registered guests the host removed
    const removedRgIds = new Set((game.registeredGuests || []).map(rg => rg.id).filter(id => !registeredGuests.some(rg => rg.id === id)));
    const newGuestIds = (game.guestIds || []).filter(id => !removedRgIds.has(id));
    onSave({ ...game, title: title.trim(), date: ts, time, endTime, location: loc.trim(), note, seats: totalSeats, rsvps: newRsvps, guests: newGuests, registeredGuests, guestIds: newGuestIds, waitlist: newWaitlist, coHostIds: [...coHostIds], joinCode });
  };

  const ok = title.trim() && date && time && loc.trim();

  const glassCard = {
    background: "linear-gradient(135deg,var(--bg-card),var(--bg-card-alt))",
    backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)",
    borderRadius: 16, padding: "16px",
    boxShadow: "0 4px 16px rgba(var(--shadow-rgb),0.08), inset 0 1px 0 var(--shadow-inset)",
    border: "1px solid var(--border-card)",
    marginBottom: 14,
  };

  return (
    <Shell title="Edit Game" onBack={onBack} color={group.color}>
      {/* Tabs */}
      <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        {[["details","📋 Details"],["players","👥 Players"]].map(([t, label]) => (
          <button key={t} onClick={() => setTab(t)} style={{
            flex: 1, padding: "9px 0", borderRadius: 999, fontSize: 14, fontWeight: 700,
            fontFamily: "'Inter',sans-serif", cursor: "pointer", transition: "all .18s",
            background: tab === t ? `linear-gradient(135deg,${group.color},${group.color}cc)` : "var(--bg-surface)",
            color: tab === t ? "#fff" : "#b08090",
            border: tab === t ? "none" : "1px solid rgba(var(--primary-rgb),0.2)",
            boxShadow: tab === t ? `0 3px 12px ${group.color}44` : "none",
          }}>{label}</button>
        ))}
      </div>

      {/* ── DETAILS TAB ── */}
      {tab === "details" && (
        <div className="sUp">
          <Lbl>Game Title</Lbl>
          <Fld value={title} set={setTitle} placeholder="e.g. Weekly Game Night" />
          <Lbl mt>Date</Lbl>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={inputSt} />
          <Lbl mt>Time</Lbl>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#b08090", textTransform: "uppercase", letterSpacing: .5, marginBottom: 6, fontFamily: "'Inter',sans-serif" }}>Start</div>
              <input type="time" value={time} onChange={(e) => setTime(e.target.value)} style={{ ...inputSt, marginBottom: 0 }} />
            </div>
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#b08090", textTransform: "uppercase", letterSpacing: .5, marginBottom: 6, fontFamily: "'Inter',sans-serif" }}>End</div>
              <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} style={{ ...inputSt, marginBottom: 0 }} />
            </div>
          </div>
          <Lbl mt>Location</Lbl>
          <Fld value={loc} set={setLoc} placeholder="e.g. 12 Oak Street" />
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "var(--bg-input)", border: "1.5px solid var(--border-input)", borderRadius: "var(--radius-input)", padding: "10px 14px", marginBottom: 14, marginTop: 10 }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 14, color: "var(--text-body)", fontFamily: "'Inter',sans-serif" }}>Tables</div>
              <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 1 }}>{tables * 4} seats total</div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <button onClick={() => setTables((t) => Math.max(1, t - 1))} style={{ width: 32, height: 32, borderRadius: 999, border: `1.5px solid rgba(var(--primary-rgb),0.25)`, background: "var(--bg-card)", fontSize: 18, color: "var(--primary)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700 }}>−</button>
              <span style={{ minWidth: 24, textAlign: "center", fontWeight: 700, fontSize: 16, color: group?.color || "#7c3aed", fontFamily: "'Inter',sans-serif" }}>{tables}</span>
              <button onClick={() => setTables((t) => t + 1)} style={{ width: 32, height: 32, borderRadius: 999, border: `1.5px solid rgba(var(--primary-rgb),0.25)`, background: "var(--bg-card)", fontSize: 18, color: "var(--primary)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700 }}>+</button>
            </div>
          </div>
          <Lbl>Host Notes (optional)</Lbl>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Style of play, what to bring, house rules..." rows={3} style={{ ...inputSt, resize: "none", height: "auto", padding: "12px 14px" }} />

          {/* Join Code — read-only once set */}
          {joinCode && (
            <div style={{ marginTop: 14, marginBottom: 16 }}>
              <Lbl>Game Join Code</Lbl>
              <div style={{ display: "flex", alignItems: "center", gap: 12, background: "var(--bg-surface)", border: "1.5px solid rgba(var(--border-light-rgb),0.4)", borderRadius: "var(--radius-input)", padding: "10px 14px" }}>
                <span style={{ fontFamily: "monospace", fontSize: 20, letterSpacing: 4, fontWeight: 800, color: "var(--text-body)", flex: 1 }}>{joinCode}</span>
                <span style={{ fontSize: 12, color: "var(--text-muted)", fontFamily: "'Inter',sans-serif" }}>🔒 Fixed</span>
              </div>
              <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 6, fontFamily: "'Inter',sans-serif" }}>
                Game codes cannot be changed after the game is created.
              </div>
            </div>
          )}

          <Btn full disabled={!ok} onClick={handleSave}>Save Changes ✨</Btn>
        </div>
      )}

      {/* ── PLAYERS TAB ── */}
      {tab === "players" && (
        <div className="sUp">
          {/* Group members */}
          <div style={glassCard}>
            <div style={{ fontFamily: "'Inter',sans-serif", fontSize: 16, color: "var(--section-title)", fontWeight: 700, marginBottom: 12 }}>Invite Group Members</div>
            {group.members.map((m) => {
              const isIn = invitedIds.has(m.id);
              const isMe = m.id === myUid;
              const isCo = coHostIds.has(m.id);
              return (
                <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                  <div style={{ width: 38, height: 38, borderRadius: 999, background: avatarBg(m.avatar), overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><AvatarImg av={m.avatar} size={38}/></div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 15, color: "var(--text-body)" }}>{m.name}</div>
                    {isMe && <div style={{ fontSize: 12, color: "var(--primary)", fontWeight: 700 }}>Host · Always invited</div>}
                    {!isMe && isCo && <div style={{ fontSize: 11, fontWeight: 700, color: "#b8860b", marginTop: 1, fontFamily: "'Inter',sans-serif" }}>👑 Co-host</div>}
                  </div>
                  {!isMe && isIn && (
                    <button
                      onClick={() => toggleCoHost(m.id)}
                      title={isCo ? "Remove co-host" : "Make co-host"}
                      style={{
                        width: 30, height: 30, borderRadius: 9, border: "none", flexShrink: 0, cursor: "pointer",
                        background: isCo ? "linear-gradient(135deg,#d4a843,#b88a2a)" : "rgba(200,180,190,0.25)",
                        fontSize: 15, display: "flex", alignItems: "center", justifyContent: "center",
                        boxShadow: isCo ? "0 2px 8px rgba(212,168,67,0.45)" : "none",
                        transition: "all .18s",
                      }}
                    >👑</button>
                  )}
                  {!isMe && (
                    <div onClick={() => toggleMember(m.id)} style={{
                      width: 32, height: 32, borderRadius: 999, cursor: "pointer",
                      display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16,
                      transition: "all .18s", flexShrink: 0,
                      background: isIn ? `linear-gradient(135deg,${group.color},${group.color}cc)` : "rgba(200,180,190,0.25)",
                      boxShadow: isIn ? `0 2px 8px ${group.color}44` : "none",
                      border: isIn ? "none" : "1px solid rgba(var(--primary-rgb),0.25)",
                    }}>{isIn ? "✅" : "➕"}</div>
                  )}
                  {isMe && <div style={{ width: 32, height: 32, borderRadius: 999, background: `linear-gradient(135deg,${group.color},${group.color}cc)`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, flexShrink: 0 }}>✅</div>}
                </div>
              );
            })}
          </div>

          {/* Guests */}
          <div style={glassCard}>
            <div style={{ fontFamily: "'Inter',sans-serif", fontSize: 16, color: "var(--section-title)", fontWeight: 700, marginBottom: 4 }}>Guests</div>
            <div style={{ fontSize: 13, color: "#b08090", marginBottom: 12, fontFamily: "'Inter',sans-serif" }}>Invite someone outside the group</div>

            {guests.map((g) => (
              <div key={g.id} style={{ display: "flex", alignItems: "center", gap: 11, marginBottom: 10 }}>
                <div style={{ width: 38, height: 38, borderRadius: 999, background: "linear-gradient(135deg,#f0e4f8,#e8d0f0)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 21, flexShrink: 0 }}>{g.avatar}</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700, fontSize: 15, color: "var(--text-body)" }}>{g.name}</div>
                  <div style={{ fontSize: 12, color: "var(--secondary-accent)", fontWeight: 700 }}>Guest</div>
                </div>
                <div onClick={() => removeGuest(g.id)} style={{ width: 32, height: 32, borderRadius: 999, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, background: "rgba(var(--primary-rgb),0.12)", border: "1px solid rgba(var(--primary-rgb),0.2)" }}>✕</div>
              </div>
            ))}

            <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
              <input
                value={guestName}
                onChange={(e) => setGuestName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addGuest()}
                placeholder="Guest name…"
                style={{ ...inputSt, flex: 1, marginBottom: 0 }}
              />
              <button onClick={addGuest} disabled={!guestName.trim()} style={{
                padding: "0 16px", borderRadius: 12, fontSize: 21, cursor: guestName.trim() ? "pointer" : "not-allowed",
                background: guestName.trim() ? `linear-gradient(135deg,${group.color},${group.color}cc)` : "rgba(200,180,190,0.3)",
                border: "none", color: "#fff", transition: "all .18s",
                boxShadow: guestName.trim() ? `0 3px 10px ${group.color}44` : "none",
                flexShrink: 0,
              }}>+</button>
            </div>
          </div>

          {/* Registered guests — joined via QR, invite link, or game code */}
          {registeredGuests.length > 0 && (
            <div style={glassCard}>
              <div style={{ fontFamily: "'Inter',sans-serif", fontSize: 16, color: "var(--section-title)", fontWeight: 700, marginBottom: 4 }}>Joined via Invite</div>
              <div style={{ fontSize: 13, color: "#b08090", marginBottom: 12, fontFamily: "'Inter',sans-serif" }}>App users who joined via QR code, invite link, or game code</div>
              {registeredGuests.map((rg) => (
                <div key={rg.id} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                  <div style={{ width: 38, height: 38, borderRadius: 999, background: avatarBg(rg.avatar), overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><AvatarImg av={rg.avatar} size={38}/></div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 15, color: "var(--text-body)" }}>{rg.name}</div>
                    <div style={{ fontSize: 11, color: "var(--secondary-accent)", fontWeight: 700, marginTop: 1 }}>Joined via invite</div>
                  </div>
                  <div onClick={() => removeRegisteredGuest(rg.id)} style={{ width: 32, height: 32, borderRadius: 999, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, background: "rgba(var(--primary-rgb),0.12)", border: "1px solid rgba(var(--primary-rgb),0.2)" }}>✕</div>
                </div>
              ))}
            </div>
          )}

          <Btn full onClick={handleSave}>Save Changes ✨</Btn>

          {/* Transfer Host — only shown when I am currently the host */}
          {game.hostId === myUid && (
            <div style={{ marginTop: 16 }}>
              {!transferring ? (
                <button onClick={() => setTransferring(true)} style={{
                  width: "100%", padding: "11px 0", borderRadius: 12, fontSize: 14, fontWeight: 700,
                  cursor: "pointer", fontFamily: "'Inter',sans-serif", border: "1px solid rgba(var(--primary-rgb),0.3)",
                  background: "transparent", color: "var(--primary)", transition: "all .18s",
                }}>
                  🔄 Transfer Host
                </button>
              ) : (
                <div className="sUp" style={{
                  background: "linear-gradient(135deg,var(--bg-card),var(--bg-card-alt))",
                  backdropFilter: "blur(10px)", borderRadius: 16, padding: "16px",
                  border: "1px solid rgba(var(--border-light-rgb),0.5)",
                  boxShadow: "0 4px 16px rgba(var(--shadow-rgb),0.09)",
                }}>
                  <div style={{ fontFamily: "'Inter',sans-serif", fontSize: 16, color: "var(--section-title)", fontWeight: 700, marginBottom: 4 }}>Transfer Host</div>
                  <div style={{ fontSize: 13, color: "#b08090", marginBottom: 14, fontFamily: "'Inter',sans-serif", lineHeight: 1.6 }}>
                    Select a new host. They'll take over responsibilities and you can update your own RSVP freely.
                  </div>

                  {/* Eligible members — invited, not me, not already host */}
                  {group.members.filter((m) => m.id !== myUid && invitedIds.has(m.id)).length === 0 ? (
                    <div style={{ fontSize: 14, color: "#c0a0b0", textAlign: "center", padding: "12px 0", fontFamily: "'Inter',sans-serif" }}>
                      No other invited members to transfer to.
                    </div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 14 }}>
                      {group.members.filter((m) => m.id !== myUid && invitedIds.has(m.id)).map((m) => (
                        <div key={m.id} onClick={() => setSelectedNewHost(m.id)} style={{
                          display: "flex", alignItems: "center", gap: 11, padding: "10px 12px",
                          borderRadius: 12, cursor: "pointer", transition: "all .18s",
                          background: selectedNewHost === m.id ? `linear-gradient(135deg,${group.color}22,${group.color}0f)` : "rgba(255,255,255,0.5)",
                          border: `2px solid ${selectedNewHost === m.id ? group.color : "transparent"}`,
                        }}>
                          <div style={{ width: 36, height: 36, borderRadius: 999, background: avatarBg(m.avatar), overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><AvatarImg av={m.avatar} size={36}/></div>
                          <div style={{ flex: 1, fontWeight: 700, fontSize: 15, color: "var(--text-body)" }}>{m.name}</div>
                          {selectedNewHost === m.id && <span style={{ fontSize: 17, color: group.color }}>⭐</span>}
                        </div>
                      ))}
                    </div>
                  )}

                  <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={() => { setTransferring(false); setSelectedNewHost(null); }} style={{
                      flex: 1, padding: "10px 0", borderRadius: 12, fontSize: 14, fontWeight: 700,
                      cursor: "pointer", fontFamily: "'Inter',sans-serif",
                      background: "rgba(200,180,190,0.25)", border: "1px solid rgba(var(--primary-rgb),0.2)", color: "#b08090",
                    }}>Cancel</button>
                    <button onClick={() => { if (selectedNewHost) onTransferHost(selectedNewHost); }} disabled={!selectedNewHost} style={{
                      flex: 2, padding: "10px 0", borderRadius: 12, fontSize: 14, fontWeight: 700,
                      cursor: selectedNewHost ? "pointer" : "not-allowed", fontFamily: "'Inter',sans-serif", border: "none",
                      background: selectedNewHost ? `linear-gradient(135deg,${group.color},${group.color}cc)` : "rgba(200,180,190,0.3)",
                      color: selectedNewHost ? "#fff" : "#bbb",
                      boxShadow: selectedNewHost ? `0 4px 14px ${group.color}44` : "none",
                      transition: "all .2s",
                    }}>Confirm Transfer 🎯</button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </Shell>
  );
}

/* INVITE */
function Invite({ group, game, flash, onBack }) {
  const joinUrl = game
    ? game.joinCode
      ? `${APP_PUBLIC_URL}/?gameCode=${game.joinCode}`
      : `${APP_PUBLIC_URL}/?joinGroup=${group.code}&game=${game.id}`
    : `${APP_PUBLIC_URL}/?joinGroup=${group.code}`;

  const txt = game
    ? `You're invited to a Mahjong game!\n\n📅 ${fmt(game.date)} at ${fmtT(game.time)}\n📍 ${game.location}\n🎯 Host: ${game.host}${game.note ? `\n📝 ${game.note}` : ""}${game.joinCode ? `\n\nGame Code: ${game.joinCode}` : ""}\n\nTap to join and RSVP:\n${joinUrl}`
    : `Join my Mahjong group on Mahjong Club!\n\nGroup: ${group.name}\n\nTap to join:\n${joinUrl}`;

  const share = (method) => {
    const enc = encodeURIComponent(txt);
    const subj = encodeURIComponent(game ? "Join our Mahjong game!" : `Join ${group.name}!`);
    if (method === "sms") window.open(`sms:?body=${enc}`);
    else if (method === "email") window.open(`mailto:?subject=${subj}&body=${enc}`);
    else if (method === "copyLink") {
      try { navigator.clipboard.writeText(joinUrl).then(() => flash("Link copied!", "🔗")); } catch { flash("Link copied!", "🔗"); }
    } else if (method === "copy") {
      try { navigator.clipboard.writeText(txt).then(() => flash("Copied!", "📋")); } catch { flash("Copied!", "📋"); }
    } else if (method === "share") {
      if (navigator.share) navigator.share({ title: "Mahjong Club", text: txt, url: joinUrl }).catch(() => {});
      else { try { navigator.clipboard.writeText(joinUrl).then(() => flash("Link copied!", "🔗")); } catch { flash("Link copied!", "🔗"); } }
    }
  };

  return (
    <Shell title={game ? "Invite to Game" : "Invite to Group"} onBack={onBack} color={group.color}>
      <div style={{ textAlign: "center", marginBottom: 16 }}>
        <div style={{ fontSize: 49 }}>✉️</div>
        <p style={{ fontWeight: 700, color: "var(--text-body)", marginTop: 8, fontSize: 16 }}>{game ? `"${game.title}"` : `"${group.name}"`}</p>
      </div>

      <SecLbl>Send via</SecLbl>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 11, marginBottom: 11 }}>
        {[
          ["💬","Text Message","Opens SMS app","var(--secondary-accent)","sms"],
          ["📋","Copy Message","Paste anywhere","#c4936e","copy"],
          ["📤","Share...","All options","#d4829b","share"],
        ].map(([icon, label, sub, color, method]) => (
          <button key={method} onClick={() => share(method)} style={{ background: "#fff", borderRadius: 16, padding: "15px 10px", cursor: "pointer", boxShadow: "0 3px 14px rgba(0,0,0,.08)", border: `2px solid ${color}33`, textAlign: "center", fontFamily: "'Inter',sans-serif", transition: "transform .14s" }}
            onMouseDown={(e) => { e.currentTarget.style.transform = "scale(.95)"; }}
            onMouseUp={(e) => { e.currentTarget.style.transform = "scale(1)"; }}
            onTouchStart={(e) => { e.currentTarget.style.transform = "scale(.95)"; }}
            onTouchEnd={(e) => { e.currentTarget.style.transform = "scale(1)"; }}
          >
            <div style={{ fontSize: 29, marginBottom: 4 }}>{icon}</div>
            <div style={{ fontWeight: 700, fontSize: 14, color: "var(--text-body)" }}>{label}</div>
            <div style={{ fontSize: 12, color: "#c0a0ac", marginTop: 1 }}>{sub}</div>
          </button>
        ))}
      </div>

      <SecLbl>QR Code</SecLbl>
      <div style={{ background: "#fff", borderRadius: 18, padding: "20px 16px", marginBottom: 22, boxShadow: "0 4px 20px rgba(0,0,0,.08)", textAlign: "center" }}>
        <p style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 16, fontWeight: 500 }}>
          {game ? "Scan to RSVP to this game" : "Scan to join this group"}
        </p>
        <div style={{ display: "inline-block", padding: 14, borderRadius: 14, background: "#fff", boxShadow: `0 0 0 3px ${group.color}22` }}>
          <QRCodeSVG
            value={joinUrl}
            size={200}
            fgColor={group.color}
            bgColor="#ffffff"
            level="M"
          />
        </div>
        <button
          onClick={() => { navigator.clipboard.writeText(joinUrl).then(() => flash("Link copied!", "🔗")).catch(() => flash("Link copied!", "🔗")); }}
          style={{ marginTop: 16, display: "block", width: "100%", background: `${group.color}15`, border: `1px solid ${group.color}30`, borderRadius: 10, padding: "9px 0", fontSize: 13, color: group.color, fontWeight: 700, cursor: "pointer", fontFamily: "'Inter',sans-serif" }}
        >
          Copy link
        </button>
      </div>

      {game && game.joinCode && (
        <div style={{ textAlign: "center", background: "#fff", borderRadius: 14, padding: "14px 16px", boxShadow: "0 2px 10px rgba(0,0,0,.05)", marginBottom: 12 }}>
          <div style={{ fontSize: 12, color: "#bbb", fontWeight: 800, textTransform: "uppercase", letterSpacing: 1 }}>Game Join Code</div>
          <div style={{ fontFamily: "monospace", fontSize: 34, color: group.color, letterSpacing: 6, marginTop: 4, fontWeight: 800 }}>{game.joinCode}</div>
          <div style={{ fontSize: 12, color: "#c0a0ac", marginTop: 4, fontFamily: "'Inter',sans-serif" }}>Share this code to invite players directly to this game</div>
        </div>
      )}
      {!game && (
        <div style={{ textAlign: "center", background: "#fff", borderRadius: 14, padding: "14px 16px", boxShadow: "0 2px 10px rgba(0,0,0,.05)" }}>
          <div style={{ fontSize: 12, color: "#bbb", fontWeight: 800, textTransform: "uppercase", letterSpacing: 1 }}>Group Join Code</div>
          <div style={{ fontFamily: "'Inter',sans-serif", fontSize: 39, color: group.color, letterSpacing: 8, marginTop: 4 }}>{group.code}</div>
        </div>
      )}
    </Shell>
  );
}

/* SHARED COMPONENTS */
function Shell({ title, onBack, color, children }) {
  const isCssVar = typeof color === "string" && color.startsWith("var(");
  const headerBg = isCssVar
    ? "var(--header-gradient)"
    : `linear-gradient(135deg,${color}ff,${color}cc)`;
  const headerShadow = isCssVar
    ? "0 8px 32px rgba(var(--shadow-rgb),0.40)"
    : `0 8px 32px ${color}55`;
  return (
    <div style={{ minHeight: "100%", background: `linear-gradient(170deg,var(--bg-shell-start) 0%,var(--bg-shell-mid) 40%,var(--bg-shell-end) 100%)` }}>
      <div style={{
        background: headerBg,
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
        padding: `${HEADER_BTN_TOP}px 22px 22px`,
        display: "flex", alignItems: "center", gap: 12,
        boxShadow: headerShadow,
        position: "relative", overflow: "hidden",
      }}>
        <div style={{ position: "absolute", inset: 0, background: "linear-gradient(135deg,rgba(255,255,255,0.07) 0%,transparent 60%)", pointerEvents: "none" }} />
        <button onClick={onBack} style={{ background: "rgba(255,255,255,.28)", border: "1px solid rgba(255,255,255,.4)", borderRadius: 999, width: 36, height: 36, fontSize: 19, color: "#fff", flexShrink: 0, backdropFilter: "blur(8px)" }}>‹</button>
        <h1 style={{ fontFamily: "'Inter',sans-serif", fontSize: 24, color: "#fff", textShadow: "0 2px 8px rgba(0,0,0,.2)", position: "relative" }}>{title}</h1>
      </div>
      <div style={{
        padding: "20px 16px",
        background: "var(--bg-surface)",
        backdropFilter: "blur(16px)",
        WebkitBackdropFilter: "blur(16px)",
        minHeight: "calc(100vh - 100px)",
        paddingBottom: 100,
        overflowX: "hidden",
        boxSizing: "border-box",
      }} className="sUp">{children}</div>
    </div>
  );
}
function Lbl({ children, mt }) {
  return <div style={{ fontSize: 13, fontWeight: 700, color: "var(--primary-subtle)", marginBottom: 6, marginTop: mt ? 10 : 0, textTransform: "uppercase", letterSpacing: .5, fontFamily: "var(--font-body)" }}>{children}</div>;
}
function SecLbl({ children }) {
  return <div style={{ fontSize: 12, fontWeight: 700, color: "var(--primary-faint)", marginBottom: 8, textTransform: "uppercase", letterSpacing: 1, fontFamily: "var(--font-body)" }}>{children}</div>;
}
function Fld({ value, set, placeholder }) {
  return <input value={value} onChange={(e) => set(e.target.value)} placeholder={placeholder} style={inputSt} />;
}
function Btn({ children, onClick, full, sm, outline, danger, disabled, style: sx }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{ width: full ? "100%" : "auto", padding: sm ? "7px 14px" : "13px 20px", borderRadius: "var(--radius-btn)", fontSize: sm ? 13 : 15, fontWeight: 700, background: disabled ? "#e5e5e5" : outline ? "transparent" : "var(--primary)", color: disabled ? "#bbb" : outline ? "var(--primary)" : "#fff", border: outline ? "2px solid var(--primary)" : "none", cursor: disabled ? "not-allowed" : "pointer", boxShadow: disabled || outline ? "none" : "0 4px 16px var(--shadow-btn)", fontFamily: "var(--font-body)", transition: "all .18s", ...sx }}
      onMouseDown={(e) => { if (!disabled) e.currentTarget.style.transform = "scale(.97)"; }}
      onMouseUp={(e) => { e.currentTarget.style.transform = "scale(1)"; }}
    >{children}</button>
  );
}
function Chip({ children, color, big }) {
  return <div style={{ background: color + "18", color, borderRadius: "var(--radius-btn)", padding: big ? "5px 12px" : "2px 10px", fontSize: big ? 13 : 12, fontWeight: 700, whiteSpace: "nowrap", fontFamily: "var(--font-body)" }}>{children}</div>;
}
function IRow({ icon, label, val }) {
  return (
    <div style={{ background: "linear-gradient(135deg,var(--bg-card),var(--bg-card-alt))", backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)", borderRadius: "var(--radius-card-sm)", padding: "11px 14px", marginBottom: 9, display: "flex", gap: 11, alignItems: "flex-start", boxShadow: "0 4px 16px var(--shadow-card), inset 0 1px 0 var(--shadow-inset)", border: "1px solid var(--border-card)" }}>
      <span style={{ fontSize: 19, lineHeight: 1.3, flexShrink: 0 }}>{icon}</span>
      <div>
        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--primary-faint)", textTransform: "uppercase", letterSpacing: .5 }}>{label}</div>
        <div style={{ fontSize: 15, fontWeight: 500, color: "var(--text-body)", marginTop: 2 }}>{val}</div>
      </div>
    </div>
  );
}

/* ── ADMIN HUB ── */
function AdminHub({ uid: adminUid, user: adminUser, go, flash, onImpersonate }) {
  const [tab, setTab] = useState("users");
  // Shared plan list loaded once; passed to both tabs so they don't re-fetch
  const [adminPackages, setAdminPackages] = useState([]);
  useEffect(() => {
    const unsub = onSnapshot(collection(db, "subscriptionPackages"), (snap) => {
      setAdminPackages(snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.price ?? 0) - (b.price ?? 0)));
    });
    return unsub;
  }, []);

  const hubStyle = {
    minHeight: "100dvh",
    background: "linear-gradient(160deg,#1a0d30 0%,#2d1b4e 40%,#3d1f5e 100%)",
    fontFamily: "'Inter',sans-serif",
    color: "#fff",
  };
  const headerStyle = {
    display: "flex", alignItems: "center", gap: 14,
    padding: "20px 28px 0",
    borderBottom: "1px solid rgba(155,110,168,0.2)",
    paddingBottom: 0,
  };
  const tabStyle = (active) => ({
    padding: "10px 20px", fontSize: 14, fontWeight: 700,
    border: "none", background: "none", cursor: "pointer",
    color: active ? "#e8a0d0" : "rgba(255,255,255,0.5)",
    borderBottom: active ? "2px solid #e8a0d0" : "2px solid transparent",
    transition: "all .18s", fontFamily: "'Inter',sans-serif",
    marginBottom: -1,
  });

  return (
    <div style={hubStyle}>
      <div style={headerStyle}>
        <button onClick={() => go("home")} style={{ background: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 10, padding: "7px 14px", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "'Inter',sans-serif" }}>
          ← Back
        </button>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: "'Inter',sans-serif", fontSize: 22, fontWeight: 700, color: "#fff" }}>🏛️ Admin Hub</div>
          <div style={{ fontSize: 12, color: "rgba(255,255,255,0.5)", marginTop: 2 }}>Signed in as {adminUser.name}</div>
        </div>
        <div style={{ fontSize: 11, fontWeight: 800, color: "#e8a0d0", background: "rgba(232,160,208,0.15)", borderRadius: 999, padding: "4px 12px", textTransform: "uppercase", letterSpacing: 1 }}>Admin</div>
      </div>

      <div style={{ display: "flex", gap: 0, padding: "0 28px", borderBottom: "1px solid rgba(155,110,168,0.2)", marginTop: 8, overflowX: "auto" }}>
        {[["users","👥 Users"],["logs","📋 Logs"],["subscriptions","💳 Subscriptions"],["notifications","📣 Notification Templates"],["config","⚙️ Config"]].map(([key, label]) => (
          <button key={key} style={tabStyle(tab === key)} onClick={() => setTab(key)}>{label}</button>
        ))}
      </div>

      <div style={{ padding: "24px 28px", maxWidth: 960, margin: "0 auto" }}>
        {tab === "users"          && <AdminUsers onImpersonate={onImpersonate} go={go} flash={flash} packages={adminPackages} adminUid={adminUid} />}
        {tab === "logs"           && <AdminLogs />}
        {tab === "subscriptions"  && <AdminSubscriptions flash={flash} packages={adminPackages} adminUid={adminUid} />}
        {tab === "notifications"  && <AdminNotifications flash={flash} adminUid={adminUid} />}
        {tab === "config"         && <AdminConfig flash={flash} adminUid={adminUid} />}
      </div>
    </div>
  );
}

/* Users tab — list → detail with plan management */
function AdminUsers({ onImpersonate, go, flash, packages, adminUid }) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(null);      // user detail view
  const [promoting, setPromoting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Plan-change state
  const [planEdit, setPlanEdit] = useState(false);
  const [planKey, setPlanKey] = useState("");
  const [planNote, setPlanNote] = useState("");
  const [savingPlan, setSavingPlan] = useState(false);
  // Profile-edit state
  const [profileEdit, setProfileEdit] = useState(false);
  const [profileForm, setProfileForm] = useState({ name: "", avatar: "", skillLevel: "", email: "" });
  const [savingProfile, setSavingProfile] = useState(false);

  useEffect(() => {
    getDocs(collection(db, "users"))
      .then((snap) => {
        const list = snap.docs.map((d) => ({ uid: d.id, ...d.data() }));
        list.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
        setUsers(list);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const updateLocal = (uid, patch) =>
    setUsers((prev) => prev.map((u) => u.uid === uid ? { ...u, ...patch } : u));

  const openDetail = (u) => {
    setSelected(u);
    setPlanEdit(false);
    setPlanKey(u.subscription?.plan || "free");
    setPlanNote(u.subscription?.overrideNote || "");
    setProfileEdit(false);
    setProfileForm({ name: u.name || "", avatar: u.avatar || "", skillLevel: u.skillLevel || "", email: u.email || "" });
  };

  const saveProfile = async () => {
    if (!selected) return;
    if (!profileForm.name.trim()) { flash("Name is required.", "⚠️"); return; }
    const newEmail = profileForm.email.trim().toLowerCase();
    if (newEmail && !/\S+@\S+\.\S+/.test(newEmail)) {
      flash("Invalid email address.", "⚠️"); return;
    }
    setSavingProfile(true);
    try {
      const patch = {
        name:       profileForm.name.trim(),
        avatar:     profileForm.avatar.trim() || "👤",
        skillLevel: profileForm.skillLevel.trim(),
      };

      // Always write profile fields directly to Firestore
      await updateDoc(doc(db, "users", selected.uid), patch);

      // Only touch Firebase Auth when the email actually changed
      const emailChanged = newEmail && newEmail !== (selected.email || "").toLowerCase();
      if (emailChanged) {
        const adminUpdateUser = hostingFn("adminUpdateUser");
        await adminUpdateUser({ targetUid: selected.uid, email: newEmail });
        patch.email = newEmail;
      }

      updateLocal(selected.uid, patch);
      setSelected((p) => ({ ...p, ...patch }));
      setProfileEdit(false);
      flash("Profile updated.", "✅");
    } catch (e) { flash(`Failed to save: ${e.message}`, "❌"); }
    setSavingProfile(false);
  };

  const toggleAdmin = async () => {
    if (!selected) return;
    setPromoting(true);
    try {
      const setAdminRole = hostingFn("setAdminRole");
      await setAdminRole({ targetUid: selected.uid, isAdmin: !selected.isAdmin });
      const patch = { isAdmin: !selected.isAdmin };
      updateLocal(selected.uid, patch);
      setSelected((p) => ({ ...p, ...patch }));
      flash(`${selected.name} is now ${!selected.isAdmin ? "an Admin" : "a Standard user"}`);
    } catch (e) { flash(`Failed to update user role: ${e.message}`); }
    setPromoting(false);
  };

  const handleDeleteUser = async () => {
    if (!selected) return;
    setConfirmDelete(false);
    setDeleting(true);
    try {
      const deleteFn = hostingFn("deleteUser");
      await deleteFn({ uid: selected.uid });
      setUsers((prev) => prev.filter((u) => u.uid !== selected.uid));
      flash(`${selected.name} has been deleted`, "🗑️");
      setSelected(null);
    } catch (e) { flash(`Failed to delete: ${e.message}`, "❌"); }
    setDeleting(false);
  };

  const savePlan = async () => {
    if (!selected) return;
    setSavingPlan(true);
    const newSub = {
      plan: planKey,
      overrideNote: planNote.trim(),
      changedAt: Date.now(),
      changedBy: adminUid,
    };
    try {
      await updateDoc(doc(db, "users", selected.uid), { subscription: newSub });
      updateLocal(selected.uid, { subscription: newSub });
      setSelected((p) => ({ ...p, subscription: newSub }));
      setPlanEdit(false);
      flash(`Plan updated to "${planKey}"${planNote ? ` — ${planNote}` : ""}`);
    } catch { flash("Failed to update plan"); }
    setSavingPlan(false);
  };

  const inp = { width: "100%", padding: "9px 13px", borderRadius: 10, fontSize: 14, border: "1.5px solid rgba(155,110,168,0.3)", background: "rgba(255,255,255,0.08)", color: "#fff", fontFamily: "'Inter',sans-serif", outline: "none", boxSizing: "border-box" };
  const SecHd = ({ children }) => <div style={{ fontSize: 11, fontWeight: 800, color: "rgba(232,160,208,0.65)", textTransform: "uppercase", letterSpacing: 1.2, marginBottom: 10, fontFamily: "'Inter',sans-serif" }}>{children}</div>;

  const planChip = (u) => {
    const key = u.subscription?.plan || "free";
    const pkg = packages.find((p) => (p.planKey || p.id) === key);
    return (
      <span style={{ fontSize: 11, fontWeight: 700, background: "rgba(155,63,160,0.22)", color: "#e8a0d0", borderRadius: 999, padding: "2px 9px", fontFamily: "'Inter',sans-serif", letterSpacing: 0.3 }}>
        {pkg?.name || key}
      </span>
    );
  };

  // ── Detail view ──────────────────────────────────────────────────────────────
  if (selected) {
    const u = selected;
    const currentPlanKey = u.subscription?.plan || "free";
    const currentPkg = packages.find((p) => (p.planKey || p.id) === currentPlanKey);

    return (
      <div>
        {/* Back + header */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 22 }}>
          <button onClick={() => setSelected(null)} style={{ background: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 10, padding: "6px 14px", color: "#fff", fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "'Inter',sans-serif" }}>← Users</button>
          <div style={{ fontFamily: "'Inter',sans-serif", fontSize: 18, color: "#fff", flex: 1 }}>{u.name}</div>
          {u.isAdmin && <span style={{ fontSize: 11, fontWeight: 800, color: "#e8a0d0", background: "rgba(232,160,208,0.18)", borderRadius: 999, padding: "3px 10px", textTransform: "uppercase", letterSpacing: 1 }}>Admin</span>}
        </div>

        {/* Profile card */}
        <div style={{ background: "rgba(255,255,255,0.06)", borderRadius: 16, padding: "18px 20px", marginBottom: 14, border: "1px solid rgba(155,110,168,0.2)" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
            <SecHd>Profile</SecHd>
            {!profileEdit && (
              <button onClick={() => { setProfileEdit(true); setProfileForm({ name: u.name || "", avatar: u.avatar || "", skillLevel: u.skillLevel || "", email: u.email || "" }); }} style={{ background: "linear-gradient(135deg,#5a2d6b,#9b3fa0)", border: "none", borderRadius: 8, padding: "5px 13px", color: "#fff", fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: "'Inter',sans-serif" }}>
                Edit
              </button>
            )}
          </div>

          {!profileEdit ? (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 14 }}>
                <span style={{ fontSize: 40 }}>{u.avatar || "👤"}</span>
                <div>
                  <div style={{ fontSize: 17, fontWeight: 700, color: "#fff", fontFamily: "'Inter',sans-serif" }}>{u.name}</div>
                  <div style={{ fontSize: 13, color: "rgba(255,255,255,0.45)", marginTop: 3 }}>{u.email}</div>
                  {u.skillLevel && <div style={{ fontSize: 12, color: "rgba(255,255,255,0.35)", marginTop: 2 }}>{u.skillLevel}</div>}
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button onClick={toggleAdmin} disabled={promoting} style={{ padding: "7px 14px", borderRadius: 10, background: u.isAdmin ? "rgba(232,160,208,0.15)" : "rgba(255,255,255,0.1)", border: `1px solid ${u.isAdmin ? "rgba(232,160,208,0.35)" : "rgba(255,255,255,0.2)"}`, color: u.isAdmin ? "#e8a0d0" : "#ccc", fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: "'Inter',sans-serif", opacity: promoting ? 0.5 : 1 }}>
                  {promoting ? "…" : u.isAdmin ? "Revoke Admin" : "Make Admin"}
                </button>
                <button onClick={() => { onImpersonate(u); go("home"); }} style={{ padding: "7px 14px", borderRadius: 10, background: "linear-gradient(135deg,#5a2d6b,#9b3fa0)", border: "none", color: "#fff", fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: "'Inter',sans-serif" }}>
                  View as
                </button>
                <button onClick={() => setConfirmDelete(true)} disabled={deleting} style={{ padding: "7px 14px", borderRadius: 10, background: "rgba(220,60,60,0.15)", border: "1px solid rgba(220,60,60,0.35)", color: "#ff8080", fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: "'Inter',sans-serif", opacity: deleting ? 0.5 : 1 }}>
                  {deleting ? "Deleting…" : "Delete User"}
                </button>
              </div>
            </>
          ) : (
            <div>
              <div style={{ display: "flex", gap: 12, alignItems: "flex-start", marginBottom: 14 }}>
                <div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "rgba(232,160,208,0.65)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6, fontFamily: "'Inter',sans-serif" }}>Avatar</div>
                  <input
                    value={profileForm.avatar}
                    onChange={e => setProfileForm(f => ({ ...f, avatar: e.target.value }))}
                    maxLength={4}
                    style={{ ...inp, width: 64, textAlign: "center", fontSize: 28, padding: "8px 4px" }}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "rgba(232,160,208,0.65)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6, fontFamily: "'Inter',sans-serif" }}>Display Name</div>
                  <input
                    value={profileForm.name}
                    onChange={e => setProfileForm(f => ({ ...f, name: e.target.value }))}
                    placeholder="Display name"
                    style={inp}
                  />
                </div>
              </div>
              <div style={{ marginBottom: 6 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "rgba(232,160,208,0.65)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6, fontFamily: "'Inter',sans-serif" }}>Email</div>
                <input
                  type="email"
                  value={profileForm.email}
                  onChange={e => setProfileForm(f => ({ ...f, email: e.target.value }))}
                  placeholder="user@example.com"
                  style={inp}
                />
                <div style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", marginTop: 5, fontFamily: "'Inter',sans-serif" }}>Changing email updates Firebase Auth — takes effect on next login.</div>
              </div>
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "rgba(232,160,208,0.65)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6, marginTop: 12, fontFamily: "'Inter',sans-serif" }}>Skill Level</div>
                <input
                  value={profileForm.skillLevel}
                  onChange={e => setProfileForm(f => ({ ...f, skillLevel: e.target.value }))}
                  placeholder="e.g. Beginner, Intermediate, Advanced"
                  style={inp}
                />
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => setProfileEdit(false)} style={{ flex: 1, padding: "9px", borderRadius: 10, background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.2)", color: "#fff", fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "'Inter',sans-serif" }}>Cancel</button>
                <button onClick={saveProfile} disabled={savingProfile} style={{ flex: 2, padding: "9px", borderRadius: 10, background: "linear-gradient(135deg,#5a2d6b,#9b3fa0)", border: "none", color: "#fff", fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "'Inter',sans-serif", opacity: savingProfile ? 0.5 : 1 }}>
                  {savingProfile ? "Saving…" : "Save Changes"}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Subscription card */}
        <div style={{ background: "rgba(255,255,255,0.06)", borderRadius: 16, padding: "18px 20px", marginBottom: 14, border: "1px solid rgba(155,110,168,0.2)" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
            <SecHd>Subscription</SecHd>
            {!planEdit && (
              <button onClick={() => { setPlanEdit(true); setPlanKey(currentPlanKey); setPlanNote(u.subscription?.overrideNote || ""); }} style={{ background: "linear-gradient(135deg,#5a2d6b,#9b3fa0)", border: "none", borderRadius: 8, padding: "5px 13px", color: "#fff", fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: "'Inter',sans-serif" }}>
                Change Plan
              </button>
            )}
          </div>

          {!planEdit ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 14, color: "rgba(255,255,255,0.6)", fontFamily: "'Inter',sans-serif" }}>Current Plan</span>
                <span style={{ fontSize: 15, fontWeight: 700, color: "#fff", fontFamily: "'Inter',sans-serif" }}>{currentPkg?.name || currentPlanKey}</span>
              </div>
              {currentPkg && currentPkg.price > 0 && (
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: 14, color: "rgba(255,255,255,0.6)", fontFamily: "'Inter',sans-serif" }}>Standard Price</span>
                  <span style={{ fontSize: 14, color: "#e8a0d0", fontWeight: 700 }}>${currentPkg.price} / {currentPkg.interval}</span>
                </div>
              )}
              {u.subscription?.overrideNote && (
                <div style={{ background: "rgba(155,63,160,0.15)", borderRadius: 10, padding: "9px 13px", border: "1px solid rgba(155,63,160,0.25)" }}>
                  <div style={{ fontSize: 11, fontWeight: 800, color: "rgba(232,160,208,0.6)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 4, fontFamily: "'Inter',sans-serif" }}>Admin Note</div>
                  <div style={{ fontSize: 13, color: "rgba(255,255,255,0.75)", fontFamily: "'Inter',sans-serif" }}>{u.subscription.overrideNote}</div>
                </div>
              )}
              {u.subscription?.changedAt && (
                <div style={{ fontSize: 12, color: "rgba(255,255,255,0.3)", fontFamily: "'Inter',sans-serif" }}>
                  Last changed {new Date(u.subscription.changedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                </div>
              )}
            </div>
          ) : (
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: "rgba(232,160,208,0.65)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6, fontFamily: "'Inter',sans-serif" }}>Plan</div>
              <select value={planKey} onChange={(e) => setPlanKey(e.target.value)} style={{ ...inp, marginBottom: 12 }}>
                <option value="free">Free (default)</option>
                {packages.map((p) => {
                  const key = p.planKey || p.id;
                  if (key === "free") return null;
                  return <option key={p.id} value={key}>{p.name}{p.price > 0 ? ` — $${p.price}/${p.interval}` : ""}</option>;
                })}
              </select>
              <div style={{ fontSize: 12, fontWeight: 700, color: "rgba(232,160,208,0.65)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6, fontFamily: "'Inter',sans-serif" }}>Admin Note (optional)</div>
              <input value={planNote} onChange={(e) => setPlanNote(e.target.value)} placeholder="e.g. Comped Pro — contest winner, expires Jun 2026" style={{ ...inp, marginBottom: 14 }} />
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => setPlanEdit(false)} style={{ flex: 1, padding: "9px", borderRadius: 10, background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.2)", color: "#fff", fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "'Inter',sans-serif" }}>Cancel</button>
                <button onClick={savePlan} disabled={savingPlan} style={{ flex: 2, padding: "9px", borderRadius: 10, background: "linear-gradient(135deg,#5a2d6b,#9b3fa0)", border: "none", color: "#fff", fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "'Inter',sans-serif", opacity: savingPlan ? 0.5 : 1 }}>
                  {savingPlan ? "Saving…" : "Apply Plan Change"}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Delete confirm */}
        {confirmDelete && (
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
            <div style={{ background: "#1e1030", border: "1px solid rgba(220,60,60,0.4)", borderRadius: 20, padding: "28px 24px", maxWidth: 380, width: "100%" }}>
              <div style={{ fontSize: 36, textAlign: "center", marginBottom: 12 }}>🗑️</div>
              <div style={{ fontFamily: "'Inter',sans-serif", fontSize: 20, fontWeight: 700, color: "#fff", textAlign: "center", marginBottom: 8 }}>Delete {u.name}?</div>
              <div style={{ fontSize: 13, color: "rgba(255,140,140,0.85)", textAlign: "center", lineHeight: 1.6, marginBottom: 24 }}>This will permanently delete their account and remove them from all groups and games. This cannot be undone.</div>
              <div style={{ display: "flex", gap: 10 }}>
                <button onClick={() => setConfirmDelete(false)} style={{ flex: 1, padding: "12px 0", borderRadius: 12, background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.15)", color: "#fff", fontWeight: 700, fontSize: 14, cursor: "pointer", fontFamily: "'Inter',sans-serif" }}>Cancel</button>
                <button onClick={handleDeleteUser} style={{ flex: 1, padding: "12px 0", borderRadius: 12, background: "linear-gradient(135deg,#c0392b,#e74c3c)", border: "none", color: "#fff", fontWeight: 700, fontSize: 14, cursor: "pointer", fontFamily: "'Inter',sans-serif" }}>Delete permanently</button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ── List view ────────────────────────────────────────────────────────────────
  const filtered = users.filter((u) => {
    const q = search.toLowerCase();
    return !q || (u.name || "").toLowerCase().includes(q) || (u.email || "").toLowerCase().includes(q);
  });

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <div style={{ fontFamily: "'Inter',sans-serif", fontSize: 18, color: "#fff" }}>All Users</div>
        <div style={{ fontSize: 13, color: "rgba(255,255,255,0.4)" }}>{users.length} total</div>
      </div>

      <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by name or email…"
        style={{ width: "100%", padding: "11px 16px", borderRadius: 12, fontSize: 14, border: "1.5px solid rgba(155,110,168,0.3)", background: "rgba(255,255,255,0.08)", color: "#fff", fontFamily: "'Inter',sans-serif", outline: "none", boxSizing: "border-box", marginBottom: 18 }}
      />

      {loading && <div style={{ color: "rgba(255,255,255,0.4)", fontSize: 14 }}>Loading…</div>}

      {filtered.map((u) => (
        <div key={u.uid} onClick={() => openDetail(u)} style={{ background: "rgba(255,255,255,0.06)", borderRadius: 14, padding: "13px 16px", marginBottom: 10, border: "1px solid rgba(255,255,255,0.1)", display: "flex", alignItems: "center", gap: 12, cursor: "pointer", transition: "background .15s" }}
          onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.10)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.06)"; }}
        >
          <span style={{ fontSize: 26, flexShrink: 0 }}>{u.avatar || "👤"}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: 15, fontWeight: 700, color: "#fff" }}>{u.name || "Unnamed"}</span>
              {u.isAdmin && <span style={{ fontSize: 11, fontWeight: 800, color: "#e8a0d0", background: "rgba(232,160,208,0.18)", borderRadius: 999, padding: "2px 8px", textTransform: "uppercase", letterSpacing: 1 }}>Admin</span>}
              {planChip(u)}
            </div>
            <div style={{ fontSize: 13, color: "rgba(255,255,255,0.4)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{u.email}</div>
          </div>
          <span style={{ color: "rgba(232,160,208,0.5)", fontSize: 20 }}>›</span>
        </div>
      ))}

      {!loading && filtered.length === 0 && (
        <div style={{ color: "rgba(255,255,255,0.4)", fontSize: 14 }}>No users match your search.</div>
      )}
    </div>
  );
}

/* Logs tab — activity log from Firestore `adminLogs` + log files from Storage */
function AdminLogs() {
  const [logs, setLogs]           = useState([]);
  const [loading, setLoading]     = useState(true);
  const [logFiles, setLogFiles]   = useState([]);
  const [filesLoading, setFilesLoading] = useState(true);

  useEffect(() => {
    const q = query(collection(db, "adminLogs"), orderBy("ts", "desc"));
    const unsub = onSnapshot(q, (snap) => {
      setLogs(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      setLoading(false);
    }, () => setLoading(false));
    return unsub;
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const result = await listAll(storageRef(storage, "logs/"));
        const files = await Promise.all(
          result.items.map(async (item) => {
            const meta = await getMetadata(item);
            return { name: item.name, size: meta.size, created: meta.timeCreated, updated: meta.updated };
          })
        );
        setLogFiles(files.sort((a, b) => new Date(b.updated) - new Date(a.updated)));
      } catch (_) { /* no files yet */ }
      setFilesLoading(false);
    })();
  }, []);

  const fmtTs = (ts) => {
    if (!ts) return "";
    const d = ts.toDate ? ts.toDate() : new Date(ts);
    return d.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  };
  const fmtDate = (iso) => {
    if (!iso) return "—";
    return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  };
  const fmtSize = (bytes) => {
    if (bytes == null) return "—";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  const iconFor = (type) => ({ chat: "💬", game: "🀄", join: "👋", leave: "🚪", rsvp: "✅", admin: "🔐", email: "📧", error: "❌" }[type] || "📝");
  const isError = (type) => type === "error";

  const colHdr = { fontSize: 11, fontWeight: 700, color: "rgba(255,255,255,0.4)", textTransform: "uppercase", letterSpacing: "0.05em" };

  return (
    <div>
      {/* ── Log Files ─────────────────────────────────────────── */}
      <div style={{ fontFamily: "'Inter',sans-serif", fontSize: 18, color: "#fff", marginBottom: 12 }}>Log Files</div>
      {filesLoading && <div style={{ color: "rgba(255,255,255,0.4)", fontSize: 14, marginBottom: 24 }}>Loading…</div>}
      {!filesLoading && logFiles.length === 0 && (
        <div style={{ color: "rgba(255,255,255,0.4)", fontSize: 14, marginBottom: 24 }}>No log files yet.</div>
      )}
      {!filesLoading && logFiles.length > 0 && (
        <div style={{ background: "rgba(255,255,255,0.04)", borderRadius: 12, border: "1px solid rgba(255,255,255,0.08)", marginBottom: 28, overflow: "hidden" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 90px 160px 160px", gap: "0 12px", padding: "8px 16px", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
            <span style={colHdr}>File</span>
            <span style={{ ...colHdr, textAlign: "right" }}>Size</span>
            <span style={colHdr}>Created</span>
            <span style={colHdr}>Modified</span>
          </div>
          {logFiles.map((f) => (
            <div key={f.name} style={{ display: "grid", gridTemplateColumns: "1fr 90px 160px 160px", gap: "0 12px", padding: "10px 16px", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
              <span style={{ fontSize: 13, color: "#fff", fontFamily: "monospace" }}>{f.name}</span>
              <span style={{ fontSize: 13, color: "rgba(255,255,255,0.6)", textAlign: "right" }}>{fmtSize(f.size)}</span>
              <span style={{ fontSize: 12, color: "rgba(255,255,255,0.45)" }}>{fmtDate(f.created)}</span>
              <span style={{ fontSize: 12, color: "rgba(255,255,255,0.45)" }}>{fmtDate(f.updated)}</span>
            </div>
          ))}
        </div>
      )}

      {/* ── Activity Log ──────────────────────────────────────── */}
      <div style={{ fontFamily: "'Inter',sans-serif", fontSize: 18, color: "#fff", marginBottom: 12 }}>Activity Log</div>
      {loading && <div style={{ color: "rgba(255,255,255,0.4)", fontSize: 14 }}>Loading…</div>}
      {!loading && logs.length === 0 && (
        <div style={{ color: "rgba(255,255,255,0.4)", fontSize: 14 }}>No logs yet. Activity will appear here as users interact with the app.</div>
      )}
      {logs.map((log) => (
        <div key={log.id} style={{ background: isError(log.type) ? "rgba(220,60,60,0.1)" : "rgba(255,255,255,0.05)", borderRadius: 12, padding: "12px 16px", marginBottom: 8, border: `1px solid ${isError(log.type) ? "rgba(220,60,60,0.3)" : "rgba(255,255,255,0.08)"}`, display: "flex", gap: 12, alignItems: "flex-start" }}>
          <span style={{ fontSize: 20, flexShrink: 0, marginTop: 1 }}>{iconFor(log.type)}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, color: isError(log.type) ? "#ff9090" : "#fff", fontWeight: 600 }}>{log.message || log.action}</div>
            {log.subject && <div style={{ fontSize: 12, color: "rgba(255,255,255,0.35)", marginTop: 2, fontStyle: "italic" }}>Subject: {log.subject}</div>}
            <div style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", marginTop: 3 }}>
              {log.actorName && <span style={{ marginRight: 8 }}>{log.actorName}</span>}
              {fmtTs(log.ts)}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/* Subscriptions tab — manage subscription tiers */
/* ── ADMIN NOTIFICATIONS TAB ─────────────────────────────────────────────── */
const DEFAULT_FORGOT_PASSWORD_TEMPLATE = {
  type: "email_template",
  key: "forgot_password",
  isSystem: true,
  title: "Forgot Password Email",
  subject: "Reset your Mahjong Club password",
  body: `<p>Hi {{name}},</p>
<p>We received a request to reset your Mahjong Club password. Click the link below to choose a new one:</p>
<p><a href="{{resetLink}}" style="color:#c9607a;font-weight:bold;">Reset my password →</a></p>
<p style="font-size:12px;color:#888;">If the link above doesn't work, copy and paste this URL into your browser:<br>{{resetLink}}</p>
<p>This link expires in 1 hour. If you didn't request a password reset, you can safely ignore this email — your account is secure.</p>
<p>— The Mahjong Club Team</p>`,
  status: "active",
};

function AdminNotifications({ flash, adminUid }) {
  const [notifications, setNotifications] = useState([]);
  const [view, setView] = useState("list"); // "list" | "create" | "editTemplate"
  const [editingNotif, setEditingNotif] = useState(null);
  const [form, setForm] = useState({ type: "announcement", title: "", subject: "", body: "", audience: "all", features: [], status: "draft" });
  const [features, setFeatures] = useState([{ icon: "✨", title: "", description: "" }]);
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(null);

  // Test-send picker
  const [testingNotif, setTestingNotif]   = useState(null);
  const [allUsers, setAllUsers]           = useState([]);
  const [usersLoading, setUsersLoading]   = useState(false);
  const [userSearch, setUserSearch]       = useState("");
  const [testSending, setTestSending]     = useState(false);

  useEffect(() => {
    const unsub = onSnapshot(
      query(collection(db, "adminNotifications"), orderBy("createdAt", "desc")),
      snap => setNotifications(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
      () => {}
    );
    return unsub;
  }, []);

  // Seed the forgot-password template; auto-migrate if it still has the old button HTML
  useEffect(() => {
    getDocs(query(collection(db, "adminNotifications"), where("key", "==", "forgot_password")))
      .then(snap => {
        if (snap.empty) {
          addDoc(collection(db, "adminNotifications"), { ...DEFAULT_FORGOT_PASSWORD_TEMPLATE, createdAt: serverTimestamp(), createdBy: adminUid });
        } else if (snap.docs[0].data().body?.includes("display:inline-block")) {
          updateDoc(snap.docs[0].ref, { body: DEFAULT_FORGOT_PASSWORD_TEMPLATE.body });
        }
      }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const adminS = {
    card: { background: "rgba(255,255,255,0.06)", borderRadius: 16, padding: "18px 20px", border: "1px solid rgba(255,255,255,0.1)", marginBottom: 12 },
    label: { fontSize: 11, fontWeight: 700, color: "rgba(232,160,208,0.8)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6, display: "block", fontFamily: "'Inter',sans-serif" },
    input: { width: "100%", background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 10, padding: "10px 12px", color: "#fff", fontSize: 14, fontFamily: "'Inter',sans-serif", outline: "none", boxSizing: "border-box" },
    btn: (variant = "primary") => ({
      padding: "10px 20px", borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: "'Inter',sans-serif", border: "none",
      background: variant === "primary" ? "linear-gradient(135deg,#c9607a,#9b6ea8)" : variant === "ghost" ? "rgba(255,255,255,0.08)" : "rgba(255,100,100,0.2)",
      color: variant === "danger" ? "#ff8080" : "#fff",
    }),
  };

  const typeLabel    = { push: "Push Notification", announcement: "App Announcement", email: "Email Blast", email_template: "Email Template" };
  const typeIcon     = { push: "🔔", announcement: "📣", email: "📧", email_template: "✉️" };
  const audienceLabel = { all: "All users", google: "Google sign-in users", free: "Free plan", basic: "Basic plan", pro: "Pro plan", club: "Club plan" };
  const statusBadge  = { draft: ["#a0a0c0","Draft"], active: ["#60d0a0","Live"], queued: ["#f0b060","Sending…"], sent: ["#e8a0d0","Sent"], error: ["#ff6b6b","Error"] };

  const resetForm = () => {
    setForm({ type: "announcement", title: "", subject: "", body: "", audience: "all", features: [], status: "draft" });
    setFeatures([{ icon: "✨", title: "", description: "" }]);
    setEditingNotif(null);
  };

  const openEditTemplate = (notif) => {
    setEditingNotif(notif);
    setForm({ ...notif });
    setView("editTemplate");
  };

  const handleSaveTemplate = async () => {
    if (!editingNotif) return;
    setSaving(true);
    try {
      await updateDoc(doc(db, "adminNotifications", editingNotif.id), {
        subject: form.subject,
        body: form.body,
        updatedAt: serverTimestamp(),
      });
      flash("Template saved.", "✅");
      setView("list");
      resetForm();
    } catch { flash("Save failed.", "❌"); }
    setSaving(false);
  };

  const handleSave = async (status) => {
    if (!form.title.trim()) { flash("Title is required.", "⚠️"); return; }
    if (form.type === "email" && !form.subject.trim()) { flash("Subject is required for emails.", "⚠️"); return; }
    setSaving(true);
    try {
      const payload = {
        ...form,
        status,
        features: form.type === "announcement" ? features.filter(f => f.title.trim()) : [],
        createdBy: adminUid,
        createdAt: serverTimestamp(),
        ...(status === "active" ? { publishedAt: serverTimestamp() } : {}),
      };
      await addDoc(collection(db, "adminNotifications"), payload);
      flash(status === "active" ? "Announcement published!" : "Saved as draft.", "✅");
      resetForm();
      setView("list");
    } catch { flash("Save failed.", "❌"); }
    setSaving(false);
  };

  const handlePublish   = async (n) => { try { await updateDoc(doc(db, "adminNotifications", n.id), { status: "active", publishedAt: serverTimestamp() }); flash("Live!", "✅"); } catch { flash("Failed.", "❌"); } };
  const handleUnpublish = async (n) => { try { await updateDoc(doc(db, "adminNotifications", n.id), { status: "draft" }); flash("Unpublished.", "✅"); } catch { flash("Failed.", "❌"); } };
  const handleDelete    = async (n) => { try { await deleteDoc(doc(db, "adminNotifications", n.id)); flash("Deleted.", "✅"); } catch { flash("Failed.", "❌"); } };

  const handleSendPush = async (n) => {
    setSending(n.id);
    try { await updateDoc(doc(db, "adminNotifications", n.id), { status: "queued" }); flash("Push queued — sending now.", "🔔"); }
    catch (e) { flash(`Failed: ${e.message}`, "❌"); }
    setSending(null);
  };

  const handleSendEmail = async (n) => {
    setSending(n.id);
    try { await updateDoc(doc(db, "adminNotifications", n.id), { status: "queued" }); flash("Email blast queued — sending now.", "📧"); }
    catch (e) { flash(`Failed: ${e.message}`, "❌"); }
    setSending(null);
  };

  const openTestPicker = async (n) => {
    setTestingNotif(n);
    setUserSearch("");
    if (allUsers.length === 0) {
      setUsersLoading(true);
      try {
        const snap = await getDocs(collection(db, "users"));
        setAllUsers(snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(u => u.email));
      } catch {}
      setUsersLoading(false);
    }
  };

  const handleSendTest = async (user) => {
    if (!testingNotif || testSending) return;
    setTestSending(true);
    const n = testingNotif;
    try {
      if (n.type === "push") {
        await addDoc(collection(db, "adminNotifications"), {
          type: "push", title: n.title, body: n.body,
          audience: "_test_single_uid", testUid: user.id,
          status: "queued", createdBy: adminUid, createdAt: serverTimestamp(),
        });
      } else {
        const body = (n.body || "")
          .replace(/\{\{name\}\}/g, user.name || user.email.split("@")[0])
          .replace(/\{\{email\}\}/g, user.email)
          .replace(/\{\{resetLink\}\}/g, "[test — no real link in test mode]");
        await addDoc(collection(db, "adminNotifications"), {
          type: "email", title: `[Test] ${n.title}`,
          subject: n.subject, body,
          audience: "_test_single", testRecipient: user.email,
          logResults: true, status: "queued",
          createdBy: adminUid, createdAt: serverTimestamp(),
        });
      }
      flash(`Test sent to ${user.name || user.email}`, "✅");
      setTestingNotif(null);
    } catch (e) { flash(`Failed: ${e.message}`, "❌"); }
    setTestSending(false);
  };

  // ── Edit email template view ──────────────────────────────────────────────
  if (view === "editTemplate") {
    const isSystem = editingNotif?.isSystem;
    return (
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
          <button style={adminS.btn("ghost")} onClick={() => { resetForm(); setView("list"); }}>← Back</button>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: "'Inter',sans-serif", fontSize: 18, fontWeight: 700, color: "#fff" }}>{editingNotif?.title}</div>
            {isSystem && <div style={{ fontSize: 12, color: "rgba(232,160,208,0.7)", marginTop: 2 }}>System template — used automatically by the app</div>}
          </div>
        </div>

        <div style={adminS.card}>
          <label style={adminS.label}>Email subject</label>
          <input style={adminS.input} value={form.subject || ""} onChange={e => setForm(f => ({ ...f, subject: e.target.value }))} placeholder="Subject line" />
        </div>

        <div style={adminS.card}>
          <label style={adminS.label}>Email body (HTML)</label>
          <div style={{ fontSize: 12, color: "rgba(255,255,255,0.45)", marginBottom: 8, fontFamily: "'Inter',sans-serif" }}>
            Available placeholders: <code style={{ background: "rgba(255,255,255,0.1)", borderRadius: 4, padding: "1px 5px" }}>{"{{name}}"}</code>
            {editingNotif?.key === "forgot_password" && <> <code style={{ background: "rgba(255,255,255,0.1)", borderRadius: 4, padding: "1px 5px" }}>{"{{resetLink}}"}</code> <code style={{ background: "rgba(255,255,255,0.1)", borderRadius: 4, padding: "1px 5px" }}>{"{{email}}"}</code></>}
          </div>
          <textarea style={{ ...adminS.input, resize: "vertical", minHeight: 260, fontFamily: "monospace", fontSize: 12 }} value={form.body || ""} onChange={e => setForm(f => ({ ...f, body: e.target.value }))} placeholder="HTML email body" />
        </div>

        <button style={{ ...adminS.btn("primary"), width: "100%" }} disabled={saving} onClick={handleSaveTemplate}>{saving ? "Saving…" : "Save Template"}</button>
      </div>
    );
  }

  // ── Create notification view ──────────────────────────────────────────────
  if (view === "create") {
    return (
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
          <button style={adminS.btn("ghost")} onClick={() => { resetForm(); setView("list"); }}>← Back</button>
          <div style={{ fontFamily: "'Inter',sans-serif", fontSize: 18, fontWeight: 700, color: "#fff" }}>New Notification</div>
        </div>

        <div style={adminS.card}>
          <label style={adminS.label}>Type</label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {[["announcement","📣 App Announcement"],["push","🔔 Push"],["email","📧 Email"]].map(([t, l]) => (
              <button key={t} onClick={() => setForm(f => ({ ...f, type: t }))} style={{ ...adminS.btn(form.type === t ? "primary" : "ghost"), flex: 1, minWidth: 120 }}>{l}</button>
            ))}
          </div>
        </div>

        <div style={adminS.card}>
          <label style={adminS.label}>Title{form.type === "email" ? " (internal label)" : ""}</label>
          <input style={adminS.input} value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
            placeholder={form.type === "announcement" ? "What's New in Mahjong Club" : form.type === "email" ? "e.g. May newsletter" : "Notification title"} />
          {form.type === "email" && <>
            <label style={{ ...adminS.label, marginTop: 14 }}>Email subject</label>
            <input style={adminS.input} value={form.subject} onChange={e => setForm(f => ({ ...f, subject: e.target.value }))} placeholder="Subject line recipients will see" />
          </>}
          <label style={{ ...adminS.label, marginTop: 14 }}>
            {form.type === "announcement" ? "Subtitle (optional)" : form.type === "email" ? "Email body (HTML)" : "Message body"}
          </label>
          <textarea
            style={{ ...adminS.input, resize: "vertical", minHeight: form.type === "email" ? 200 : 72, ...(form.type === "email" ? { fontFamily: "monospace", fontSize: 12 } : {}) }}
            value={form.body} onChange={e => setForm(f => ({ ...f, body: e.target.value }))}
            placeholder={form.type === "email" ? "<p>Hi {{name}},</p><p>Your message here…</p>" : form.type === "announcement" ? "A short description" : "The notification message"}
          />
          {form.type === "email" && (
            <div style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", marginTop: 6, fontFamily: "'Inter',sans-serif" }}>
              Placeholders: <code style={{ background: "rgba(255,255,255,0.1)", borderRadius: 4, padding: "1px 5px" }}>{"{{name}}"}</code> <code style={{ background: "rgba(255,255,255,0.1)", borderRadius: 4, padding: "1px 5px" }}>{"{{email}}"}</code>
            </div>
          )}
        </div>

        {(form.type === "push" || form.type === "email") && (
          <div style={adminS.card}>
            <label style={adminS.label}>Audience</label>
            <select style={adminS.input} value={form.audience} onChange={e => setForm(f => ({ ...f, audience: e.target.value }))}>
              {Object.entries(audienceLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
        )}

        {form.type === "announcement" && (
          <div style={adminS.card}>
            <label style={adminS.label}>Feature highlights</label>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {features.map((f, i) => (
                <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                  <input style={{ ...adminS.input, width: 52, textAlign: "center", fontSize: 22, padding: "8px 4px", flexShrink: 0 }} value={f.icon} onChange={e => setFeatures(fs => fs.map((x, j) => j === i ? { ...x, icon: e.target.value } : x))} maxLength={4} />
                  <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
                    <input style={adminS.input} value={f.title} onChange={e => setFeatures(fs => fs.map((x, j) => j === i ? { ...x, title: e.target.value } : x))} placeholder="Feature name" />
                    <input style={adminS.input} value={f.description} onChange={e => setFeatures(fs => fs.map((x, j) => j === i ? { ...x, description: e.target.value } : x))} placeholder="Short description" />
                  </div>
                  {features.length > 1 && <button onClick={() => setFeatures(fs => fs.filter((_, j) => j !== i))} style={{ ...adminS.btn("danger"), padding: "8px 12px", flexShrink: 0 }}>✕</button>}
                </div>
              ))}
              <button onClick={() => setFeatures(fs => [...fs, { icon: "✨", title: "", description: "" }])} style={{ ...adminS.btn("ghost"), alignSelf: "flex-start" }}>+ Add Feature</button>
            </div>
          </div>
        )}

        <div style={{ display: "flex", gap: 10 }}>
          <button style={{ ...adminS.btn("ghost"), flex: 1 }} disabled={saving} onClick={() => handleSave("draft")}>{saving ? "Saving…" : "Save Draft"}</button>
          <button style={{ ...adminS.btn("primary"), flex: 1 }} disabled={saving} onClick={() => handleSave(form.type === "announcement" ? "active" : "draft")}>
            {saving ? "…" : form.type === "announcement" ? "Publish Now" : "Save"}
          </button>
        </div>
      </div>
    );
  }

  // ── User picker modal ────────────────────────────────────────────────────
  const filteredUsers = allUsers.filter(u => {
    const q = userSearch.toLowerCase();
    return !q || (u.name || "").toLowerCase().includes(q) || (u.email || "").toLowerCase().includes(q);
  });

  const TestPickerModal = testingNotif ? (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }} onClick={() => setTestingNotif(null)}>
      <div style={{ background: "#1e1230", border: "1px solid rgba(232,160,208,0.3)", borderRadius: 18, padding: 24, width: "100%", maxWidth: 420, maxHeight: "70vh", display: "flex", flexDirection: "column", gap: 16 }} onClick={e => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontFamily: "'Inter',sans-serif", fontSize: 16, fontWeight: 700, color: "#fff" }}>Send Notification Test</div>
            <div style={{ fontSize: 12, color: "rgba(255,255,255,0.45)", marginTop: 2 }}>"{testingNotif.title}"</div>
          </div>
          <button style={{ ...adminS.btn("ghost"), padding: "6px 12px", fontSize: 16 }} onClick={() => setTestingNotif(null)}>✕</button>
        </div>
        <input
          style={{ ...adminS.input, flexShrink: 0 }}
          placeholder="Search users…"
          value={userSearch}
          onChange={e => setUserSearch(e.target.value)}
          autoFocus
        />
        <div style={{ overflowY: "auto", flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
          {usersLoading && <div style={{ color: "rgba(255,255,255,0.4)", fontSize: 13, textAlign: "center", padding: 16 }}>Loading users…</div>}
          {!usersLoading && filteredUsers.length === 0 && <div style={{ color: "rgba(255,255,255,0.4)", fontSize: 13, textAlign: "center", padding: 16 }}>No users found.</div>}
          {filteredUsers.map(u => (
            <button
              key={u.id}
              disabled={testSending}
              onClick={() => handleSendTest(u)}
              style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 10, padding: "10px 14px", cursor: "pointer", textAlign: "left", display: "flex", flexDirection: "column", gap: 2, opacity: testSending ? 0.5 : 1 }}
            >
              <span style={{ fontSize: 14, fontWeight: 600, color: "#fff", fontFamily: "'Inter',sans-serif" }}>{u.name || "(no name)"}</span>
              <span style={{ fontSize: 12, color: "rgba(255,255,255,0.45)" }}>{u.email}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  ) : null;

  // ── List view ─────────────────────────────────────────────────────────────
  const systemEntries  = notifications.filter(n => n.isSystem);
  const regularEntries = notifications.filter(n => !n.isSystem);

  return (
    <div>
      {TestPickerModal}

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <div style={{ fontFamily: "'Inter',sans-serif", fontSize: 18, fontWeight: 700, color: "#fff" }}>Notification Templates</div>
        <button style={adminS.btn("primary")} onClick={() => setView("create")}>+ New</button>
      </div>

      {/* System templates section */}
      {systemEntries.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "rgba(232,160,208,0.6)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 10, fontFamily: "'Inter',sans-serif" }}>System Templates</div>
          {systemEntries.map(n => (
            <div key={n.id} style={{ ...adminS.card, borderColor: "rgba(232,160,208,0.2)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{ fontSize: 28, lineHeight: 1 }}>✉️</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span style={{ fontFamily: "'Inter',sans-serif", fontSize: 15, fontWeight: 700, color: "#fff" }}>{n.title}</span>
                    <span style={{ fontSize: 11, fontWeight: 700, color: "#e8a0d0", background: "rgba(232,160,208,0.15)", borderRadius: 999, padding: "2px 8px", textTransform: "uppercase", letterSpacing: 0.5 }}>System</span>
                  </div>
                  <div style={{ fontSize: 12, color: "rgba(255,255,255,0.45)", marginTop: 3, fontFamily: "'Inter',sans-serif" }}>
                    {n.subject && `Subject: ${n.subject}`}
                  </div>
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
                <button style={{ ...adminS.btn("ghost"), fontSize: 13, padding: "7px 14px" }} onClick={() => openEditTemplate(n)}>Edit Template</button>
                <button style={{ ...adminS.btn("ghost"), fontSize: 13, padding: "7px 14px" }} onClick={() => openTestPicker(n)}>Send Test</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Regular notifications */}
      <div style={{ fontSize: 11, fontWeight: 700, color: "rgba(232,160,208,0.6)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 10, fontFamily: "'Inter',sans-serif" }}>Notifications & Announcements</div>
      {regularEntries.length === 0 ? (
        <div style={{ textAlign: "center", padding: "40px 20px", background: "rgba(255,255,255,0.03)", borderRadius: 16, border: "1px dashed rgba(255,255,255,0.12)" }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>📣</div>
          <div style={{ fontFamily: "'Inter',sans-serif", fontSize: 16, fontWeight: 700, color: "#fff", marginBottom: 8 }}>No notifications yet</div>
          <div style={{ fontSize: 13, color: "rgba(255,255,255,0.45)", marginBottom: 20 }}>Create a push notification, email blast, or app announcement.</div>
          <button style={adminS.btn("primary")} onClick={() => setView("create")}>Create First Notification</button>
        </div>
      ) : (
        regularEntries.map(n => {
          const [badgeColor, badgeText] = statusBadge[n.status] || ["#a0a0c0", n.status];
          return (
            <div key={n.id} style={adminS.card}>
              <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                <div style={{ fontSize: 28, lineHeight: 1 }}>{typeIcon[n.type] || "📣"}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span style={{ fontFamily: "'Inter',sans-serif", fontSize: 15, fontWeight: 700, color: "#fff" }}>{n.title}</span>
                    <span style={{ fontSize: 11, fontWeight: 700, color: badgeColor, background: `${badgeColor}22`, borderRadius: 999, padding: "2px 8px", textTransform: "uppercase", letterSpacing: 0.5 }}>{badgeText}</span>
                  </div>
                  <div style={{ fontSize: 12, color: "rgba(255,255,255,0.45)", marginTop: 3, fontFamily: "'Inter',sans-serif" }}>
                    {typeLabel[n.type] || n.type}
                    {(n.type === "push" || n.type === "email") && ` · ${audienceLabel[n.audience] || n.audience}`}
                    {n.recipientCount != null && ` · ${n.recipientCount} recipients`}
                    {n.emailsSent != null && ` · ${n.emailsSent} emails sent`}
                    {n.createdAt && ` · ${new Date(n.createdAt.toMillis()).toLocaleDateString()}`}
                  </div>
                  {n.type === "email" && n.subject && <div style={{ fontSize: 12, color: "rgba(255,255,255,0.55)", marginTop: 4, fontFamily: "'Inter',sans-serif" }}>Subject: {n.subject}</div>}
                  {n.type === "announcement" && n.features?.length > 0 && (
                    <div style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", marginTop: 4 }}>{n.features.length} feature{n.features.length !== 1 ? "s" : ""}: {n.features.map(f => f.title).filter(Boolean).join(", ")}</div>
                  )}
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
                {n.type === "push"  && n.status !== "sent" && n.status !== "queued" && <button style={{ ...adminS.btn("primary"), fontSize: 13, padding: "7px 14px" }} disabled={sending === n.id} onClick={() => handleSendPush(n)}>{sending === n.id ? "Sending…" : "Send Push"}</button>}
                {n.type === "email" && n.status !== "sent" && n.status !== "queued" && <button style={{ ...adminS.btn("primary"), fontSize: 13, padding: "7px 14px" }} disabled={sending === n.id} onClick={() => handleSendEmail(n)}>{sending === n.id ? "Sending…" : "Send Email"}</button>}
                {n.type === "announcement" && n.status === "draft"  && <button style={{ ...adminS.btn("primary"), fontSize: 13, padding: "7px 14px" }} onClick={() => handlePublish(n)}>Publish</button>}
                {n.type === "announcement" && n.status === "active" && <button style={{ ...adminS.btn("ghost"),   fontSize: 13, padding: "7px 14px" }} onClick={() => handleUnpublish(n)}>Unpublish</button>}
                {(n.type === "push" || n.type === "email") && <button style={{ ...adminS.btn("ghost"), fontSize: 13, padding: "7px 14px" }} onClick={() => openTestPicker(n)}>Send Test</button>}
                <button style={{ ...adminS.btn("danger"), fontSize: 13, padding: "7px 14px" }} onClick={() => handleDelete(n)}>Delete</button>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}

function AdminSubscriptions({ flash, packages, adminUid }) {
  const [loading] = useState(false);
  const [view, setView] = useState("list"); // "list" | "detail" | "edit" | "new"
  const [selected, setSelected] = useState(null); // package object being viewed/edited
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [userCounts, setUserCounts] = useState({}); // { [planKey]: number }
  // Users list for detail view
  const [planUsers, setPlanUsers] = useState([]);        // users on current plan
  const [planUsersLoading, setPlanUsersLoading] = useState(false);
  // Inline plan-change within subscription detail
  const [changingUser, setChangingUser] = useState(null); // user obj
  const [changePlanKey, setChangePlanKey] = useState("");
  const [changePlanNote, setChangePlanNote] = useState("");
  const [savingChange, setSavingChange] = useState(false);

  const EMPTY_FORM = {
    planKey: "", name: "", price: "0", interval: "month", description: "", features: "",
    limitMaxGroups: "", limitGamesPerCycle: "", limitCycleDays: "30", limitAllowRecurring: false,
    paymentLink: "",
  };

  // Count users per plan key.
  // Users without subscription.plan set are implicitly "free" (matches getPlan() logic),
  // so we load all users once and tally by subscription?.plan || "free".
  useEffect(() => {
    if (packages.length === 0) return;
    getDocs(collection(db, "users")).then((snap) => {
      const counts = {};
      snap.docs.forEach((d) => {
        const key = d.data()?.subscription?.plan || "free";
        counts[key] = (counts[key] || 0) + 1;
      });
      setUserCounts(counts);
    }).catch(() => {});
  }, [packages]);

  const pkgToForm = (pkg) => ({
    planKey: pkg.planKey || "",
    name: pkg.name || "",
    price: String(pkg.price ?? "0"),
    interval: pkg.interval || "month",
    description: pkg.description || "",
    features: (pkg.features || []).join("\n"),
    limitMaxGroups:     pkg.limits?.maxGroups     != null ? String(pkg.limits.maxGroups)     : "",
    limitGamesPerCycle: pkg.limits?.gamesPerCycle != null ? String(pkg.limits.gamesPerCycle) : "",
    limitCycleDays:     String(pkg.limits?.cycleDays ?? "30"),
    limitAllowRecurring: pkg.limits?.allowRecurring ?? false,
    paymentLink: pkg.paymentLink || "",
  });

  const formToData = (f) => ({
    planKey: f.planKey.trim().toLowerCase().replace(/\s+/g, "_"),
    name: f.name.trim(),
    price: parseFloat(f.price) || 0,
    interval: f.interval,
    description: f.description.trim(),
    features: f.features.split("\n").map((s) => s.trim()).filter(Boolean),
    limits: {
      maxGroups:     f.limitMaxGroups.trim()     !== "" ? parseInt(f.limitMaxGroups, 10)     : null,
      gamesPerCycle: f.limitGamesPerCycle.trim() !== "" ? parseInt(f.limitGamesPerCycle, 10) : null,
      cycleDays:     parseInt(f.limitCycleDays, 10) || 30,
      allowRecurring: !!f.limitAllowRecurring,
    },
    paymentLink: f.paymentLink?.trim() || "",
    updatedAt: serverTimestamp(),
  });

  const openNew = () => { setForm(EMPTY_FORM); setSelected(null); setView("new"); };
  const openDetail = (pkg) => {
    setSelected(pkg);
    setView("detail");
    setChangingUser(null);
    setPlanUsers([]);
    // Load users on this plan
    const key = pkg.planKey || pkg.id;
    setPlanUsersLoading(true);
    getDocs(collection(db, "users")).then((snap) => {
      const list = snap.docs
        .map((d) => ({ uid: d.id, ...d.data() }))
        .filter((u) => (u.subscription?.plan || "free") === key)
        .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
      setPlanUsers(list);
    }).catch(() => {}).finally(() => setPlanUsersLoading(false));
  };
  const openEdit = (pkg) => { setForm(pkgToForm(pkg)); setSelected(pkg); setView("edit"); };

  const applyPlanChange = async () => {
    if (!changingUser) return;
    setSavingChange(true);
    const newSub = { plan: changePlanKey, overrideNote: changePlanNote.trim(), changedAt: Date.now(), changedBy: adminUid };
    try {
      await updateDoc(doc(db, "users", changingUser.uid), { subscription: newSub });
      setPlanUsers((prev) => prev.filter((u) => u.uid !== changingUser.uid));
      setUserCounts((prev) => {
        const oldKey = changingUser.subscription?.plan || "free";
        const counts = { ...prev };
        counts[oldKey] = Math.max(0, (counts[oldKey] || 0) - 1);
        counts[changePlanKey] = (counts[changePlanKey] || 0) + 1;
        return counts;
      });
      flash(`${changingUser.name} moved to "${changePlanKey}"`);
      setChangingUser(null);
    } catch { flash("Failed to update plan"); }
    setSavingChange(false);
  };

  const save = async () => {
    if (!form.name.trim() || !form.planKey.trim()) return;
    setSaving(true);
    const data = formToData(form);
    try {
      if (view === "new") {
        // Use planKey as the document ID so the app can look it up by key
        await setDoc(doc(db, "subscriptionPackages", data.planKey), { ...data, createdAt: serverTimestamp() });
        flash("Plan created — changes live for all users on this plan");
      } else {
        await updateDoc(doc(db, "subscriptionPackages", selected.id), data);
        flash("Plan updated — changes pushed to all users on this plan");
      }
      setView("list");
    } catch (e) { flash("Failed to save: " + e.message); }
    setSaving(false);
  };

  const remove = async (pkg) => {
    const count = userCounts[pkg.planKey || pkg.id] || 0;
    const msg = count > 0
      ? `Delete "${pkg.name}"? This plan has ${count} user${count === 1 ? "" : "s"}. They will fall back to Free plan defaults.`
      : `Delete "${pkg.name}"? This cannot be undone.`;
    if (!window.confirm(msg)) return;
    try {
      await deleteDoc(doc(db, "subscriptionPackages", pkg.id));
      flash("Plan deleted");
      if (view === "detail") setView("list");
    } catch { flash("Failed to delete plan"); }
  };

  const inp = { width: "100%", padding: "10px 14px", borderRadius: 10, fontSize: 14, border: "1.5px solid rgba(155,110,168,0.3)", background: "rgba(255,255,255,0.08)", color: "#fff", fontFamily: "'Inter',sans-serif", outline: "none", boxSizing: "border-box", marginBottom: 10 };
  const Lbl2 = ({ children }) => <div style={{ fontSize: 11, fontWeight: 800, color: "rgba(232,160,208,0.7)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 5, fontFamily: "'Inter',sans-serif" }}>{children}</div>;
  const numInp = (field, label, min = 1, placeholder = "") => (
    <div style={{ flex: 1 }}>
      <Lbl2>{label}</Lbl2>
      <input type="number" min={min} value={form[field] ?? ""} placeholder={placeholder} onChange={(e) => setForm({ ...form, [field]: e.target.value })} style={{ ...inp, marginBottom: 0 }} />
    </div>
  );

  // ── Edit / New form ──────────────────────────────────────────────────────────
  if (view === "edit" || view === "new") {
    const isNew = view === "new";
    return (
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 22 }}>
          <button onClick={() => setView(isNew ? "list" : "detail")} style={{ background: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 10, padding: "6px 14px", color: "#fff", fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "'Inter',sans-serif" }}>← Back</button>
          <div style={{ fontFamily: "'Inter',sans-serif", fontSize: 18, color: "#fff" }}>{isNew ? "New Plan" : `Edit — ${selected?.name}`}</div>
        </div>

        <Lbl2>Plan Key (ID)</Lbl2>
        <input value={form.planKey} onChange={(e) => setForm({ ...form, planKey: e.target.value })} placeholder="e.g. free, pro, club" disabled={!isNew} style={{ ...inp, opacity: isNew ? 1 : 0.5 }} />
        {isNew && <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", marginTop: -6, marginBottom: 10, fontFamily: "'Inter',sans-serif" }}>Permanent ID used in code. Use lowercase letters only (e.g. "free", "pro").</div>}

        <Lbl2>Display Name</Lbl2>
        <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Free, Pro, Club" style={inp} />

        <div style={{ display: "flex", gap: 10 }}>
          <div style={{ flex: 1 }}>
            <Lbl2>Price</Lbl2>
            <input value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} placeholder="0" type="number" min="0" step="0.01" style={{ ...inp, marginBottom: 0 }} />
          </div>
          <div style={{ flex: 1 }}>
            <Lbl2>Billing</Lbl2>
            <select value={form.interval} onChange={(e) => setForm({ ...form, interval: e.target.value })} style={{ ...inp, marginBottom: 0 }}>
              <option value="month">/ month</option>
              <option value="year">/ year</option>
              <option value="once">one-time</option>
              <option value="free">Free</option>
            </select>
          </div>
        </div>
        <div style={{ height: 10 }} />

        <Lbl2>Stripe Payment Link</Lbl2>
        <input value={form.paymentLink} onChange={(e) => setForm({ ...form, paymentLink: e.target.value })} placeholder="https://buy.stripe.com/..." style={inp} />
        <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", marginTop: -6, marginBottom: 10, fontFamily: "'Inter',sans-serif" }}>Paste the Stripe payment link for this plan. Used when users click to subscribe.</div>

        <Lbl2>Description</Lbl2>
        <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Short description shown to users" style={inp} />

        <Lbl2>Features (one per line — shown in Account)</Lbl2>
        <textarea value={form.features} onChange={(e) => setForm({ ...form, features: e.target.value })} placeholder={"Group & game chat\nSend group and game invites\nAdd games to calendar"} rows={4} style={{ ...inp, resize: "vertical" }} />

        {/* Limits section */}
        <div style={{ background: "rgba(255,255,255,0.05)", borderRadius: 14, padding: "16px", marginBottom: 10, border: "1px solid rgba(155,110,168,0.25)" }}>
          <div style={{ fontFamily: "'Inter',sans-serif", fontSize: 15, color: "#e8a0d0", marginBottom: 14 }}>Plan Limits</div>
          <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
            {numInp("limitMaxGroups", "Max Groups", 1, "Unlimited")}
            {numInp("limitGamesPerCycle", "Hosted Games / Cycle", 1, "Unlimited")}
            {numInp("limitCycleDays", "Cycle Days")}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div onClick={() => setForm({ ...form, limitAllowRecurring: !form.limitAllowRecurring })} style={{
              width: 42, height: 24, borderRadius: 999, cursor: "pointer", flexShrink: 0,
              background: form.limitAllowRecurring ? "linear-gradient(135deg,#5a2d6b,#9b3fa0)" : "rgba(255,255,255,0.15)",
              position: "relative", transition: "background .2s",
            }}>
              <div style={{ width: 18, height: 18, borderRadius: 999, background: "#fff", position: "absolute", top: 3, left: form.limitAllowRecurring ? 21 : 3, transition: "left .2s", boxShadow: "0 1px 4px rgba(0,0,0,.25)" }} />
            </div>
            <div style={{ fontSize: 14, color: "#fff", fontFamily: "'Inter',sans-serif" }}>Allow recurring games</div>
          </div>
        </div>

        <div style={{ display: "flex", gap: 10, marginTop: 6 }}>
          <button onClick={() => setView(isNew ? "list" : "detail")} style={{ flex: 1, padding: "11px", borderRadius: 12, background: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.2)", color: "#fff", fontWeight: 700, fontSize: 14, cursor: "pointer", fontFamily: "'Inter',sans-serif" }}>Cancel</button>
          <button onClick={save} disabled={saving || !form.name.trim() || !form.planKey.trim()} style={{ flex: 2, padding: "11px", borderRadius: 12, background: "linear-gradient(135deg,#5a2d6b,#9b3fa0)", border: "none", color: "#fff", fontWeight: 700, fontSize: 14, cursor: "pointer", fontFamily: "'Inter',sans-serif", opacity: (saving || !form.name.trim() || !form.planKey.trim()) ? 0.5 : 1 }}>
            {saving ? "Saving…" : "Save & Push to Users"}
          </button>
        </div>
      </div>
    );
  }

  // ── Detail view ──────────────────────────────────────────────────────────────
  if (view === "detail" && selected) {
    const pkg = packages.find((p) => p.id === selected.id) || selected;
    const planKey = pkg.planKey || pkg.id;
    const count = userCounts[planKey] ?? "—";
    const lim = pkg.limits || {};
    return (
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 22 }}>
          <button onClick={() => setView("list")} style={{ background: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 10, padding: "6px 14px", color: "#fff", fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "'Inter',sans-serif" }}>← Plans</button>
          <div style={{ fontFamily: "'Inter',sans-serif", fontSize: 18, color: "#fff", flex: 1 }}>{pkg.name}</div>
          <button onClick={() => openEdit(pkg)} style={{ background: "linear-gradient(135deg,#5a2d6b,#9b3fa0)", border: "none", borderRadius: 10, padding: "7px 16px", color: "#fff", fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "'Inter',sans-serif" }}>Edit</button>
        </div>

        {/* Plan overview */}
        <div style={{ background: "rgba(255,255,255,0.06)", borderRadius: 16, padding: "18px 20px", marginBottom: 14, border: "1px solid rgba(155,110,168,0.2)" }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 20, marginBottom: pkg.description ? 12 : 0 }}>
            {[
              ["Plan Key", planKey],
              ["Price", pkg.price === 0 ? "Free" : `$${pkg.price} / ${pkg.interval}`],
              ["Users on this plan", count],
            ].map(([lbl, val]) => (
              <div key={lbl}>
                <div style={{ fontSize: 11, fontWeight: 800, color: "rgba(232,160,208,0.6)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 3, fontFamily: "'Inter',sans-serif" }}>{lbl}</div>
                <div style={{ fontSize: 16, color: "#fff", fontWeight: 700, fontFamily: "'Inter',sans-serif" }}>{String(val)}</div>
              </div>
            ))}
          </div>
          {pkg.description && <div style={{ fontSize: 13, color: "rgba(255,255,255,0.55)", fontFamily: "'Inter',sans-serif" }}>{pkg.description}</div>}
          {pkg.paymentLink && (
            <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid rgba(155,110,168,0.2)" }}>
              <div style={{ fontSize: 11, fontWeight: 800, color: "rgba(232,160,208,0.6)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 4, fontFamily: "'Inter',sans-serif" }}>Payment Link</div>
              <a href={pkg.paymentLink} target="_blank" rel="noreferrer" style={{ fontSize: 13, color: "#c084fc", fontFamily: "'Inter',sans-serif", wordBreak: "break-all" }}>{pkg.paymentLink}</a>
            </div>
          )}
        </div>

        {/* Limits */}
        <div style={{ background: "rgba(255,255,255,0.06)", borderRadius: 16, padding: "18px 20px", marginBottom: 14, border: "1px solid rgba(155,110,168,0.2)" }}>
          <div style={{ fontFamily: "'Inter',sans-serif", fontSize: 15, color: "#e8a0d0", marginBottom: 14 }}>Plan Limits</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            {[
              ["Max Groups", lim.maxGroups != null ? lim.maxGroups : "∞"],
              ["Hosted Games / Cycle", lim.gamesPerCycle != null ? lim.gamesPerCycle : "∞"],
              ["Cycle Duration", `${lim.cycleDays ?? 30} days`],
              ["Recurring Games", lim.allowRecurring ? "✅ Allowed" : "🔒 Locked"],
            ].map(([lbl, val]) => (
              <div key={lbl} style={{ background: "rgba(255,255,255,0.04)", borderRadius: 10, padding: "10px 14px" }}>
                <div style={{ fontSize: 11, fontWeight: 800, color: "rgba(232,160,208,0.6)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 4, fontFamily: "'Inter',sans-serif" }}>{lbl}</div>
                <div style={{ fontSize: 18, color: "#fff", fontWeight: 700, fontFamily: "'Inter',sans-serif" }}>{String(val)}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Features */}
        {pkg.features?.length > 0 && (
          <div style={{ background: "rgba(255,255,255,0.06)", borderRadius: 16, padding: "18px 20px", marginBottom: 14, border: "1px solid rgba(155,110,168,0.2)" }}>
            <div style={{ fontFamily: "'Inter',sans-serif", fontSize: 15, color: "#e8a0d0", marginBottom: 12 }}>Included Features</div>
            {pkg.features.map((f, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 14, color: "rgba(255,255,255,0.8)", fontFamily: "'Inter',sans-serif", marginBottom: 7 }}>
                <span style={{ color: "#9b3fa0", fontWeight: 700, fontSize: 16 }}>✓</span> {f}
              </div>
            ))}
          </div>
        )}

        {/* Users on this plan */}
        <div style={{ background: "rgba(255,255,255,0.06)", borderRadius: 16, padding: "18px 20px", marginBottom: 14, border: "1px solid rgba(155,110,168,0.2)" }}>
          <div style={{ fontFamily: "'Inter',sans-serif", fontSize: 15, color: "#e8a0d0", marginBottom: 14 }}>
            Users on this plan ({planUsersLoading ? "…" : planUsers.length})
          </div>
          {planUsersLoading && <div style={{ fontSize: 13, color: "rgba(255,255,255,0.35)" }}>Loading…</div>}
          {!planUsersLoading && planUsers.length === 0 && (
            <div style={{ fontSize: 13, color: "rgba(255,255,255,0.35)", fontFamily: "'Inter',sans-serif" }}>No users on this plan.</div>
          )}
          {planUsers.map((u) => (
            <div key={u.uid}>
              {changingUser?.uid === u.uid ? (
                // Inline plan-change form
                <div style={{ background: "rgba(155,63,160,0.12)", borderRadius: 12, padding: "12px 14px", marginBottom: 8, border: "1px solid rgba(155,63,160,0.3)" }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#fff", marginBottom: 10, fontFamily: "'Inter',sans-serif" }}>
                    Move {u.name} to…
                  </div>
                  <select value={changePlanKey} onChange={(e) => setChangePlanKey(e.target.value)} style={{ width: "100%", padding: "8px 12px", borderRadius: 8, fontSize: 13, border: "1px solid rgba(155,110,168,0.4)", background: "rgba(255,255,255,0.1)", color: "#fff", fontFamily: "'Inter',sans-serif", marginBottom: 8, outline: "none" }}>
                    <option value="free">Free (default)</option>
                    {packages.map((p) => {
                      const k = p.planKey || p.id;
                      return <option key={p.id} value={k}>{p.name}{p.price > 0 ? ` — $${p.price}/${p.interval}` : ""}</option>;
                    })}
                  </select>
                  <input value={changePlanNote} onChange={(e) => setChangePlanNote(e.target.value)} placeholder="Admin note (optional)" style={{ width: "100%", padding: "8px 12px", borderRadius: 8, fontSize: 13, border: "1px solid rgba(155,110,168,0.3)", background: "rgba(255,255,255,0.08)", color: "#fff", fontFamily: "'Inter',sans-serif", marginBottom: 10, outline: "none", boxSizing: "border-box" }} />
                  <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={() => setChangingUser(null)} style={{ flex: 1, padding: "7px", borderRadius: 8, background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.15)", color: "#fff", fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: "'Inter',sans-serif" }}>Cancel</button>
                    <button onClick={applyPlanChange} disabled={savingChange} style={{ flex: 2, padding: "7px", borderRadius: 8, background: "linear-gradient(135deg,#5a2d6b,#9b3fa0)", border: "none", color: "#fff", fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: "'Inter',sans-serif", opacity: savingChange ? 0.5 : 1 }}>
                      {savingChange ? "Saving…" : "Apply"}
                    </button>
                  </div>
                </div>
              ) : (
                <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 0", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                  <span style={{ fontSize: 22, flexShrink: 0 }}>{u.avatar || "👤"}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: "#fff" }}>{u.name}</div>
                    <div style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{u.email}</div>
                    {u.subscription?.overrideNote && (
                      <div style={{ fontSize: 11, color: "#e8a0d0", marginTop: 2 }}>📝 {u.subscription.overrideNote}</div>
                    )}
                  </div>
                  <button onClick={() => { setChangingUser(u); setChangePlanKey(u.subscription?.plan || "free"); setChangePlanNote(u.subscription?.overrideNote || ""); }} style={{ padding: "5px 11px", borderRadius: 8, background: "rgba(155,63,160,0.2)", border: "1px solid rgba(155,63,160,0.35)", color: "#e8a0d0", fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: "'Inter',sans-serif", flexShrink: 0 }}>
                    Change Plan
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>

        <button onClick={() => remove(pkg)} style={{ width: "100%", padding: "11px", borderRadius: 12, background: "rgba(200,50,80,0.15)", border: "1px solid rgba(200,50,80,0.3)", color: "#e87070", fontWeight: 700, fontSize: 14, cursor: "pointer", fontFamily: "'Inter',sans-serif", marginTop: 4 }}>
          Delete Plan
        </button>
      </div>
    );
  }

  // ── List view ────────────────────────────────────────────────────────────────
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <div style={{ fontFamily: "'Inter',sans-serif", fontSize: 18, color: "#fff" }}>Subscription Plans</div>
        <button onClick={openNew} style={{ background: "linear-gradient(135deg,#5a2d6b,#9b3fa0)", border: "none", borderRadius: 10, padding: "8px 16px", color: "#fff", fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "'Inter',sans-serif" }}>+ New Plan</button>
      </div>

      {loading && <div style={{ color: "rgba(255,255,255,0.4)", fontSize: 14 }}>Loading…</div>}
      {!loading && packages.length === 0 && (
        <div style={{ color: "rgba(255,255,255,0.5)", fontSize: 14, marginBottom: 16, lineHeight: 1.6 }}>
          No plans yet. Create the <strong style={{ color: "#e8a0d0" }}>free</strong> plan first — use Plan Key <code style={{ background: "rgba(255,255,255,0.1)", borderRadius: 4, padding: "1px 6px" }}>free</code> so limits sync to all free-tier users.
        </div>
      )}

      {packages.map((pkg) => {
        const planKey = pkg.planKey || pkg.id;
        const count = userCounts[planKey] ?? "—";
        const lim = pkg.limits || {};
        return (
          <div key={pkg.id} onClick={() => openDetail(pkg)} style={{ background: "rgba(255,255,255,0.06)", borderRadius: 16, padding: "18px 20px", marginBottom: 12, border: "1px solid rgba(155,110,168,0.2)", cursor: "pointer", transition: "background .15s" }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.10)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.06)"; }}
          >
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 6 }}>
                  <span style={{ fontFamily: "'Inter',sans-serif", fontSize: 18, color: "#fff", fontWeight: 700 }}>{pkg.name}</span>
                  <span style={{ fontSize: 13, color: "#e8a0d0", fontWeight: 700, background: "rgba(155,63,160,0.2)", borderRadius: 999, padding: "2px 10px", fontFamily: "'Inter',sans-serif" }}>
                    {planKey}
                  </span>
                  <span style={{ fontSize: 13, color: "rgba(255,255,255,0.5)", fontFamily: "'Inter',sans-serif" }}>
                    {pkg.price === 0 ? "Free" : `$${pkg.price}/${pkg.interval}`}
                  </span>
                </div>
                <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 12, color: "rgba(255,255,255,0.45)", fontFamily: "'Inter',sans-serif" }}>
                    👥 {lim.maxGroups != null ? lim.maxGroups : "∞"} groups
                  </span>
                  <span style={{ fontSize: 12, color: "rgba(255,255,255,0.45)", fontFamily: "'Inter',sans-serif" }}>
                    🀄 {lim.gamesPerCycle != null ? lim.gamesPerCycle : "∞"} game/{lim.cycleDays ?? 30}d
                  </span>
                  <span style={{ fontSize: 12, color: "rgba(255,255,255,0.45)", fontFamily: "'Inter',sans-serif" }}>
                    🔁 {lim.allowRecurring ? "Recurring ✓" : "No recurring"}
                  </span>
                  <span style={{ fontSize: 12, color: "#e8a0d0", fontWeight: 700, fontFamily: "'Inter',sans-serif" }}>
                    {count} user{count !== 1 ? "s" : ""}
                  </span>
                </div>
              </div>
              <span style={{ color: "rgba(232,160,208,0.6)", fontSize: 20, marginTop: 2 }}>›</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ── ADMIN CONFIG ────────────────────────────────────────────────────────── */
function AdminConfig({ flash, adminUid }) {
  const EMPTY = { host: "", port: "587", user: "", pass: "", fromEmail: "", fromName: "Mahjong Club" };
  const [form, setForm]         = useState(EMPTY);
  const [loading, setLoading]   = useState(true);
  const [saving, setSaving]     = useState(false);
  const [testing, setTesting]   = useState(false);
  const [showPass, setShowPass] = useState(false);
  const [testEmail, setTestEmail]   = useState("");
  const [logResults, setLogResults] = useState(false);
  const [testResult, setTestResult] = useState(null); // { ok, message, detail }

  useEffect(() => {
    getDoc(doc(db, "adminConfig", "smtp")).then(d => {
      if (d.exists()) setForm(f => ({ ...EMPTY, ...d.data() }));
    }).catch(() => {}).finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const handleSave = async () => {
    if (!form.host || !form.user || !form.pass) {
      flash("Host, username, and password are required."); return;
    }
    setSaving(true);
    try {
      await setDoc(doc(db, "adminConfig", "smtp"), {
        host:      form.host.trim(),
        port:      form.port.trim() || "587",
        user:      form.user.trim(),
        pass:      form.pass,
        fromEmail: form.fromEmail.trim() || form.user.trim(),
        fromName:  form.fromName.trim() || "Mahjong Club",
        updatedAt: serverTimestamp(),
        updatedBy: adminUid,
      });
      flash("Email settings saved.");
    } catch (e) {
      flash("Save failed: " + e.message);
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    const to = testEmail.trim();
    if (!to || !/\S+@\S+\.\S+/.test(to)) { flash("Enter a valid email address to send the test to."); return; }
    if (!form.host || !form.user || !form.pass) { flash("Save email settings first before sending a test."); return; }
    setTesting(true);
    setTestResult(null);
    const diag = [];
    try {
      diag.push(`UID: ${auth.currentUser?.uid || "none"}`);
      diag.push(`Origin: ${window.location.origin}`);

      // Try direct Cloud Run URL first (bypasses hosting proxy)
      diag.push("Calling logImpersonation via Firebase SDK…");
      const fn = httpsCallable(getFunctions(), "logImpersonation");
      const result = await fn({ action: "_testSmtp", to, logResults });
      diag.push(`Result: ${JSON.stringify(result.data)}`);

      if (result.data?.success) {
        setTestResult({ ok: true, message: `Email delivered to ${to}. Check your inbox.` });
      } else {
        setTestResult({ ok: false, message: "Function returned unexpected result", detail: diag.join("\n") });
      }
    } catch (e) {
      const allProps = Object.getOwnPropertyNames(e).reduce((acc, k) => {
        try { acc[k] = e[k]; } catch {}
        return acc;
      }, {});
      diag.push(`code: ${e.code}`);
      diag.push(`message: ${e.message}`);
      diag.push(`details: ${JSON.stringify(e.details)}`);
      diag.push(`httpErrorCode: ${e.httpErrorCode?.status ?? "none"}`);
      diag.push(`all props: ${JSON.stringify(allProps)}`);
      const smtpResp = e.details?.smtpResponse || "";
      setTestResult({ ok: false, message: e.message || e.code || "Unknown error", detail: [smtpResp, diag.join("\n")].filter(Boolean).join("\n---\n") });
    } finally {
      setTesting(false);
    }
  };

  const s = {
    card:  { background: "rgba(255,255,255,0.06)", borderRadius: 16, padding: "20px 22px", border: "1px solid rgba(255,255,255,0.1)", marginBottom: 16 },
    label: { fontSize: 11, fontWeight: 700, color: "rgba(232,160,208,0.8)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6, display: "block", fontFamily: "'Inter',sans-serif" },
    input: { width: "100%", background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 10, padding: "10px 12px", color: "#fff", fontSize: 14, fontFamily: "'Inter',sans-serif", outline: "none", boxSizing: "border-box" },
    row2:  { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 },
    hint:  { fontSize: 11, color: "rgba(255,255,255,0.35)", marginTop: 4, fontFamily: "'Inter',sans-serif" },
    btn:   (v = "primary") => ({
      padding: "10px 22px", borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: "pointer",
      fontFamily: "'Inter',sans-serif", border: "none",
      background: v === "primary" ? "linear-gradient(135deg,#c9607a,#9b6ea8)" : "rgba(255,255,255,0.1)",
      color: "#fff", opacity: saving || testing ? 0.6 : 1,
    }),
  };

  if (loading) return <div style={{ color: "rgba(255,255,255,0.5)", padding: 32, textAlign: "center" }}>Loading…</div>;

  return (
    <div>
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 20, fontWeight: 700, color: "#fff", fontFamily: "'Inter',sans-serif" }}>System Configuration</div>
        <div style={{ fontSize: 13, color: "rgba(255,255,255,0.45)", marginTop: 4, fontFamily: "'Inter',sans-serif" }}>
          Settings saved here take effect immediately for all email sending.
        </div>
      </div>

      {/* ── Email / SMTP ── */}
      <div style={s.card}>
        <div style={{ fontSize: 16, fontWeight: 700, color: "#e8a0d0", marginBottom: 16, fontFamily: "'Inter',sans-serif" }}>📧 Email Settings (SMTP)</div>

        <div style={s.row2}>
          <div>
            <span style={s.label}>SMTP Host</span>
            <input style={s.input} value={form.host} onChange={e => set("host", e.target.value)} placeholder="smtp.example.com" />
          </div>
          <div>
            <span style={s.label}>Port</span>
            <input style={s.input} type="number" value={form.port} onChange={e => set("port", e.target.value)} placeholder="587" />
            <div style={s.hint}>587 = TLS (recommended) · 465 = SSL · 25 = plain</div>
          </div>
        </div>

        <div style={{ marginBottom: 14 }}>
          <span style={s.label}>SMTP Username</span>
          <input style={s.input} value={form.user} onChange={e => set("user", e.target.value)} placeholder="your@email.com" autoComplete="off" />
        </div>

        <div style={{ marginBottom: 14 }}>
          <span style={s.label}>SMTP Password</span>
          <div style={{ position: "relative" }}>
            <input
              style={{ ...s.input, paddingRight: 44 }}
              type={showPass ? "text" : "password"}
              value={form.pass}
              onChange={e => set("pass", e.target.value)}
              placeholder="••••••••"
              autoComplete="new-password"
            />
            <button
              onClick={() => setShowPass(v => !v)}
              style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: "rgba(255,255,255,0.5)", fontSize: 14 }}
            >{showPass ? "Hide" : "Show"}</button>
          </div>
          <div style={s.hint}>Stored encrypted in Firestore · only admins can read this document</div>
        </div>

        <div style={s.row2}>
          <div>
            <span style={s.label}>From Email</span>
            <input style={s.input} value={form.fromEmail} onChange={e => set("fromEmail", e.target.value)} placeholder="noreply@yourapp.com" />
            <div style={s.hint}>Defaults to SMTP username if blank</div>
          </div>
          <div>
            <span style={s.label}>From Name</span>
            <input style={s.input} value={form.fromName} onChange={e => set("fromName", e.target.value)} placeholder="Mahjong Club" />
          </div>
        </div>

        <button onClick={handleSave} disabled={saving} style={s.btn("primary")}>
          {saving ? "Saving…" : "Save Settings"}
        </button>
      </div>

      {/* ── Test ── */}
      <div style={s.card}>
        <div style={{ fontSize: 16, fontWeight: 700, color: "#e8a0d0", marginBottom: 4, fontFamily: "'Inter',sans-serif" }}>🧪 Send Test Email</div>
        <div style={{ fontSize: 13, color: "rgba(255,255,255,0.45)", marginBottom: 14, fontFamily: "'Inter',sans-serif" }}>
          Save your settings first, then send a test to verify everything is working.
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 12 }}>
          <input
            style={{ ...s.input, flex: 1 }}
            value={testEmail}
            onChange={e => { setTestEmail(e.target.value); setTestResult(null); }}
            placeholder="test@example.com"
            type="email"
          />
          <button onClick={handleTest} disabled={testing} style={{ ...s.btn("ghost"), whiteSpace: "nowrap", opacity: testing ? 0.6 : 1 }}>
            {testing ? "Sending…" : "Send Test"}
          </button>
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", userSelect: "none" }}>
          <input
            type="checkbox"
            checked={logResults}
            onChange={e => setLogResults(e.target.checked)}
            style={{ width: 15, height: 15, accentColor: "#e8a0d0", cursor: "pointer" }}
          />
          <span style={{ fontSize: 13, color: "rgba(255,255,255,0.55)", fontFamily: "'Inter',sans-serif" }}>
            Log results in Logs tab and error file
          </span>
        </label>
        {testResult && (
          <div style={{ marginTop: 14, padding: "12px 14px", borderRadius: 10, background: testResult.ok ? "rgba(60,200,120,0.1)" : "rgba(220,60,60,0.12)", border: `1px solid ${testResult.ok ? "rgba(60,200,120,0.3)" : "rgba(220,60,60,0.3)"}` }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: testResult.ok ? "#60d090" : "#ff9090", fontFamily: "'Inter',sans-serif" }}>
              {testResult.ok ? "✅ Success" : "❌ Failed"} — {testResult.message}
            </div>
            {testResult.detail && (
              <div style={{ fontSize: 12, color: "rgba(255,255,255,0.5)", marginTop: 6, fontFamily: "monospace", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                {testResult.detail}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
