import { useState, useEffect, useRef } from "react";
import {
  onAuthStateChanged, createUserWithEmailAndPassword,
  signInWithEmailAndPassword, signInWithPopup, signOut,
} from "firebase/auth";
import {
  collection, doc, setDoc, getDoc, getDocs, updateDoc, deleteDoc,
  onSnapshot, query, where, orderBy, addDoc, serverTimestamp,
  arrayUnion, arrayRemove, runTransaction, writeBatch,
} from "firebase/firestore";
import { auth, db, googleProvider, messagingReady } from "./firebase";
import { getToken, onMessage } from "firebase/messaging";
import { getFunctions, httpsCallable } from "firebase/functions";
import { sakura as defaultTheme, themes, buildCSSVars } from "./theme";
import { QRCodeSVG } from "qrcode.react";

// VAPID key — get from Firebase Console → Project Settings → Cloud Messaging → Web Push certificates
const VAPID_KEY = "BKkYCO7TpfkGKyFGFwxP9qv_SqUyey_tLi5yzk5bngZxZ6ZBd3S9IgYSsHwIlRMinuGxmiFK4bQDjwxIPj8M0Bg";

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

// cfg = live plan config from Firestore (or null to use fallback)
function getPlanLimits(cfg) {
  return {
    maxGroups:     cfg?.limits?.maxGroups     ?? FREE_PLAN.maxGroups,
    gamesPerCycle: cfg?.limits?.gamesPerCycle ?? FREE_PLAN.gamesPerCycle,
    cycleDays:     cfg?.limits?.cycleDays     ?? FREE_PLAN.cycleDays,
  };
}

// Returns { ok: true } or { ok: false }
function canAddGroup(groupCount, user, cfg) {
  if (getPlan(user) !== "free") return { ok: true };
  const { maxGroups } = getPlanLimits(cfg);
  return groupCount >= maxGroups ? { ok: false } : { ok: true };
}

// Returns { ok: true } or { ok: false, daysLeft: number }
function canHostGame(user, cfg) {
  if (getPlan(user) !== "free") return { ok: true };
  const { cycleDays } = getPlanLimits(cfg);
  const last = user?.lastHostedAt;
  if (!last) return { ok: true };
  const cycleMs = cycleDays * 24 * 60 * 60 * 1000;
  const elapsed = Date.now() - last;
  if (elapsed < cycleMs) {
    return { ok: false, daysLeft: Math.ceil((cycleMs - elapsed) / 86400000) };
  }
  return { ok: true };
}

const showBrowserNotif = (title, body, tag) => {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try { new Notification(title, { body, icon: "/favicon.ico", tag }); } catch(e) {}
};

// Silent token refresh — called on every sign-in.
// Only runs if the user has already granted notification permission.
// Never shows a browser dialog. Does NOT set notificationsEnabled.
// This keeps the stored token fresh (tokens rotate periodically).
async function silentlyRefreshFcmToken(uid) {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  const messaging = await messagingReady;
  if (!messaging) return;
  try {
    const token = await getToken(messaging, { vapidKey: VAPID_KEY });
    if (token) {
      await updateDoc(doc(db, "users", uid), { fcmTokens: arrayUnion(token) });
      console.log("[FCM] token refreshed:", token.slice(0, 20) + "…");
    }
  } catch (e) {
    console.error("[FCM] silent refresh failed:", e);
  }
}

// Explicit enable — called only when the user clicks "Enable notifications".
// Prompts for permission if not yet decided. Gets token and sets notificationsEnabled: true.
// Returns a status string for the UI to act on.
async function enablePushNotifications(uid) {
  if (typeof Notification === "undefined") return "unsupported";
  if (Notification.permission === "denied") return "denied";
  if (Notification.permission === "default") {
    const result = await Notification.requestPermission();
    if (result !== "granted") {
      console.warn("[FCM] permission not granted:", result);
      return "no-permission";
    }
  }
  const messaging = await messagingReady;
  if (!messaging) {
    console.warn("[FCM] isSupported() returned false — browser does not support FCM");
    return "unsupported";
  }
  try {
    const token = await getToken(messaging, { vapidKey: VAPID_KEY });
    if (token) {
      await updateDoc(doc(db, "users", uid), {
        notificationsEnabled: true,
        fcmTokens: arrayUnion(token),
      });
      console.log("[FCM] token registered:", token.slice(0, 20) + "…");
      return "ok";
    }
    console.warn("[FCM] getToken returned empty — service worker may not be registered yet");
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
    const token = await getToken(messaging, { vapidKey: VAPID_KEY });
    log.push(`Token value: ${token ? token.slice(0, 30) + "…" : "(empty)"}`);
    if (token) {
      log.push(`Writing to users/${uid}…`);
      await updateDoc(doc(db, "users", uid), { notificationsEnabled: true, fcmTokens: arrayUnion(token) });
      // Read back the doc to confirm the token actually landed
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

  /* Bottom nav always anchors to the app-shell width, not full viewport */
  .bottom-nav {
    position: fixed;
    bottom: 0;
    left: 50%;
    transform: translateX(-50%);
    width: 100%;
    max-width: 480px;
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

export default function App() {
  const [activeTheme, setActiveTheme] = useState(defaultTheme);
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
  // planConfigs: { [planKey]: planDocument } — real-time from subscriptionPackages
  const [planConfigs, setPlanConfigs] = useState({});
  const [page, setPage] = useState("home");
  const [isDesktop, setIsDesktop] = useState(window.innerWidth >= 900);
  const [adminMenuOpen, setAdminMenuOpen] = useState(false);

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
  const [impersonating, setImpersonating] = useState(null); // { uid, name, avatar, email }
  const gamesUnsubs = useRef({});
  const groupMeta = useRef({});
  const guestGameUnsubs = useRef({});
  const guestGroupCache = useRef({});
  const knownGameIds = useRef({}); // { [groupId]: Set<gameId> } — per-group tracking

  // ── Subscription plan configs (real-time) ──
  // Build a map of planKey → document so helpers can read dynamic limits
  useEffect(() => {
    const unsub = onSnapshot(collection(db, "subscriptionPackages"), (snap) => {
      const map = {};
      snap.docs.forEach((d) => {
        const data = d.data();
        const key = data.planKey || d.id;
        map[key] = { id: d.id, ...data };
      });
      setPlanConfigs(map);
    });
    return unsub;
  }, []);

  // ── Firebase auth state listener ──
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (fbUser) => {
      if (fbUser) {
        try {
          const snap = await getDoc(doc(db, "users", fbUser.uid));
          if (snap.exists()) {
            const data = snap.data();
            setUser({ uid: fbUser.uid, ...data });
            if (data.theme && themes[data.theme]) setActiveTheme(themes[data.theme]);
            // If the user has opted into notifications, call enablePushNotifications so
            // they get prompted (or silently tokenized if already granted) on every device
            // they sign in on. If not opted in, only refresh silently if already granted.
            if (data.notificationsEnabled) {
              enablePushNotifications(fbUser.uid);
            } else {
              silentlyRefreshFcmToken(fbUser.uid);
            }
          } else {
            const profile = { name: fbUser.displayName || fbUser.email.split("@")[0], email: fbUser.email, avatar: randAvatar(), phone: "" };
            await setDoc(doc(db, "users", fbUser.uid), profile);
            setUser({ uid: fbUser.uid, ...profile });
            setShowWelcome(true);
          }
        } catch (e) {
          setUser({ uid: fbUser.uid, name: fbUser.displayName || "Player", email: fbUser.email || "", avatar: "🐼", phone: "" });
        }
        setPage("home");
        setAuthUser(fbUser);
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

    // Listener for guest games: watch the user doc's guestGameRefs array,
    // then set up individual game listeners for each ref.
    const userDocUnsub = onSnapshot(doc(db, "users", uid), (userSnap) => {
      const refs = userSnap.data()?.guestGameRefs || [];
      const refKeys = new Set(refs.map((r) => `${r.groupId}:${r.gameId}`));

      // Clean up listeners for refs that were removed
      Object.keys(guestGameUnsubs.current).forEach((key) => {
        if (!refKeys.has(key)) {
          guestGameUnsubs.current[key]();
          delete guestGameUnsubs.current[key];
          setGuestGames((prev) => {
            const [gId, gmId] = key.split(":");
            return prev.filter((g) => !(g.id === gmId && g.groupId === gId));
          });
        }
      });

      if (refs.length === 0) { setGuestGames([]); return; }

      refs.forEach(({ groupId, gameId }) => {
        const key = `${groupId}:${gameId}`;
        if (guestGameUnsubs.current[key]) return;

        // Fetch group metadata once, then listen to the game doc
        getDoc(doc(db, "groups", groupId)).then((gs) => {
          if (!gs.exists()) return;
          const gd = gs.data();
          guestGroupCache.current[groupId] = { name: gd.name, color: gd.color, emoji: gd.emoji };

          guestGameUnsubs.current[key] = onSnapshot(
            doc(db, "groups", groupId, "games", gameId),
            (gameSnap) => {
              if (!gameSnap.exists()) return;
              const gm = guestGroupCache.current[groupId];
              const updated = { ...gameSnap.data(), id: gameId, groupId, groupName: gm.name, groupColor: gm.color, groupEmoji: gm.emoji, isGuestGame: true };
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
      userDocUnsub();
      Object.values(gamesUnsubs.current).forEach((u) => u());
      Object.values(guestGameUnsubs.current).forEach((u) => u());
      gamesUnsubs.current = {};
      groupMeta.current = {};
      guestGameUnsubs.current = {};
      guestGroupCache.current = {};
    };
  }, [effectiveUid]);

  const handleSignOut = async () => { await signOut(auth); };

  const handleThemeChange = async (themeId) => {
    const theme = themes[themeId];
    if (!theme) return;
    setActiveTheme(theme);
    try { await updateDoc(doc(db, "users", authUser.uid), { theme: themeId }); } catch {}
  };

  const startImpersonating = (targetUser) => {
    setImpersonating(targetUser);
    setGroups([]);
    setGuestGames([]);
    setPage("home");
    setGid(null);
    setGmid(null);
  };

  const stopImpersonating = () => {
    setImpersonating(null);
    setGroups([]);
    setGuestGames([]);
    setPage("home");
    setGid(null);
    setGmid(null);
  };

  // ── Deep-link invite processing ──
  // Params are captured from the URL (or localStorage fallback for page-refresh edge cases)
  // then cleared so they don't re-fire.
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

  useEffect(() => {
    if ((!pendingJoin.code && !pendingJoin.gameCode) || !authUser || !user) return;
    const { code, gameId, gameCode } = pendingJoin;
    const go_ = (p, g, gm) => { setPage(p); setGid(g || null); setGmid(gm || null); };

    // ── Game code invite (direct game join via ?gameCode=) ──
    if (gameCode && !code) {
      localStorage.removeItem("pendingGameCode");
      getDoc(doc(db, "gameCodes", gameCode))
        .then(async (snap) => {
          if (!snap.exists() || snap.data().date < Date.now()) {
            setToast({ msg: "Game code is invalid or expired.", icon: "❌" }); setTimeout(() => setToast(null), 2600); return;
          }
          const { groupId, gameId: gId } = snap.data();
          try {
            await updateDoc(doc(db, "groups", groupId, "games", gId), {
              guestIds: arrayUnion(authUser.uid), [`rsvps.${authUser.uid}`]: "yes",
            });
            await updateDoc(doc(db, "users", authUser.uid), { guestGameRefs: arrayUnion({ groupId, gameId: gId }) });
            go_("guestGame", groupId, gId);
            setToast({ msg: "You're in! See you at the table 🀄", icon: "🎉" }); setTimeout(() => setToast(null), 3000);
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
            await updateDoc(doc(db, "groups", gid_, "games", gameId), {
              guestIds: arrayUnion(authUser.uid),
              [`rsvps.${authUser.uid}`]: "yes",
            });
            // Record the ref in the user doc so the games panel can load it
            await updateDoc(doc(db, "users", authUser.uid), {
              guestGameRefs: arrayUnion({ groupId: gid_, gameId }),
            });
            go_("guestGame", gid_, gameId);
            setToast({ msg: "You're in! See you at the table 🀄", icon: "🎉" }); setTimeout(() => setToast(null), 3000);
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

  const group = groups.find((g) => g.id === gid) || null;
  const game = group ? group.games.find((g) => g.id === gmid) || null : null;
  const guestGame = guestGames.find((g) => g.id === gmid && g.groupId === gid) || null;
  const guestGroupMeta = guestGame
    ? { id: guestGame.groupId, name: guestGame.groupName, color: guestGame.groupColor, emoji: guestGame.groupEmoji, members: [], openInvites: false, games: [] }
    : null;

  const scrollRef = useRef(null);
  const go = (p, g, gm) => { setPage(p); if (g !== undefined) setGid(g); if (gm !== undefined) setGmid(gm || null); };
  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = 0; }, [page]);
  const flash = (msg, icon) => { setToast({ msg, icon: icon || "✅" }); setTimeout(() => setToast(null), 2600); };

  // ── Loading / auth gate ──
  if (authUser === undefined) {
    return (
      <div className="app-shell" style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", flexDirection: "column", gap: 16 }}>
        <div style={{ fontSize: 55, filter: "drop-shadow(0 6px 18px rgba(var(--shadow-rgb),.3))" }}>🀄</div>
        <div style={{ fontFamily: "'Shippori Mincho',serif", fontSize: 19, color: "var(--primary-muted)" }}>Loading…</div>
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
  const GROUP_PAGES = ["groups","group","newGroup","joinGroup","editGroup","newGame","game","editGame","invite"];
  const GAMES_PAGES = ["games","guestGame"];

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
            cursor: "pointer", fontFamily: "'Noto Sans JP',sans-serif",
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
                cursor: "pointer", fontFamily: "'Noto Sans JP',sans-serif",
                display: "flex", alignItems: "center", gap: 9,
                borderBottom: "1px solid rgba(155,110,168,0.1)",
              }}>🏛️ Admin Hub</button>
              <button onClick={() => { setPage("account"); setAdminMenuOpen(false); }} style={{
                width: "100%", padding: "12px 16px", background: "none", border: "none",
                textAlign: "left", fontSize: 14, fontWeight: 600, color: "#7a5090",
                cursor: "pointer", fontFamily: "'Noto Sans JP',sans-serif",
                display: "flex", alignItems: "center", gap: 9,
              }}>👤 My Profile</button>
            </div>
          </>
        )}
      </div>
    )}

    <div className="app-shell">

      {/* Impersonation banner */}
      {impersonating && (
        <div style={{
          position: "fixed", top: 0, left: "50%", transform: "translateX(-50%)",
          width: "100%", maxWidth: 480, zIndex: 10000,
          background: "linear-gradient(135deg,#2d1b4e,#5a2d6b)",
          padding: "10px 16px", display: "flex", alignItems: "center", gap: 10,
          boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
        }}>
          <span style={{ fontSize: 21 }}>{impersonating.avatar}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 800, color: "rgba(255,255,255,0.6)", textTransform: "uppercase", letterSpacing: 1, fontFamily: "'Noto Sans JP',sans-serif" }}>Admin · Viewing as</div>
            <div style={{ fontSize: 14, fontWeight: 700, color: "#fff", fontFamily: "'Noto Sans JP',sans-serif", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{impersonating.name} · {impersonating.email}</div>
          </div>
          <button onClick={stopImpersonating} style={{ background: "rgba(255,255,255,0.18)", border: "1px solid rgba(255,255,255,0.3)", borderRadius: 999, padding: "5px 12px", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "'Noto Sans JP',sans-serif", flexShrink: 0 }}>Exit</button>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div style={{ position: "fixed", bottom: 90, left: "50%", transform: "translateX(-50%)", zIndex: 9999, width: "100%", maxWidth: 480, display: "flex", justifyContent: "center", pointerEvents: "none" }}>
          <div className="bIn" style={{
            background: "linear-gradient(135deg,var(--section-title),var(--primary))",
            color: "#fff", borderRadius: 999, padding: "10px 22px",
            fontWeight: 700, fontSize: 15, whiteSpace: "nowrap",
            boxShadow: "0 6px 24px rgba(var(--shadow-rgb),0.4)",
          }}>{toast.icon} {toast.msg}</div>
        </div>
      )}

      {showWelcome && <WelcomeModal onClose={() => { setShowWelcome(false); go("account"); }} />}

      {/* Page content */}
      <div ref={scrollRef} data-scroll-container style={{ flex: 1, overflowY: "auto", WebkitOverflowScrolling: "touch", paddingBottom: 90, paddingTop: impersonating ? 52 : 0 }}>
        {page === "home" && <Home groups={groups} guestGames={guestGames} go={go} user={displayUser} activeTheme={activeTheme} planCfg={userPlanCfg} />}
        {page === "games" && <GamesPage groups={groups} guestGames={guestGames} go={go} />}
        {page === "groups" && <GroupsPage groups={groups} go={go} user={displayUser} planCfg={userPlanCfg} />}
        {page === "account" && <Account uid={uid} user={displayUser} setUser={setUser} groups={groups} guestGames={guestGames} flash={flash} go={go} onSignOut={handleSignOut} isAdmin={!!user?.isAdmin} onImpersonate={startImpersonating} isImpersonating={!!impersonating} activeThemeId={activeTheme.id} onThemeChange={handleThemeChange} planCfg={userPlanCfg} />}
        {page === "newGroup" && (
          <NewGroup onBack={() => go("groups")}
            onSave={async (g) => {
              if (!canAddGroup(groups.length, user, userPlanCfg).ok) {
                const lim = getPlanLimits(userPlanCfg);
                flash(`Free plan allows up to ${lim.maxGroups} groups`, "🔒"); go("groups"); return;
              }
              try {
                const groupData = { ...g, members: [{ id: uid, name: user.name, avatar: user.avatar, host: true }], memberIds: [uid] };
                await setDoc(doc(db, "groups", g.id), groupData);
                go("group", g.id); flash("Group created!", "🎉");
              } catch { flash("Error creating group", "❌"); }
            }} />
        )}
        {page === "joinGroup" && (
          <JoinGroup uid={uid} groups={groups} onBack={() => go("home")}
            onJoin={async (id) => {
              if (!canAddGroup(groups.length, user, userPlanCfg).ok) {
                const lim = getPlanLimits(userPlanCfg);
                flash(`Free plan allows up to ${lim.maxGroups} groups`, "🔒"); return;
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
            onJoinGame={async (groupId, gameId) => {
              try {
                await updateDoc(doc(db, "groups", groupId, "games", gameId), {
                  guestIds: arrayUnion(uid), [`rsvps.${uid}`]: "yes",
                });
                await updateDoc(doc(db, "users", uid), {
                  guestGameRefs: arrayUnion({ groupId, gameId }),
                });
                go("guestGame", groupId, gameId);
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
            }} />
        )}
        {page === "group" && group && (
          <Group uid={uid} group={group} go={go} flash={flash}
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
                const hostCheck = canHostGame(user, userPlanCfg);
                if (!hostCheck.ok) {
                  flash(`Free plan: next hosted game available in ${hostCheck.daysLeft} day${hostCheck.daysLeft === 1 ? "" : "s"}`, "🔒");
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
                if (isHosting) {
                  await updateDoc(doc(db, "users", uid), { lastHostedAt: Date.now() });
                }
                if (arr.length === 1) { go("game", group.id, arr[0].id); flash("Game scheduled!", "🀄"); }
                else { go("group", group.id); flash(`${arr.length} games scheduled! 🀄`); }
              } catch { flash("Error scheduling game", "❌"); }
            }} />
        )}
        {page === "game" && game && group && (
          <Game uid={uid} user={displayUser} game={game} group={group} go={go}
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
            onDelete={async () => {
              try {
                const batch = writeBatch(db);
                batch.delete(doc(db, "groups", group.id, "games", game.id));
                if (game.joinCode) batch.delete(doc(db, "gameCodes", game.joinCode));
                await batch.commit();
                go("group", group.id); flash("Deleted");
              } catch { flash("Error deleting game", "❌"); }
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
          <GuestGameView uid={uid} groupId={gid} gameId={gmid} go={go} flash={flash} />
        )}
      </div>

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
              <div style={{ width: 42, height: 28, borderRadius: 14, background: active ? "var(--active-tab-gradient)" : "transparent", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 17, boxShadow: active ? "0 2px 10px rgba(var(--shadow-rgb),0.35)" : "none", transition: "all .2s" }}>{item.icon}</div>
              <span style={{ fontSize: 12, fontWeight: active ? 700 : 500, color: active ? "var(--primary)" : "#c0a0b0", fontFamily: "'Noto Sans JP',sans-serif" }}>{item.label}</span>
            </button>
          );
        })}
      </div>
    </div>
    </>
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
          fontFamily: "'Shippori Mincho',serif",
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
          fontFamily: "'Noto Sans JP',sans-serif", fontWeight: 400,
          marginBottom: 10,
        }}>
          We know the struggle — chasing down four players, juggling schedules, 
          and keeping track of who's in, who's out, and who's 
          <em> definitely</em> blaming the tiles. 😄
        </p>

        <p style={{
          fontSize: 15, color: "#7a4a58", lineHeight: 1.8,
          fontFamily: "'Noto Sans JP',sans-serif", fontWeight: 400,
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
          fontFamily: "'Noto Sans JP',sans-serif",
          boxShadow: "0 6px 20px rgba(var(--shadow-rgb),0.4)",
          letterSpacing: 0.3,
        }}>
          Let's Play! 🀄
        </button>
      </div>
    </div>
  );
}

/* ── AUTH SCREEN ── */
const AUTH_AVATARS = [
  "🐼","🌸","🦋","🍀","🌹","🦚","🎋","🌿","🦩","🌺","🎍","🐝",
  "🦊","🐱","🐰","🦁","🐨","🦄","🐸","🦜","🌙","⭐","🌊","🍵",
  "🎀","🍄","🌻","🪷","🦢","🐞","🍒","🫧","🌈","🪸","🫶","🎐",
];
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

  const switchMode = (m) => { setMode(m); setError(""); };

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
      const { user: fbUser } = await signInWithEmailAndPassword(auth, email.trim(), password);
      silentlyRefreshFcmToken(fbUser.uid);
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
      };
      await setDoc(doc(db, "users", fbUser.uid), profile);
      silentlyRefreshFcmToken(fbUser.uid);
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
      const { user: fbUser } = await signInWithPopup(auth, googleProvider);
      silentlyRefreshFcmToken(fbUser.uid);
    } catch (e) {
      setError(fmtFirebaseError(e.code));
    } finally {
      setLoading(false);
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
      minHeight: "100vh",
      background: "var(--header-gradient2)",
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      padding: "24px 20px", position: "relative", overflow: "hidden",
    }}>
      {/* Shimmer overlay */}
      <div style={{ position: "absolute", inset: 0, background: "linear-gradient(135deg,rgba(255,255,255,0.12) 0%,transparent 60%)", pointerEvents: "none" }} />

      {/* Animated tiles */}
      {TILE_POS.map((p, i) => (
        <div key={i} style={{
          position: "absolute", fontSize: p.s, opacity: 0.18, pointerEvents: "none",
          top: p.top, bottom: p.bottom, left: p.left, right: p.right,
          animation: `${p.a} ${2.4 + i * 0.3}s ${p.d} ease-in-out infinite`, filter: "blur(0.5px)",
        }}>{TILES[i]}</div>
      ))}

      {/* Logo */}
      <div style={{ textAlign: "center", marginBottom: 24, position: "relative" }}>
        <div style={{ fontSize: 55, filter: "drop-shadow(0 6px 18px rgba(0,0,0,.3))", marginBottom: 10 }}>🀄</div>
        <h1 style={{ fontFamily: "'Shippori Mincho',serif", fontSize: 31, color: "#fff", textShadow: "0 2px 12px rgba(0,0,0,.25)", letterSpacing: 2, lineHeight: 1.1 }}>Mahjong Club</h1>
        <p style={{ color: "rgba(255,255,255,.72)", fontSize: 13, fontFamily: "'Noto Sans JP',sans-serif", letterSpacing: 1, marginTop: 5 }}>Schedule · Play · Enjoy</p>
      </div>

      {/* Card */}
      <div className="bIn" style={{
        background: "linear-gradient(160deg,var(--bg-popup) 0%,var(--bg-card-alt) 100%)",
        borderRadius: 28, padding: "26px 22px 22px", maxWidth: 420, width: "100%",
        boxShadow: "0 28px 72px rgba(100,30,60,0.38), inset 0 1px 0 var(--shadow-inset)",
        border: "1px solid rgba(var(--border-light-rgb),0.5)", position: "relative",
      }}>
        {/* Tab toggle */}
        <div style={{ display: "flex", background: "rgba(240,217,227,0.55)", borderRadius: 999, padding: 4, marginBottom: 20 }}>
          {[["login","Sign In"],["signup","Create Account"]].map(([m, label]) => (
            <button key={m} onClick={() => switchMode(m)} style={{
              flex: 1, padding: "9px 0", borderRadius: 999, fontSize: 14, fontWeight: 700,
              fontFamily: "'Noto Sans JP',sans-serif", border: "none", cursor: "pointer", transition: "all .2s",
              background: mode === m ? "var(--active-tab-gradient)" : "transparent",
              color: mode === m ? "#fff" : "var(--primary-subtle)",
              boxShadow: mode === m ? "0 3px 12px rgba(var(--shadow-rgb),0.3)" : "none",
            }}>{label}</button>
          ))}
        </div>

        {mode === "login" ? (
          <>
            <AInput label="Email" type="email" value={email} set={setEmail} placeholder="you@email.com" />
            <AInput label="Password" type="password" value={password} set={setPassword} placeholder="••••••••" />
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
              <div style={{ fontSize: 12, fontWeight: 700, color: "var(--primary-subtle)", marginBottom: 7, textTransform: "uppercase", letterSpacing: .5, fontFamily: "'Noto Sans JP',sans-serif" }}>
                Avatar <span style={{ fontWeight: 400, color: "var(--primary-faint)", textTransform: "none", letterSpacing: 0, fontSize: 12 }}>— auto-selected if skipped</span>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                {AUTH_AVATARS.map((a) => (
                  <div key={a} onClick={() => setAvatar(avatar === a ? null : a)} style={{
                    fontSize: 23, padding: 6, borderRadius: 11, cursor: "pointer",
                    background: avatar === a ? "var(--input-selected-bg)" : "var(--border-card)",
                    border: `2px solid ${avatar === a ? "var(--primary)" : "transparent"}`,
                    transition: "all .14s",
                    boxShadow: avatar === a ? "0 2px 8px rgba(var(--primary-rgb),0.25)" : "none",
                  }}>{a}</div>
                ))}
              </div>
            </div>

            {error && <ErrMsg msg={error} />}
            <ABtn onClick={handleSignUp} disabled={loading}>{loading ? "Creating account…" : "Create Account ✨"}</ABtn>
            <Divider />
            <GoogleSignInBtn onClick={handleGoogle} disabled={loading} />
          </>
        )}

        <p style={{ fontSize: 12, color: "#c0a0b0", textAlign: "center", marginTop: 14, fontFamily: "'Noto Sans JP',sans-serif" }}>
          {mode === "login" ? "Don't have an account? " : "Already have an account? "}
          <span onClick={() => switchMode(mode === "login" ? "signup" : "login")} style={{ color: "var(--primary)", fontWeight: 700, cursor: "pointer" }}>
            {mode === "login" ? "Create one" : "Sign in"}
          </span>
        </p>
      </div>
    </div>
  );
}

function AInput({ label, type = "text", value, set, placeholder }) {
  return (
    <div style={{ marginBottom: 11 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: "var(--primary-subtle)", marginBottom: 5, textTransform: "uppercase", letterSpacing: .5, fontFamily: "'Noto Sans JP',sans-serif" }}>{label}</div>
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
      fontFamily: "'Noto Sans JP',sans-serif", boxShadow: disabled ? "none" : "0 6px 20px rgba(var(--shadow-rgb),0.38)",
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
      border: "2px solid #e8e0e4", cursor: disabled ? "not-allowed" : "pointer", fontFamily: "'Noto Sans JP',sans-serif",
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
  return <div style={{ color: "var(--primary)", fontSize: 14, fontWeight: 600, marginBottom: 12, textAlign: "center", fontFamily: "'Noto Sans JP',sans-serif", background: "rgba(var(--primary-rgb),0.08)", borderRadius: 10, padding: "8px 12px" }}>{msg}</div>;
}
function Divider() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "14px 0" }}>
      <div style={{ flex: 1, height: 1, background: "linear-gradient(90deg,transparent,#f0c0d0,transparent)" }} />
      <span style={{ fontSize: 13, color: "var(--primary-faint)", fontFamily: "'Noto Sans JP',sans-serif", fontWeight: 600 }}>or</span>
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
        <span style={{ fontFamily: "'Shippori Mincho',serif", fontSize: 17, color: "#2d1b4e", fontWeight: 700 }}>Admin Panel</span>
        <span style={{ marginLeft: "auto", fontSize: 11, fontWeight: 800, color: "var(--secondary-accent)", background: "rgba(155,110,168,0.12)", borderRadius: 999, padding: "2px 8px", textTransform: "uppercase", letterSpacing: 1 }}>Admin Only</span>
      </div>

      <div style={{ fontSize: 13, color: "#7a5090", marginBottom: 12, fontFamily: "'Noto Sans JP',sans-serif" }}>
        Search for a user by email to view the app as them.
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <input
          value={query_}
          onChange={(e) => setQuery_(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && search()}
          placeholder="User email address"
          style={{ flex: 1, padding: "10px 14px", borderRadius: 12, fontSize: 14, border: "1.5px solid rgba(90,45,107,0.25)", background: "rgba(255,255,255,0.8)", color: "#2d1b4e", fontFamily: "'Noto Sans JP',sans-serif", outline: "none" }}
        />
        <button onClick={search} disabled={searching || !query_.trim()} style={{ background: "linear-gradient(135deg,#2d1b4e,#5a2d6b)", border: "none", borderRadius: 12, padding: "10px 16px", color: "#fff", fontWeight: 700, fontSize: 14, cursor: "pointer", fontFamily: "'Noto Sans JP',sans-serif", opacity: (!query_.trim() || searching) ? 0.5 : 1 }}>
          {searching ? "…" : "Search"}
        </button>
      </div>

      {searched && results.length === 0 && !searching && (
        <div style={{ fontSize: 13, color: "var(--secondary-accent)", fontFamily: "'Noto Sans JP',sans-serif" }}>No user found with that email.</div>
      )}

      {results.map((u) => (
        <div key={u.uid} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: 12, background: "rgba(255,255,255,0.7)", marginBottom: 8, border: "1px solid rgba(90,45,107,0.15)" }}>
          <span style={{ fontSize: 23 }}>{u.avatar}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: "#2d1b4e", fontFamily: "'Noto Sans JP',sans-serif" }}>{u.name}</div>
            <div style={{ fontSize: 12, color: "var(--secondary-accent)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{u.email}</div>
          </div>
          <button onClick={() => onImpersonate(u)} style={{ background: "linear-gradient(135deg,#2d1b4e,#5a2d6b)", border: "none", borderRadius: 10, padding: "6px 12px", color: "#fff", fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "'Noto Sans JP',sans-serif", flexShrink: 0 }}>
            View as
          </button>
        </div>
      ))}
    </div>
  );
}

/* ── ACCOUNT PAGE ── */
function Account({ uid, user, setUser, groups, guestGames, flash, go, onSignOut, isAdmin, onImpersonate, isImpersonating, activeThemeId, onThemeChange, planCfg }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email);
  const [notifEnabled, setNotifEnabled] = useState(
    user.notificationsEnabled === true ||
    (typeof Notification !== "undefined" && Notification.permission === "granted")
  );
  const [notifDebug, setNotifDebug] = useState(null);
  const AVATARS = [
    "🐼","🌸","🦋","🍀","🌹","🦚","🎋","🌿","🦩","🌺","🎍","🐝",
    "🦊","🐱","🐰","🦁","🐨","🦄","🐸","🦜","🌙","⭐","🌊","🍵",
    "🎀","🍄","🌻","🪷","🦢","🐞","🍒","🫧","🌈","🪸","🫶","🎐",
  ];
  const [avatar, setAvatar] = useState(user.avatar);
  const [skillLevel, setSkillLevel] = useState(user.skillLevel || "");

  const save = async () => {
    const newName = name.trim() || user.name;
    try {
      await updateDoc(doc(db, "users", uid), { name: newName, avatar, skillLevel });
      setUser({ ...user, name: newName, avatar, skillLevel });
      setEditing(false);
      flash("Profile updated!", "✨");
    } catch { flash("Error saving profile", "❌"); }
  };

  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const notifUnsupported = typeof Notification === "undefined";

  const toggleNotifications = async () => {
    if (!notifEnabled) {
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

      // Collect a step-by-step log for in-UI debugging (no dev tools needed)
      const log = [];
      log.push(`UA: ${navigator.userAgent.slice(0, 80)}`);
      log.push(`Permission before: ${Notification.permission}`);

      const result = await enablePushNotificationsWithLog(uid, log);
      setNotifDebug(log);

      if (result === "ok") {
        setNotifEnabled(true);
        flash("Notifications enabled!", "🔔");
      } else if (result === "denied") {
        flash("Notifications blocked — check browser settings", "🔕");
      } else if (result === "no-permission") {
        flash("Notifications not granted — tap Allow when the browser asks", "🔕");
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

  const totalGames = groups.reduce((n, g) => n + g.games.length, 0);
  const upcoming = groups.reduce((n, g) => n + g.games.filter((gm) => gm.date > NOW).length, 0);

  return (
    <div style={{ minHeight: "100vh", background: `linear-gradient(170deg,var(--bg-shell-start) 0%,var(--bg-shell-mid) 40%,var(--bg-shell-end) 100%)` }}>
      {/* Header */}
      <div style={{
        background: "var(--header-gradient)",
        backdropFilter: "blur(14px)", WebkitBackdropFilter: "blur(14px)",
        padding: "52px 22px 30px", textAlign: "center",
        boxShadow: "0 8px 32px rgba(var(--shadow-rgb),0.25)",
        position: "relative", overflow: "hidden",
      }}>
        <div style={{ position: "absolute", inset: 0, background: "linear-gradient(135deg,rgba(255,255,255,0.15) 0%,transparent 55%)", pointerEvents: "none" }} />
        {/* Avatar */}
        <div style={{
          width: 80, height: 80, borderRadius: 999, margin: "0 auto 12px",
          background: "linear-gradient(135deg,rgba(255,255,255,0.35),rgba(255,255,255,0.15))",
          backdropFilter: "blur(8px)",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 41, border: "3px solid rgba(255,255,255,0.55)",
          boxShadow: "0 4px 20px rgba(0,0,0,0.15)",
          position: "relative",
        }}>
          {user.avatar}
        </div>
        <h1 style={{ fontFamily: "'Shippori Mincho',serif", fontSize: 23, color: "#fff", textShadow: "0 2px 8px rgba(0,0,0,.2)", letterSpacing: 0.5 }}>{user.name}</h1>
        <p style={{ color: "rgba(255,255,255,.7)", fontSize: 14, marginTop: 4, fontFamily: "'Noto Sans JP',sans-serif" }}>{user.email}</p>

        {/* Stats row */}
        <div style={{ display: "flex", justifyContent: "center", gap: 16, marginTop: 18 }}>
          {[[groups.length, "Groups"],[totalGames, "Games"],[upcoming, "Upcoming"]].map(([n, lbl]) => (
            <div key={lbl} style={{ textAlign: "center", background: "rgba(255,255,255,.18)", backdropFilter: "blur(8px)", borderRadius: 14, padding: "8px 16px", border: "1px solid rgba(255,255,255,.3)" }}>
              <div style={{ fontFamily: "'Shippori Mincho',serif", fontSize: 21, color: "#fff", fontWeight: 700 }}>{n}</div>
              <div style={{ fontSize: 12, color: "rgba(255,255,255,.72)", fontFamily: "'Noto Sans JP',sans-serif", marginTop: 1 }}>{lbl}</div>
            </div>
          ))}
        </div>
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
            <span style={{ fontFamily: "'Shippori Mincho',serif", fontSize: 17, color: "var(--section-title)", fontWeight: 700 }}>My Profile</span>
<button onClick={() => setEditing(!editing)} style={{ background: editing ? "var(--active-tab-gradient)" : "rgba(var(--primary-rgb),0.12)", border: "none", borderRadius: 999, padding: "5px 14px", fontSize: 13, fontWeight: 700, color: editing ? "#fff" : "var(--primary)", cursor: "pointer", fontFamily: "'Noto Sans JP',sans-serif", transition: "all .2s" }}>
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
                    <div style={{ fontSize: 12, fontWeight: 700, color: skillLevel === lvl ? "#fff" : "var(--text-body)", fontFamily: "'Noto Sans JP',sans-serif" }}>{lvl}</div>
                  </div>
                ))}
              </div>
              <Lbl mt>Avatar</Lbl>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 18 }}>
                {AVATARS.map((a) => (
                  <div key={a} onClick={() => setAvatar(a)} style={{ fontSize: 27, padding: 7, borderRadius: 12, cursor: "pointer", background: avatar === a ? "var(--input-selected-bg)" : "var(--border-card)", border: `2px solid ${avatar === a ? "var(--primary)" : "transparent"}`, transition: "all .15s" }}>{a}</div>
                ))}
              </div>
              <Btn full onClick={save}>Save Changes ✨</Btn>
            </>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {[["👤", "Name", user.name], ["📧", "Email", user.email], ["🎭", "Avatar", user.avatar]].map(([icon, lbl, val]) => (
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
            </div>
          )}
        </div>

        {/* ── Subscription plan card ── */}
        {(() => {
          const plan = getPlan(user);
          const lim = getPlanLimits(planCfg);
          const hostCheck = canHostGame(user, planCfg);
          const groupsUsed = groups.length;
          const cycleResetDate = user.lastHostedAt
            ? new Date(user.lastHostedAt + lim.cycleDays * 24 * 60 * 60 * 1000)
            : null;
          const hostedThisCycle = user.lastHostedAt
            ? (Date.now() - user.lastHostedAt) < lim.cycleDays * 24 * 60 * 60 * 1000
            : false;

          const Bar = ({ used, max, color }) => (
            <div style={{ height: 6, background: "rgba(var(--primary-rgb),0.1)", borderRadius: 999, overflow: "hidden", marginTop: 6 }}>
              <div style={{ height: "100%", width: `${Math.min(100, (used / max) * 100)}%`, background: used >= max ? "var(--primary)" : color || "var(--secondary-accent)", borderRadius: 999, transition: "width .4s" }} />
            </div>
          );

          return (
            <div style={{
              background: "linear-gradient(135deg,var(--bg-card-base),var(--bg-card-alt))",
              backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)",
              borderRadius: 20, padding: "20px 18px", marginBottom: 14,
              boxShadow: "0 4px 20px rgba(var(--shadow-rgb),0.09), inset 0 1px 0 var(--shadow-inset)",
              border: "1px solid var(--border-card)",
            }}>
              {/* Header */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
                <span style={{ fontFamily: "'Shippori Mincho',serif", fontSize: 17, color: "var(--section-title)", fontWeight: 700 }}>Subscription</span>
                <span style={{
                  fontSize: 12, fontWeight: 800, letterSpacing: 0.5, textTransform: "uppercase",
                  background: "linear-gradient(135deg,rgba(var(--primary-rgb),0.12),rgba(var(--primary-rgb),0.06))",
                  color: "var(--primary)", borderRadius: 999, padding: "4px 12px",
                  border: "1px solid rgba(var(--primary-rgb),0.2)",
                  fontFamily: "'Noto Sans JP',sans-serif",
                }}>{planCfg?.name || "Free Plan"}</span>
              </div>

              {/* Usage rows */}
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                {/* Groups */}
                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-body)", fontFamily: "'Noto Sans JP',sans-serif" }}>👥 Groups</div>
                    <div style={{ fontSize: 13, color: groupsUsed >= lim.maxGroups ? "var(--primary)" : "var(--text-muted)", fontWeight: 700, fontFamily: "'Noto Sans JP',sans-serif" }}>
                      {groupsUsed} / {lim.maxGroups}
                    </div>
                  </div>
                  <Bar used={groupsUsed} max={lim.maxGroups} />
                  {groupsUsed >= lim.maxGroups && (
                    <div style={{ fontSize: 12, color: "var(--primary)", marginTop: 5, fontFamily: "'Noto Sans JP',sans-serif" }}>
                      Group limit reached
                    </div>
                  )}
                </div>

                {/* Hosted games */}
                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-body)", fontFamily: "'Noto Sans JP',sans-serif" }}>🀄 Hosted games / {lim.cycleDays}d</div>
                    <div style={{ fontSize: 13, color: hostedThisCycle ? "var(--primary)" : "var(--text-muted)", fontWeight: 700, fontFamily: "'Noto Sans JP',sans-serif" }}>
                      {hostedThisCycle ? 1 : 0} / {lim.gamesPerCycle}
                    </div>
                  </div>
                  <Bar used={hostedThisCycle ? 1 : 0} max={lim.gamesPerCycle} />
                  <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 5, fontFamily: "'Noto Sans JP',sans-serif" }}>
                    {hostedThisCycle
                      ? `Next slot available ${cycleResetDate.toLocaleDateString("en-US", { month: "short", day: "numeric" })} (${hostCheck.daysLeft}d)`
                      : "Slot available now"}
                  </div>
                </div>

                {/* Divider */}
                {(() => {
                  const feats = planCfg?.features?.length
                    ? planCfg.features
                    : ["Group & game chat", "Send group and game invites", "Add games to calendar"];
                  return (
                    <div style={{ borderTop: "1px solid var(--border-card)", paddingTop: 12 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8, fontFamily: "'Noto Sans JP',sans-serif" }}>Included</div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                        {feats.map((f) => (
                          <div key={f} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--text-body)", fontFamily: "'Noto Sans JP',sans-serif" }}>
                            <span style={{ color: "var(--secondary-accent)", fontWeight: 700 }}>✓</span> {f}
                          </div>
                        ))}
                      </div>
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
          <span style={{ fontFamily: "'Shippori Mincho',serif", fontSize: 17, color: "var(--section-title)", fontWeight: 700 }}>Notifications</span>
          <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", borderRadius: 14, background: "var(--bg-surface)", border: "1px solid rgba(var(--border-light-rgb),0.3)" }}>
              <div style={{ width: 40, height: 40, borderRadius: 12, background: notifEnabled ? "var(--active-tab-gradient)" : "rgba(var(--primary-rgb),0.1)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 21, transition: "all .2s" }}>
                {notifEnabled ? "🔔" : "🔕"}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-body)" }}>Push Notifications</div>
                <div style={{ fontSize: 13, color: "#b08090", marginTop: 2 }}>
                  {notifEnabled
                    ? "You'll be notified of new messages and game updates"
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
          <span style={{ fontFamily: "'Shippori Mincho',serif", fontSize: 17, color: "var(--section-title)", fontWeight: 700 }}>Appearance</span>
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
                    fontFamily: "'Noto Sans JP',sans-serif",
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
                  <div style={{ fontSize: 22, marginBottom: 6 }}>{t.emoji}</div>
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
          <div style={{ fontFamily: "'Shippori Mincho',serif", fontSize: 15, color: "var(--primary-muted)", fontWeight: 600 }}>Mahjong Club</div>
          <div style={{ fontSize: 12, color: "#c0a0b0", marginTop: 4, fontFamily: "'Noto Sans JP',sans-serif" }}>Version 1.0 · Made with ❤️</div>
        </div>

        {/* Admin Panel */}
        {isAdmin && !isImpersonating && <AdminPanel onImpersonate={onImpersonate} />}

        {/* Sign Out */}
        <button onClick={onSignOut} style={{
          width: "100%", padding: "13px", marginTop: 6, borderRadius: 999,
          background: "transparent", border: "2px solid rgba(var(--primary-rgb),0.35)",
          color: "var(--primary)", fontSize: 15, fontWeight: 700,
          fontFamily: "'Noto Sans JP',sans-serif", cursor: "pointer",
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

/* ── ALL GAMES PANEL (shared by Home + Account) ── */
function AllGamesPanel({ groups, guestGames = [], go }) {
  const [tab, setTab] = useState("upcoming");

  // Flatten all member games across all groups, then merge in guest games
  const memberGames = groups.flatMap((g) =>
    g.games.map((gm) => ({ ...gm, groupName: g.name, groupColor: g.color, groupId: g.id, groupEmoji: g.emoji }))
  );
  const allGames = [...memberGames, ...guestGames];
  const upcoming = allGames.filter((gm) => gm.date > NOW).sort((a, b) => a.date !== b.date ? a.date - b.date : (a.time || "").localeCompare(b.time || ""));
  const history = allGames.filter((gm) => gm.date <= NOW).sort((a, b) => a.date !== b.date ? b.date - a.date : (b.time || "").localeCompare(a.time || ""));
  const fullList = tab === "upcoming" ? upcoming : history;
  const list = fullList.slice(0, 3);

  return (
    <div style={{ marginTop: 4 }}>
      <h2 style={{ fontFamily: "'Shippori Mincho',serif", fontSize: 23, color: "var(--section-title)", letterSpacing: 0.5, marginBottom: 14 }}>Your Games</h2>
      {/* Tab pills */}
      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        {[["upcoming","📅 Upcoming"],["history","📖 History"]].map(([t, label]) => (
          <button key={t} onClick={() => { setTab(t); setShowAll(false); }} style={{
            padding: "6px 16px", borderRadius: 999, fontSize: 13, fontWeight: 700,
            fontFamily: "'Noto Sans JP',sans-serif", cursor: "pointer", transition: "all .18s",
            background: tab === t ? "var(--active-tab-gradient)" : "var(--bg-surface)",
            color: tab === t ? "#fff" : "#b08090",
            border: tab === t ? "none" : "1px solid rgba(var(--primary-rgb),0.2)",
            boxShadow: tab === t ? "0 3px 12px rgba(var(--shadow-rgb),0.3)" : "none",
          }}>{label}</button>
        ))}
      </div>

      {list.length === 0 ? (
        <div style={{ textAlign: "center", padding: "22px 0", color: "#c0a0b0" }}>
          <div style={{ fontSize: 31 }}>{tab === "upcoming" ? "📅" : "📖"}</div>
          <p style={{ fontSize: 14, marginTop: 8, fontFamily: "'Noto Sans JP',sans-serif" }}>
            {tab === "upcoming" ? "No upcoming games yet — time to schedule one!" : "No past games yet."}
          </p>
        </div>
      ) : (
        <>
          {list.map((gm, i) => (
            <div key={gm.id} className="sUp" style={{ animationDelay: `${i * 0.05}s`, cursor: "pointer" }}
              onClick={() => go(gm.isGuestGame ? "guestGame" : "game", gm.groupId, gm.id)}>
              <div style={{
                background: tab === "upcoming"
                  ? "linear-gradient(135deg,var(--bg-card),var(--bg-card-alt))"
                  : "rgba(245,235,242,0.55)",
                backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)",
                borderRadius: 16, padding: "13px 15px", marginBottom: 10,
                opacity: tab === "history" ? 0.75 : 1,
                boxShadow: tab === "upcoming" ? "0 4px 16px rgba(var(--shadow-rgb),0.08), inset 0 1px 0 var(--shadow-inset)" : "none",
                border: "1px solid var(--border-card)",
                borderLeft: `4px solid ${gm.groupColor}`,
              }}>
                <div style={{ fontWeight: 700, fontSize: 17, color: "var(--text-body)", fontFamily: "'Shippori Mincho',serif", marginBottom: 4 }}>{gm.title}</div>
                {/* Group tag + optional guest badge */}
                {!gm.isGuestGame && (
                  <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 4 }}>
                    <span style={{ fontSize: 13 }}>{gm.groupEmoji}</span>
                    <span style={{ fontSize: 12, fontWeight: 700, color: gm.groupColor, fontFamily: "'Noto Sans JP',sans-serif" }}>{gm.groupName}</span>
                  </div>
                )}
                {gm.isGuestGame && (
                  <div style={{ marginBottom: 4 }}>
                    <span style={{ fontSize: 11, fontWeight: 800, color: "var(--secondary-accent)", background: "rgba(155,110,168,0.12)", borderRadius: 999, padding: "1px 7px" }}>Guest</span>
                  </div>
                )}
                <div style={{ fontSize: 13, color: "#b08090", marginTop: 3 }}>📅 {fmt(gm.date)}</div>
                <div style={{ fontSize: 13, color: "#b08090", marginTop: 1 }}>🕐 {fmtRange(gm.time, gm.endTime)}</div>
                <div style={{ fontSize: 13, color: "#b08090", marginTop: 1 }}>📍 {gm.location}</div>
                {(() => {
                  const yesCount = Object.values(gm.rsvps).filter(v => v === "yes").length;
                  const wl = gm.waitlist || [];
                  const confirmedG = (gm.guests || []).filter(g => !wl.includes(g.id)).length;
                  const filled = yesCount + confirmedG;
                  return (
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
                      <Chip color="var(--secondary-accent)">✅ {filled}</Chip>
                      <Chip color="#c4936e">🤔 {Object.values(gm.rsvps).filter(v => v === "maybe").length}</Chip>
                      <Chip color="#b08090">👤 {filled}/{gm.seats}</Chip>
                      <div style={{ marginLeft: "auto" }}>
                        <AddToCalendar game={gm} groupName={gm.groupName} compact />
                      </div>
                    </div>
                  );
                })()}
              </div>
            </div>
          ))}
          {fullList.length > 3 && (
            <button onClick={() => go("games")} style={{
              width: "100%", padding: "10px 0", background: "none", border: "1px dashed rgba(var(--primary-rgb),0.3)",
              borderRadius: 12, color: "var(--primary)", fontSize: 14, fontWeight: 700,
              fontFamily: "'Noto Sans JP',sans-serif", cursor: "pointer", marginTop: 2,
            }}>
              See {fullList.length - 3} more ↓
            </button>
          )}
        </>
      )}
    </div>
  );
}

/* HOME */
function Home({ groups, guestGames, go, user, activeTheme, planCfg }) {

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
    <div style={{ minHeight: "100vh", background: bgSVG ? `${bgSVG}, linear-gradient(170deg,var(--bg-shell-start) 0%,var(--bg-shell-mid) 40%,var(--bg-shell-end) 100%)` : `linear-gradient(170deg,var(--bg-shell-start) 0%,var(--bg-shell-mid) 40%,var(--bg-shell-end) 100%)`, backgroundSize: bgSVG ? `${isFlowers ? "160px 160px" : isBamBird ? "180px 180px" : "120px 120px"}, cover` : "cover" }}>
      {/* Hero header — glassy */}
      <div style={{
        background: "var(--header-gradient2)",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
        padding: "36px 24px 28px",
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
            <p style={{ color: "rgba(255,255,255,.78)", fontWeight: 400, fontSize: 13, marginTop: 3, fontFamily: "'Noto Sans JP',sans-serif", letterSpacing: 1 }}>Schedule · Play · Enjoy</p>
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
          <h2 style={{ fontFamily: "'Shippori Mincho',serif", fontSize: 23, color: "var(--section-title)", letterSpacing: 0.5 }}>Your Groups</h2>
          <div style={{ display: "flex", gap: 8 }}>
            <Btn sm outline onClick={() => go("joinGroup")}>Join</Btn>
            <Btn sm onClick={() => { if (!canAddGroup(groups.length, user, planCfg).ok) { go("account"); return; } go("newGroup"); }}>+ New</Btn>
          </div>
        </div>

        {groups.length === 0 ? (
          <div style={{ textAlign: "center", padding: "44px 0", color: "var(--primary-subtle)" }}>
            <div style={{ fontSize: 49 }}>🀆</div>
            <p style={{ fontWeight: 700, marginTop: 10, fontSize: 17, fontFamily: "'Shippori Mincho',serif", color: "var(--primary-muted)" }}>No groups yet</p>
            <p style={{ fontSize: 14, marginTop: 4 }}>Create or join one to get started!</p>
          </div>
        ) : (
          <>
            {groups.slice(0, 3).map((g, i) => (
              <div key={g.id} className="sUp" style={{ animationDelay: `${i * 0.07}s`, cursor: "pointer" }} onClick={() => go("group", g.id)}>
                <div style={{
                  background: "linear-gradient(135deg,var(--bg-card-base) 0%,var(--bg-card-alt) 100%)",
                  backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)",
                  borderRadius: 20, padding: "15px 16px", marginBottom: 13,
                  display: "flex", alignItems: "center", gap: 13,
                  boxShadow: "0 4px 20px rgba(var(--shadow-rgb),0.10), inset 0 1px 0 var(--shadow-inset)",
                  border: "1px solid var(--border-card)", borderLeft: `4px solid ${g.color}`,
                }}>
                  <div style={{ width: 50, height: 50, borderRadius: 15, flexShrink: 0, background: `linear-gradient(135deg,${g.color}33,${g.color}18)`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 27, boxShadow: "inset 0 1px 0 var(--border-card)" }}>{g.emoji}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700, fontSize: 17, color: "var(--text-body)", fontFamily: "'Shippori Mincho',serif" }}>{g.name}</div>
                    <div style={{ fontSize: 13, color: "#b08090", marginTop: 2 }}>{g.members.length} members</div>
                  </div>
                  {g.games.filter((gm) => gm.date > NOW).length > 0 && (
                    <div style={{ background: `linear-gradient(135deg,${g.color},${g.color}cc)`, color: "#fff", borderRadius: 999, width: 26, height: 26, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 900, boxShadow: `0 2px 8px ${g.color}55` }}>{g.games.filter((gm) => gm.date > NOW).length}</div>
                  )}
                  <span style={{ color: "var(--primary-faint)", fontSize: 21 }}>›</span>
                </div>
              </div>
            ))}
            {groups.length > 3 && (
              <button onClick={() => go("groups")} style={{
                width: "100%", padding: "10px 0", background: "none", border: "1px dashed rgba(var(--primary-rgb),0.3)",
                borderRadius: 12, color: "var(--primary)", fontSize: 14, fontWeight: 700,
                fontFamily: "'Noto Sans JP',sans-serif", cursor: "pointer", marginBottom: 16,
              }}>
                See {groups.length - 3} more ↓
              </button>
            )}

            {/* All-groups games tabs */}
            <AllGamesPanel groups={groups} guestGames={guestGames} go={go} />
          </>
        )}
      </div>
    </div>
  );
}

/* GAMES PAGE */
function GamesPage({ groups, guestGames = [], go }) {
  const [tab, setTab] = useState("upcoming");

  const memberGames = groups.flatMap((g) =>
    g.games.map((gm) => ({ ...gm, groupName: g.name, groupColor: g.color, groupId: g.id, groupEmoji: g.emoji }))
  );
  const allGames = [...memberGames, ...guestGames];
  const upcoming = allGames.filter((gm) => gm.date > NOW).sort((a, b) => a.date !== b.date ? a.date - b.date : (a.time || "").localeCompare(b.time || ""));
  const history = allGames.filter((gm) => gm.date <= NOW).sort((a, b) => a.date !== b.date ? b.date - a.date : (b.time || "").localeCompare(a.time || ""));
  const list = tab === "upcoming" ? upcoming : history;

  return (
    <div style={{ minHeight: "100vh", background: "linear-gradient(170deg,var(--bg-shell-start) 0%,var(--bg-shell-mid) 40%,var(--bg-shell-end) 100%)" }}>

      {/* ── Header ── */}
      <div style={{ background: "var(--header-gradient2)", padding: "54px 22px 30px", position: "relative", overflow: "hidden" }}>
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

        <div style={{ position: "relative" }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: "rgba(255,255,255,0.60)", textTransform: "uppercase", letterSpacing: 2, marginBottom: 8 }}>Your Games</div>
          <h1 style={{ fontFamily: "'Shippori Mincho',serif", fontSize: 34, color: "#fff", textShadow: "0 2px 16px rgba(0,0,0,0.22)", lineHeight: 1, letterSpacing: 0.5 }}>
            {allGames.length} {allGames.length === 1 ? "Game" : "Games"}
          </h1>
          <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 10 }}>
            {upcoming.length > 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: 5, background: "rgba(255,255,255,0.15)", borderRadius: 999, padding: "4px 11px", backdropFilter: "blur(8px)" }}>
                <span style={{ fontSize: 13 }}>📅</span>
                <span style={{ fontSize: 12, fontWeight: 700, color: "rgba(255,255,255,0.9)" }}>{upcoming.length} upcoming</span>
              </div>
            )}
            {history.length > 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: 5, background: "rgba(255,255,255,0.12)", borderRadius: 999, padding: "4px 11px", backdropFilter: "blur(8px)" }}>
                <span style={{ fontSize: 13 }}>📖</span>
                <span style={{ fontSize: 12, fontWeight: 700, color: "rgba(255,255,255,0.75)" }}>{history.length} played</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Tab pills ── */}
      <div style={{ padding: "18px 16px 0" }}>
        <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
          {[["upcoming","📅 Upcoming"],["history","📖 History"]].map(([t, label]) => (
            <button key={t} onClick={() => setTab(t)} style={{
              padding: "8px 20px", borderRadius: 999, fontSize: 13, fontWeight: 700,
              fontFamily: "'Noto Sans JP',sans-serif", cursor: "pointer", transition: "all .18s",
              background: tab === t ? "var(--active-tab-gradient)" : "var(--bg-surface)",
              color: tab === t ? "#fff" : "#b08090",
              border: tab === t ? "none" : "1px solid rgba(var(--primary-rgb),0.2)",
              boxShadow: tab === t ? "0 3px 12px rgba(var(--shadow-rgb),0.3)" : "none",
            }}>{label}</button>
          ))}
        </div>
      </div>

      {/* ── Game list ── */}
      <div style={{ padding: "0 16px 24px" }}>
        {list.length === 0 ? (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "52px 24px", textAlign: "center" }}>
            <div style={{ fontSize: 48, marginBottom: 16, opacity: 0.4 }}>{tab === "upcoming" ? "📅" : "📖"}</div>
            <h2 style={{ fontFamily: "'Shippori Mincho',serif", fontSize: 20, color: "var(--primary-muted)", marginBottom: 8 }}>
              {tab === "upcoming" ? "No upcoming games" : "No past games yet"}
            </h2>
            <p style={{ fontSize: 14, color: "var(--text-muted)", lineHeight: 1.6, maxWidth: 260 }}>
              {tab === "upcoming" ? "Head to a group and schedule your next session." : "Completed games will appear here."}
            </p>
          </div>
        ) : (
          list.map((gm, i) => {
            const yesCount = Object.values(gm.rsvps).filter((v) => v === "yes").length;
            const wl = gm.waitlist || [];
            const confirmedG = (gm.guests || []).filter((g) => !wl.includes(g.id)).length;
            const filled = yesCount + confirmedG;
            return (
              <div key={`${gm.groupId}-${gm.id}`} className="sUp" style={{ animationDelay: `${i * 0.04}s`, cursor: "pointer" }}
                onClick={() => go(gm.isGuestGame ? "guestGame" : "game", gm.groupId, gm.id)}>
                <div style={{
                  background: tab === "upcoming"
                    ? "linear-gradient(135deg,var(--bg-card-base),var(--bg-card-alt))"
                    : "rgba(245,235,242,0.55)",
                  backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)",
                  borderRadius: 18, padding: "14px 15px", marginBottom: 10,
                  opacity: tab === "history" ? 0.78 : 1,
                  boxShadow: tab === "upcoming" ? "0 4px 18px rgba(var(--shadow-rgb),0.09), inset 0 1px 0 var(--shadow-inset)" : "none",
                  border: "1px solid var(--border-card)",
                  borderLeft: `4px solid ${gm.groupColor}`,
                }}>
                  <div style={{ fontWeight: 700, fontSize: 17, color: "var(--text-body)", fontFamily: "'Shippori Mincho',serif", marginBottom: 4 }}>{gm.title}</div>
                  {!gm.isGuestGame ? (
                    <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 5 }}>
                      <span style={{ fontSize: 13 }}>{gm.groupEmoji}</span>
                      <span style={{ fontSize: 12, fontWeight: 700, color: gm.groupColor, fontFamily: "'Noto Sans JP',sans-serif" }}>{gm.groupName}</span>
                    </div>
                  ) : (
                    <div style={{ marginBottom: 5 }}>
                      <span style={{ fontSize: 11, fontWeight: 800, color: "var(--secondary-accent)", background: "rgba(155,110,168,0.12)", borderRadius: 999, padding: "1px 7px" }}>Guest</span>
                    </div>
                  )}
                  <div style={{ fontSize: 13, color: "#b08090", marginTop: 2 }}>📅 {fmt(gm.date)}</div>
                  <div style={{ fontSize: 13, color: "#b08090", marginTop: 1 }}>🕐 {fmtRange(gm.time, gm.endTime)}</div>
                  <div style={{ fontSize: 13, color: "#b08090", marginTop: 1 }}>📍 {gm.location}</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 9, flexWrap: "wrap" }}>
                    <Chip color="var(--secondary-accent)">✅ {filled}</Chip>
                    <Chip color="#c4936e">🤔 {Object.values(gm.rsvps).filter((v) => v === "maybe").length}</Chip>
                    <Chip color="#b08090">👤 {filled}/{gm.seats}</Chip>
                    <div style={{ marginLeft: "auto" }}>
                      <AddToCalendar game={gm} groupName={gm.groupName || ""} compact />
                    </div>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

/* GROUPS PAGE */
function GroupsPage({ groups, go, user, planCfg }) {
  const totalUpcoming = groups.reduce((sum, g) => sum + g.games.filter((gm) => gm.date > NOW).length, 0);

  return (
    <div style={{ minHeight: "100vh", background: "linear-gradient(170deg,var(--bg-shell-start) 0%,var(--bg-shell-mid) 40%,var(--bg-shell-end) 100%)" }}>

      {/* ── Header ── */}
      <div style={{
        background: "var(--header-gradient2)",
        padding: "54px 22px 30px",
        position: "relative", overflow: "hidden",
      }}>
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

        <div style={{ position: "relative", display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 800, color: "rgba(255,255,255,0.60)", textTransform: "uppercase", letterSpacing: 2, marginBottom: 8 }}>Your Groups</div>
            <h1 style={{ fontFamily: "'Shippori Mincho',serif", fontSize: 34, color: "#fff", textShadow: "0 2px 16px rgba(0,0,0,0.22)", lineHeight: 1, letterSpacing: 0.5 }}>
              {groups.length} {groups.length === 1 ? "Group" : "Groups"}
            </h1>
            {totalUpcoming > 0 && (
              <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 5, background: "rgba(255,255,255,0.15)", borderRadius: 999, padding: "4px 11px", backdropFilter: "blur(8px)" }}>
                  <span style={{ fontSize: 13 }}>🀄</span>
                  <span style={{ fontSize: 12, fontWeight: 700, color: "rgba(255,255,255,0.9)" }}>
                    {totalUpcoming} upcoming
                  </span>
                </div>
              </div>
            )}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 4 }}>
            <button onClick={() => { if (!canAddGroup(groups.length, user, planCfg).ok) { go("account"); return; } go("newGroup"); }} style={{
              background: "rgba(255,255,255,0.22)", border: "1px solid rgba(255,255,255,0.40)",
              borderRadius: 999, padding: "8px 16px", fontSize: 13, fontWeight: 700,
              color: "#fff", fontFamily: "'Noto Sans JP',sans-serif", backdropFilter: "blur(8px)", cursor: "pointer",
              display: "flex", alignItems: "center", gap: 5,
            }}>＋ New</button>
            <button onClick={() => go("joinGroup")} style={{
              background: "rgba(255,255,255,0.10)", border: "1px solid rgba(255,255,255,0.25)",
              borderRadius: 999, padding: "8px 16px", fontSize: 13, fontWeight: 700,
              color: "rgba(255,255,255,0.85)", fontFamily: "'Noto Sans JP',sans-serif", backdropFilter: "blur(8px)", cursor: "pointer",
            }}>Join</button>
          </div>
        </div>
      </div>

      {/* ── List ── */}
      <div style={{ padding: "18px 16px 24px" }}>
        {groups.length === 0 ? (
          /* ── Empty state ── */
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
            <h2 style={{ fontFamily: "'Shippori Mincho',serif", fontSize: 22, color: "var(--primary-muted)", marginBottom: 8 }}>Your table awaits</h2>
            <p style={{ fontSize: 14, color: "var(--text-muted)", lineHeight: 1.6, marginBottom: 28, maxWidth: 260 }}>
              Create a group to start scheduling games and inviting your players.
            </p>
            <div style={{ display: "flex", gap: 10, width: "100%" }}>
              <button onClick={() => { if (!canAddGroup(groups.length, user, planCfg).ok) { go("account"); return; } go("newGroup"); }} style={{
                flex: 1, padding: "14px 0", borderRadius: 999, fontSize: 15, fontWeight: 700,
                fontFamily: "'Noto Sans JP',sans-serif", cursor: "pointer",
                background: "var(--active-tab-gradient)", color: "#fff",
                border: "none", boxShadow: "0 4px 16px var(--shadow-btn)",
              }}>＋ Create Group</button>
              <button onClick={() => go("joinGroup")} style={{
                flex: 1, padding: "14px 0", borderRadius: 999, fontSize: 15, fontWeight: 700,
                fontFamily: "'Noto Sans JP',sans-serif", cursor: "pointer",
                background: "var(--bg-surface)", color: "var(--primary)",
                border: "1.5px solid rgba(var(--primary-rgb),0.25)",
              }}>Join Group</button>
            </div>
          </div>
        ) : (
          groups.map((g, i) => {
            const upcoming = g.games.filter((gm) => gm.date > NOW).sort((a, b) => a.date - b.date);
            const nextGame = upcoming[0] || null;
            const isHost = g.members.some((m) => m.id === undefined ? false : m.host);
            return (
              <div key={g.id} className="sUp" style={{ animationDelay: `${i * 0.07}s`, cursor: "pointer", marginBottom: 14 }}
                onClick={() => go("group", g.id)}>
                <div style={{
                  background: "linear-gradient(135deg,var(--bg-card-base) 0%,var(--bg-card-alt) 100%)",
                  backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)",
                  borderRadius: 20, padding: "17px 16px",
                  boxShadow: `0 4px 22px rgba(var(--shadow-rgb),0.09), inset 0 1px 0 var(--shadow-inset)`,
                  border: "1px solid var(--border-card)",
                  borderLeft: `4px solid ${g.color}`,
                }}>
                  {/* Row 1: emoji + name + badge + chevron */}
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <div style={{
                      width: 52, height: 52, borderRadius: 15, flexShrink: 0,
                      background: `linear-gradient(135deg,${g.color}30,${g.color}14)`,
                      display: "flex", alignItems: "center", justifyContent: "center",
                      fontSize: 27, boxShadow: `inset 0 1px 0 rgba(255,255,255,0.6), 0 2px 10px ${g.color}28`,
                      border: `1.5px solid ${g.color}22`,
                    }}>{g.emoji}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: 18, color: "var(--text-body)", fontFamily: "'Shippori Mincho',serif", lineHeight: 1.2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{g.name}</div>
                      <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 3, fontFamily: "'Noto Sans JP',sans-serif" }}>
                        {g.members.length} {g.members.length === 1 ? "member" : "members"}
                      </div>
                    </div>
                    {upcoming.length > 0 && (
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
                        background: "var(--avatar-bubble-bg)",
                        border: "2.5px solid var(--bg-card-base)",
                        display: "flex", alignItems: "center", justifyContent: "center",
                        fontSize: 14, marginLeft: idx > 0 ? -9 : 0,
                        position: "relative", zIndex: 10 - idx,
                        boxShadow: "0 1px 4px rgba(var(--shadow-rgb),0.12)",
                      }}>{m.avatar}</div>
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
                  {nextGame ? (
                    <div style={{
                      marginTop: 12, padding: "10px 13px",
                      background: `${g.color}0e`, borderRadius: 12,
                      border: `1px solid ${g.color}28`,
                      display: "flex", alignItems: "center", gap: 10,
                    }}>
                      <div style={{ width: 34, height: 34, borderRadius: 10, background: `${g.color}20`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 17, flexShrink: 0 }}>📅</div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-body)", fontFamily: "'Shippori Mincho',serif", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{nextGame.title}</div>
                        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2, fontFamily: "'Noto Sans JP',sans-serif" }}>
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
                      <span style={{ fontSize: 12, color: "var(--text-muted)", fontFamily: "'Noto Sans JP',sans-serif" }}>No upcoming games</span>
                      <span style={{ fontSize: 12, fontWeight: 700, color: "var(--primary)", fontFamily: "'Noto Sans JP',sans-serif" }}>Schedule →</span>
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
function NewGroup({ onBack, onSave }) {
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState("🀄");
  const [color, setColor] = useState("#e63946");
  const [openInvites, setOpenInvites] = useState(false);
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
      <Lbl>Color</Lbl>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 20 }}>
        {COLORS.map((c) => (
          <div key={c} onClick={() => setColor(c)} style={{ width: 34, height: 34, borderRadius: 999, background: c, cursor: "pointer", boxShadow: color === c ? `0 0 0 3px #fff,0 0 0 5px ${c}` : "none", transition: "all .15s" }} />
        ))}
      </div>
      <OpenInvitesToggle value={openInvites} onChange={setOpenInvites} />
      <div style={{ marginTop: 24 }}>
        <Btn full disabled={!name.trim()} onClick={() =>
          onSave({ id: "G" + uid(), name: name.trim(), emoji, color, code: uid().slice(0, 5), members: [{ id: "me", name: "You", avatar: "🐼", host: true }], games: [], openInvites })
        }>🎉 Create Group</Btn>
      </div>
    </Shell>
  );
}

/* EDIT GROUP */
function EditGroup({ group, onBack, onSave }) {
  const [name, setName] = useState(group.name);
  const [emoji, setEmoji] = useState(group.emoji);
  const [color, setColor] = useState(group.color);
  const [openInvites, setOpenInvites] = useState(group.openInvites ?? false);
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
      <Lbl>Color</Lbl>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 20 }}>
        {COLORS.map((c) => (
          <div key={c} onClick={() => setColor(c)} style={{ width: 34, height: 34, borderRadius: 999, background: c, cursor: "pointer", boxShadow: color === c ? `0 0 0 3px #fff,0 0 0 5px ${c}` : "none", transition: "all .15s" }} />
        ))}
      </div>
      <OpenInvitesToggle value={openInvites} onChange={setOpenInvites} />
      <div style={{ marginTop: 24 }}>
        <Btn full disabled={!name.trim()} onClick={() =>
          onSave({ name: name.trim(), emoji, color, openInvites })
        }>Save Changes</Btn>
      </div>
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
          <div style={{ fontWeight: 700, fontSize: 15, color: "var(--text-body)", fontFamily: "'Shippori Mincho',serif" }}>Allow Members to Invite</div>
          <div style={{ fontSize: 13, color: "#b08090", marginTop: 3, fontFamily: "'Noto Sans JP',sans-serif" }}>
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
function JoinGroup({ uid, groups, onBack, onJoin, onJoinGame }) {
  const [mode, setMode] = useState(null); // null | "group" | "game"
  const [code, setCode] = useState("");
  const [groupMatch, setGroupMatch] = useState(null);
  const [gameMatch, setGameMatch] = useState(null);
  const [searching, setSearching] = useState(false);
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
    getDoc(doc(db, "gameCodes", clean))
      .then(async (codeSnap) => {
        if (!codeSnap.exists() || codeSnap.data().date < Date.now()) {
          setGameMatch(null); setSearching(false); return;
        }
        const { groupId, gameId } = codeSnap.data();
        const gameSnap = await getDoc(doc(db, "groups", groupId, "games", gameId));
        if (!gameSnap.exists()) { setGameMatch(null); setSearching(false); return; }
        setGameMatch({ ...gameSnap.data(), id: gameId, groupId });
        setSearching(false);
      })
      .catch(() => { setGameMatch(null); setSearching(false); });
  }, [clean, mode]);

  const alreadyInGroup = groupMatch && (groupMatch.memberIds || []).includes(uid);
  const alreadyInGame = gameMatch && (
    (gameMatch.memberIds || []).includes(uid) || (gameMatch.guestIds || []).includes(uid)
  );

  const handleBack = mode !== null ? () => setMode(null) : onBack;

  // ── Choice screen ─────────────────────────────────────────────────────────
  if (!mode) {
    return (
      <Shell title="Join" onBack={handleBack} color="var(--secondary-accent)">
        <div style={{ textAlign: "center", fontSize: 49, margin: "12px 0 20px" }}>🔑</div>
        <p style={{ textAlign: "center", fontWeight: 700, fontSize: 16, color: "var(--text-body)", marginBottom: 24, fontFamily: "'Shippori Mincho',serif" }}>
          What would you like to join?
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 13 }}>
          {[
            { id: "group", icon: "👥", label: "Join a Group", sub: "Enter a group code to become a member" },
            { id: "game",  icon: "🀄", label: "Join a Game",  sub: "Enter a game code to RSVP as a guest" },
          ].map(({ id, icon, label, sub }) => (
            <button key={id} onClick={() => setMode(id)} style={{
              display: "flex", alignItems: "center", gap: 16,
              padding: "18px 20px", borderRadius: 18, cursor: "pointer", textAlign: "left",
              background: "linear-gradient(135deg,var(--bg-card),var(--bg-card-alt))",
              border: "1.5px solid var(--border-card)",
              boxShadow: "0 4px 18px rgba(var(--shadow-rgb),0.09), inset 0 1px 0 var(--shadow-inset)",
              backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)",
              transition: "transform .14s",
            }}
              onMouseDown={(e) => { e.currentTarget.style.transform = "scale(.97)"; }}
              onMouseUp={(e) => { e.currentTarget.style.transform = "scale(1)"; }}
              onTouchStart={(e) => { e.currentTarget.style.transform = "scale(.97)"; }}
              onTouchEnd={(e) => { e.currentTarget.style.transform = "scale(1)"; }}
            >
              <div style={{
                width: 52, height: 52, borderRadius: 15, flexShrink: 0,
                background: "linear-gradient(135deg,rgba(var(--primary-rgb),0.14),rgba(var(--primary-rgb),0.07))",
                display: "flex", alignItems: "center", justifyContent: "center", fontSize: 26,
                border: "1.5px solid rgba(var(--primary-rgb),0.15)",
              }}>{icon}</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: 17, color: "var(--text-body)", fontFamily: "'Shippori Mincho',serif" }}>{label}</div>
                <div style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 3, fontFamily: "'Noto Sans JP',sans-serif" }}>{sub}</div>
              </div>
              <span style={{ color: "var(--primary-faint)", fontSize: 22 }}>›</span>
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
    <Shell title="Join a Game" onBack={handleBack} color="var(--secondary-accent)">
      <div style={{ textAlign: "center", fontSize: 49, margin: "8px 0 20px" }}>🀄</div>
      <Lbl>Game Code</Lbl>
      <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="e.g. TUES7PM"
        autoFocus
        style={{ width: "100%", padding: "14px 16px", background: "#fff", borderRadius: 14, fontSize: 23, fontWeight: 900, textAlign: "center", letterSpacing: 6, textTransform: "uppercase", marginBottom: 14, border: "2px solid var(--border-input)", color: "var(--text-body)", boxSizing: "border-box" }} />
      {searching && <p style={{ color: "var(--secondary-accent)", fontWeight: 700, fontSize: 15, marginBottom: 14, textAlign: "center" }}>Searching…</p>}
      {!searching && clean.length >= 3 && !gameMatch && <p style={{ color: "var(--primary)", fontWeight: 800, fontSize: 15, marginBottom: 14, textAlign: "center" }}>No game found with that code</p>}
      {gameMatch && !alreadyInGame && (
        <div className="bIn" style={{ background: "var(--bg-card)", border: "1.5px solid var(--border-card)", borderRadius: 16, padding: "16px 18px", marginBottom: 18, boxShadow: "0 4px 16px rgba(var(--shadow-rgb),0.08)" }}>
          <div style={{ fontWeight: 800, fontSize: 17, color: "var(--text-body)", fontFamily: "'Shippori Mincho',serif", marginBottom: 8 }}>{gameMatch.title}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            {gameMatch.date && <div style={{ fontSize: 14, color: "var(--text-muted)" }}>📅 {fmt(gameMatch.date)}{gameMatch.time ? ` · ${fmtT(gameMatch.time)}` : ""}</div>}
            {gameMatch.location && <div style={{ fontSize: 14, color: "var(--text-muted)" }}>📍 {gameMatch.location}</div>}
            {gameMatch.host && <div style={{ fontSize: 14, color: "var(--text-muted)" }}>🎯 Host: {gameMatch.host}</div>}
          </div>
        </div>
      )}
      {alreadyInGame && <p style={{ color: "var(--secondary-accent)", fontWeight: 800, fontSize: 15, marginBottom: 14, textAlign: "center" }}>You're already in this game!</p>}
      <Btn full disabled={!gameMatch || !!alreadyInGame} onClick={() => onJoinGame(gameMatch.groupId, gameMatch.id)}>Join Game</Btn>
    </Shell>
  );
}

/* GROUP DETAIL */
function Group({ uid, group, go, flash, onLeave, onTransferAndLeave, onTransferHost }) {
  const [tab, setTab] = useState("games");
  const [gamesTab, setGamesTab] = useState("upcoming");
  const [chatOpen, setChatOpen] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [transferMode, setTransferMode] = useState(null); // null | "leave" | "standalone"
  const [selectedNewHost, setSelectedNewHost] = useState(null);
  const upcoming = group.games.filter((g) => g.date > NOW).sort((a, b) => a.date !== b.date ? a.date - b.date : (a.time || "").localeCompare(b.time || ""));
  const past = group.games.filter((g) => g.date <= NOW).sort((a, b) => a.date !== b.date ? b.date - a.date : (b.time || "").localeCompare(a.time || ""));
  const gamesList = gamesTab === "upcoming" ? upcoming : past;
  const isCreator = group.members.some((m) => m.id === uid && m.host);
  const canInvite = isCreator || (group.openInvites ?? false);
  const otherMembers = group.members.filter((m) => m.id !== uid);

  const handleLeaveClick = () => {
    if (isCreator && otherMembers.length > 0) {
      setSelectedNewHost(null);
      setTransferMode("leave");
    } else {
      setConfirmLeave(true);
    }
  };
  return (
    <div style={{ minHeight: "100vh", background: `linear-gradient(170deg,var(--bg-shell-start) 0%,var(--bg-shell-mid) 40%,var(--bg-shell-end) 100%)` }}>
      <div style={{
        background: `linear-gradient(135deg,${group.color}f0,${group.color}bb)`,
        backdropFilter: "blur(14px)", WebkitBackdropFilter: "blur(14px)",
        padding: "52px 22px 28px", position: "relative", overflow: "hidden",
        boxShadow: `0 8px 32px ${group.color}44`,
      }}>
        <div style={{ position: "absolute", inset: 0, background: "linear-gradient(135deg,rgba(255,255,255,0.18) 0%,transparent 55%)", pointerEvents: "none" }} />
        {/* Back */}
        <button onClick={() => go("groups")} style={{ position: "absolute", top: 14, left: 14, background: "rgba(255,255,255,.28)", border: "1px solid rgba(255,255,255,.4)", borderRadius: 999, width: 36, height: 36, fontSize: 19, color: "#fff", backdropFilter: "blur(8px)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>‹</button>
        {/* Action icons */}
        <div style={{ position: "absolute", top: 14, right: 14, display: "flex", gap: 7 }}>
          {isCreator && (
            <button onClick={() => go("editGroup", group.id)} title="Edit group" style={{ width: 38, height: 38, borderRadius: 11, background: "rgba(255,255,255,.22)", border: "1px solid rgba(255,255,255,.38)", backdropFilter: "blur(8px)", cursor: "pointer", fontSize: 18, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff" }}>✏️</button>
          )}
          <button onClick={() => setChatOpen(true)} title="Group chat" style={{ width: 38, height: 38, borderRadius: 11, background: "rgba(255,255,255,.22)", border: "1px solid rgba(255,255,255,.38)", backdropFilter: "blur(8px)", cursor: "pointer", fontSize: 18, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff" }}>💬</button>
          {canInvite && (
            <button onClick={() => go("invite", group.id)} title="Invite" style={{ width: 38, height: 38, borderRadius: 11, background: "rgba(255,255,255,.22)", border: "1px solid rgba(255,255,255,.38)", backdropFilter: "blur(8px)", cursor: "pointer", fontSize: 18, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff" }}>✉️</button>
          )}
        </div>
        {/* Title */}
        <div style={{ textAlign: "center", position: "relative" }}>
          <div style={{ fontSize: 51, marginBottom: 6 }}>{group.emoji}</div>
          <h1 style={{ fontFamily: "'Shippori Mincho',serif", fontSize: 27, color: "#fff", textShadow: "0 2px 10px rgba(0,0,0,.25)", letterSpacing: 1 }}>{group.name}</h1>
          <div style={{ marginTop: 6, fontSize: 13, color: "rgba(255,255,255,0.75)", fontFamily: "'Noto Sans JP',sans-serif" }}>{group.members.length} member{group.members.length !== 1 ? "s" : ""}</div>
        </div>
      </div>

      <div style={{ display: "flex", background: "var(--bg-nav)", backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)", borderBottom: "1px solid rgba(var(--border-light-rgb),.4)" }}>
        {[["games","🀀 Games"],["members","👥 Members"]].map(([t, label]) => (
          <button key={t} onClick={() => setTab(t)} style={{ flex: 1, padding: "13px 0", fontSize: 15, fontWeight: 700, background: "none", border: "none", cursor: "pointer", color: tab === t ? group.color : "var(--primary-faint)", borderBottom: `3px solid ${tab === t ? group.color : "transparent"}`, fontFamily: "'Noto Sans JP',sans-serif", transition: "all .2s" }}>{label}</button>
        ))}
      </div>

      <div style={{ padding: "18px 16px 100px" }}>
        {tab === "games" && (
          <>
            <Btn full onClick={() => go("newGame", group.id)} style={{ marginBottom: 14 }}>🀄 Schedule a Game</Btn>

            {/* Upcoming / History tab pills */}
            <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
              {[["upcoming","📅 Upcoming"],["history","📖 History"]].map(([t, label]) => (
                <button key={t} onClick={() => setGamesTab(t)} style={{
                  padding: "6px 16px", borderRadius: 999, fontSize: 13, fontWeight: 700,
                  fontFamily: "'Noto Sans JP',sans-serif", cursor: "pointer", transition: "all .18s",
                  background: gamesTab === t ? `linear-gradient(135deg,${group.color},${group.color}cc)` : "var(--bg-surface)",
                  color: gamesTab === t ? "#fff" : "#b08090",
                  border: gamesTab === t ? "none" : "1px solid rgba(var(--primary-rgb),0.2)",
                  boxShadow: gamesTab === t ? `0 3px 12px ${group.color}55` : "none",
                }}>{label}</button>
              ))}
            </div>

            {gamesList.length === 0 ? (
              <div style={{ textAlign: "center", color: "var(--primary-subtle)", padding: "36px 0" }}>
                <div style={{ fontSize: 41 }}>{gamesTab === "upcoming" ? "📅" : "📖"}</div>
                <p style={{ fontWeight: 700, marginTop: 8, fontFamily: "'Shippori Mincho',serif", color: "var(--primary-muted)" }}>
                  {gamesTab === "upcoming" ? "No upcoming games yet!" : "No past games yet."}
                </p>
                {gamesTab === "upcoming" && <p style={{ fontSize: 14, marginTop: 4 }}>Be the first to schedule one.</p>}
              </div>
            ) : gamesList.map((gm, i) => (
              <div key={gm.id} className="sUp" style={{ animationDelay: `${i * 0.07}s`, cursor: "pointer" }}
                onClick={() => go("game", group.id, gm.id)}>
                <GCard game={gm} groupName={group.name} color={gamesTab === "upcoming" ? group.color : "#c0a8b8"} faded={gamesTab === "history"} />
              </div>
            ))}
          </>
        )}
        {tab === "members" && (
          <>
            {group.members.map((m) => (
              <div key={m.id} style={{ background: "linear-gradient(135deg,var(--bg-card-base),var(--bg-card-alt))", backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)", borderRadius: 16, padding: "13px 15px", marginBottom: 10, display: "flex", alignItems: "center", gap: 12, boxShadow: "0 4px 16px rgba(var(--shadow-rgb),0.09)", border: "1px solid var(--border-card)" }}>
                <div style={{ width: 42, height: 42, borderRadius: 999, background: "var(--avatar-bubble-bg)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 23, boxShadow: "inset 0 1px 0 var(--border-card)" }}>{m.avatar}</div>
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
              <Btn full outline danger onClick={handleLeaveClick}>Leave Group</Btn>
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
            <h3 style={{ fontFamily: "'Shippori Mincho',serif", fontSize: 20, color: "var(--text-body)", textAlign: "center", marginBottom: 6 }}>Transfer Host</h3>
            <p style={{ fontSize: 13, color: "var(--text-muted)", textAlign: "center", marginBottom: 20, lineHeight: 1.5, fontFamily: "'Noto Sans JP',sans-serif" }}>
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
                    <div style={{ width: 38, height: 38, borderRadius: 999, background: "var(--avatar-bubble-bg)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, border: selected ? `1.5px solid ${group.color}44` : "1.5px solid var(--border-card)", transition: "all .16s" }}>{m.avatar}</div>
                    <span style={{ flex: 1, fontWeight: 600, fontSize: 15, color: "var(--text-body)", fontFamily: "'Noto Sans JP',sans-serif" }}>{m.name}</span>
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
            <button onClick={() => setTransferMode(null)} style={{ width: "100%", marginTop: 10, padding: "12px 0", background: "none", border: "none", fontSize: 14, fontWeight: 700, color: "var(--text-muted)", cursor: "pointer", fontFamily: "'Noto Sans JP',sans-serif" }}>Cancel</button>
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
  const knownMsgIds = useRef(null); // null = initialising

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
      const msgs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

      // Notify about new messages from other members (skip initial load)
      if (knownMsgIds.current !== null) {
        msgs.forEach((msg) => {
          if (!knownMsgIds.current.has(msg.id) && msg.uid !== uid) {
            showBrowserNotif(
              `${msg.name} in ${group.name}`,
              msg.text,
              `chat-${group.id}-${msg.id}`
            );
          }
        });
      }
      knownMsgIds.current = new Set(msgs.map((m) => m.id));

      setMessages(msgs);
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
            <div style={{ fontFamily: "'Shippori Mincho',serif", fontSize: 18, fontWeight: 700, color: "var(--text-body)" }}>Group Chat</div>
            <div style={{ fontSize: 13, color: "#b08090" }}>{group.name} · {group.members.length} members</div>
          </div>
          <button onClick={() => { inputRef.current?.focus(); inputRef.current?.scrollIntoView({ behavior: "smooth" }); }} style={{ background: `linear-gradient(135deg,${group.color},${group.color}cc)`, border: "none", borderRadius: 999, width: 34, height: 34, fontSize: 20, cursor: "pointer", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: `0 2px 10px ${group.color}55`, marginRight: 4 }}>+</button>
          <button onClick={onClose} style={{ background: "rgba(var(--primary-rgb),0.1)", border: "none", borderRadius: 999, width: 34, height: 34, fontSize: 18, cursor: "pointer", color: "var(--primary)", display: "flex", alignItems: "center", justifyContent: "center" }}>✕</button>
        </div>

        {/* Notification banner */}
        {notifBanner && (
          <div style={{ margin: "8px 14px 0", background: "rgba(var(--primary-rgb),0.08)", border: "1px solid rgba(var(--primary-rgb),0.2)", borderRadius: 12, padding: "9px 12px", display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
            <span style={{ fontSize: 18 }}>🔔</span>
            <div style={{ flex: 1, fontSize: 13, color: "var(--section-title)", fontFamily: "'Noto Sans JP',sans-serif" }}>Get notified when members post</div>
            <button onClick={requestNotifications} style={{ background: `linear-gradient(135deg,${group.color},${group.color}cc)`, border: "none", borderRadius: 999, padding: "4px 12px", color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "'Noto Sans JP',sans-serif", whiteSpace: "nowrap" }}>Enable</button>
            <button onClick={() => setNotifBanner(false)} style={{ background: "none", border: "none", color: "#c0a0b0", fontSize: 16, cursor: "pointer", padding: 0, lineHeight: 1 }}>✕</button>
          </div>
        )}

        {/* Messages */}
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "12px 14px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
          {messages.length === 0 && (
            <div style={{ textAlign: "center", color: "#c0a0b0", padding: "48px 0" }}>
              <div style={{ fontSize: 40 }}>💬</div>
              <p style={{ fontSize: 15, marginTop: 10, fontFamily: "'Shippori Mincho',serif", color: "var(--primary-muted)" }}>No messages yet</p>
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
                    <div style={{ width: 34, height: 34, borderRadius: 999, background: "var(--avatar-bubble-bg)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, flexShrink: 0, alignSelf: "flex-start", marginTop: 18 }}>{msg.avatar}</div>
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
                        fontFamily: "'Noto Sans JP',sans-serif", transition: "all .13s",
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
                        fontWeight: 700, fontFamily: "'Noto Sans JP',sans-serif",
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
                    fontFamily: "'Noto Sans JP',sans-serif", fontWeight: showReplyInput ? 700 : 400,
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
                        <div style={{ width: 26, height: 26, borderRadius: 999, background: "var(--avatar-bubble-bg)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, flexShrink: 0 }}>{r.avatar}</div>
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
            fontFamily: "'Noto Sans JP',sans-serif",
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
  const knownMsgIds = useRef(null);

  // Lock background scroll while chat is open
  useEffect(() => {
    const el = document.querySelector("[data-scroll-container]");
    if (!el) return;
    const prev = el.style.overflowY;
    el.style.overflowY = "hidden";
    return () => { el.style.overflowY = prev; };
  }, []);

  useEffect(() => {
    const q = query(
      collection(db, "groups", group.id, "games", game.id, "messages"),
      orderBy("createdAt", "asc")
    );
    const unsub = onSnapshot(q, (snap) => {
      const msgs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      if (knownMsgIds.current !== null) {
        msgs.forEach((msg) => {
          if (!knownMsgIds.current.has(msg.id) && msg.uid !== uid) {
            showBrowserNotif(`${msg.name} · ${game.title}`, msg.text, `gchat-${game.id}-${msg.id}`);
          }
        });
      }
      knownMsgIds.current = new Set(msgs.map((m) => m.id));
      setMessages(msgs);
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
    await addDoc(collection(db, "groups", group.id, "games", game.id, "messages"), {
      uid, name: user.name, avatar: user.avatar,
      text: t, createdAt: serverTimestamp(),
      reactions: {}, replies: [],
    });
  };

  const toggleReaction = async (msg, emoji) => {
    const ref = doc(db, "groups", group.id, "games", game.id, "messages", msg.id);
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
    const ref = doc(db, "groups", group.id, "games", game.id, "messages", msgId);
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
            <div style={{ fontFamily: "'Shippori Mincho',serif", fontSize: 18, fontWeight: 700, color: "var(--text-body)" }}>{game.title}</div>
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
              <p style={{ fontSize: 15, marginTop: 10, fontFamily: "'Shippori Mincho',serif", color: "var(--primary-muted)" }}>No messages yet</p>
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
                    <div style={{ width: 34, height: 34, borderRadius: 999, background: "var(--avatar-bubble-bg)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, flexShrink: 0, alignSelf: "flex-start", marginTop: 18 }}>{msg.avatar}</div>
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
                        fontFamily: "'Noto Sans JP',sans-serif", transition: "all .13s",
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
                        fontWeight: 700, fontFamily: "'Noto Sans JP',sans-serif",
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
                    fontFamily: "'Noto Sans JP',sans-serif", fontWeight: showReplyInput ? 700 : 400,
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
                        <div style={{ width: 26, height: 26, borderRadius: 999, background: "var(--avatar-bubble-bg)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, flexShrink: 0 }}>{r.avatar}</div>
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
            fontFamily: "'Noto Sans JP',sans-serif",
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
          style={{ background: "rgba(var(--primary-rgb),0.1)", border: "1px solid rgba(var(--primary-rgb),0.25)", borderRadius: 999, padding: "3px 10px", fontSize: 12, fontWeight: 700, color: "var(--primary)", cursor: "pointer", fontFamily: "'Noto Sans JP',sans-serif" }}
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
      <div style={{ fontWeight: 700, color: "var(--text-body)", marginBottom: 12, fontFamily: "'Shippori Mincho',serif" }}>Add to Calendar</div>
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
const calMenuBtn = { display: "block", width: "100%", padding: "11px 16px", background: "none", border: "none", textAlign: "left", fontSize: 14, fontWeight: 700, color: "var(--text-body)", cursor: "pointer", fontFamily: "'Noto Sans JP',sans-serif" };
const calFullBtn = (color) => ({ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 5, padding: "12px 8px", borderRadius: 12, background: `${color}12`, border: `1.5px solid ${color}33`, cursor: "pointer", fontFamily: "'Noto Sans JP',sans-serif", fontSize: 13, fontWeight: 700, color: "var(--text-body)" });

function GCard({ game, groupName = "", color, faded }) {
  return (
<div style={{
      background: faded ? "rgba(245,235,240,0.6)" : "linear-gradient(135deg,var(--bg-card-base),var(--bg-card-alt))",
      backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)",
      borderRadius: 18, padding: "15px 16px", marginBottom: 11,
      opacity: faded ? 0.65 : 1,
      boxShadow: faded ? "none" : "0 4px 18px rgba(var(--shadow-rgb),0.10), inset 0 1px 0 var(--shadow-inset)",
      border: faded ? "1px solid rgba(200,180,190,0.3)" : "1px solid var(--border-card)",
      borderLeft: `4px solid ${color}`,
    }}>
      <div style={{ fontWeight: 700, fontSize: 17, color: "var(--text-body)", fontFamily: "'Shippori Mincho',serif", marginBottom: 3 }}>{game.title}</div>
      {groupName && <div style={{ fontSize: 12, fontWeight: 700, color, marginBottom: 4, fontFamily: "'Noto Sans JP',sans-serif" }}>{groupName}</div>}
      <div style={{ fontSize: 14, color: "#b08090", marginTop: 3 }}>📅 {fmt(game.date)}</div>
      <div style={{ fontSize: 14, color: "#b08090", marginTop: 1 }}>🕐 {fmtRange(game.time, game.endTime)}</div>
      <div style={{ fontSize: 14, color: "#b08090", marginTop: 1 }}>📍 {game.location}</div>
      {(() => {
        const yesCount = Object.values(game.rsvps).filter((v) => v === "yes").length;
        const wl = game.waitlist || [];
        const confirmedG = (game.guests || []).filter(g => !wl.includes(g.id)).length;
        const filled = yesCount + confirmedG;
        return (
          <div style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 10 }}>
            <Chip color="var(--secondary-accent)">✅ {filled}</Chip>
            <Chip color="#c4936e">🤔 {Object.values(game.rsvps).filter((v) => v === "maybe").length}</Chip>
            <Chip color="#b08090">👤 {filled}/{game.seats}</Chip>
            <div style={{ marginLeft: "auto" }}>
              <AddToCalendar game={game} groupName={groupName} compact />
            </div>
          </div>
        );
      })()}
    </div>
  );
}

/* NEW GAME */
function NewGame({ uid: myUid, user: myUser, group, planCfg, onBack, onSave }) {
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

  const otherMembers = group.members.filter((m) => m.id !== myUid);
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
      onSave({ id: "gm" + uid(), title: title.trim(), host: myUser.name, hostId: myUid, coHostIds: coHostArr, date: ts, time, endTime, location: loc.trim(), seats: tables * 4, rsvps, note, waitlist: [], joinCode: joinCode.trim().toUpperCase() });
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
      onSave(games);
    }
  };

  return (
    <Shell title="Schedule a Game" onBack={onBack} color={group.color}>
      <Lbl>Game Title</Lbl>
      <Fld value={title} set={setTitle} placeholder="e.g. Weekly Game Night" />
      <Lbl mt>Date</Lbl>
      <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={inputSt} />
      <Lbl mt>Time</Lbl>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#b08090", textTransform: "uppercase", letterSpacing: .5, marginBottom: 6, fontFamily: "'Noto Sans JP',sans-serif" }}>Start</div>
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)} style={{ ...inputSt, marginBottom: 0 }} />
        </div>
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#b08090", textTransform: "uppercase", letterSpacing: .5, marginBottom: 6, fontFamily: "'Noto Sans JP',sans-serif" }}>End</div>
          <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} style={{ ...inputSt, marginBottom: 0 }} />
        </div>
      </div>
      <Lbl mt>Location</Lbl>
      <Fld value={loc} set={setLoc} placeholder="e.g. 12 Oak Street" />
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "var(--bg-input)", border: "1.5px solid var(--border-input)", borderRadius: "var(--radius-input)", padding: "10px 14px", marginBottom: 14, marginTop: 10 }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 14, color: "var(--text-body)", fontFamily: "'Noto Sans JP',sans-serif" }}>Tables</div>
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 1 }}>{tables * 4} seats total</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button onClick={() => setTables((t) => Math.max(1, t - 1))} style={{ width: 32, height: 32, borderRadius: 999, border: `1.5px solid rgba(var(--primary-rgb),0.25)`, background: "var(--bg-card)", fontSize: 18, color: "var(--primary)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700 }}>−</button>
          <span style={{ minWidth: 24, textAlign: "center", fontWeight: 700, fontSize: 16, color: group.color, fontFamily: "'Shippori Mincho',serif" }}>{tables}</span>
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
              fontFamily: "'Noto Sans JP',sans-serif", transition: "all .18s",
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
                    background: selected ? `linear-gradient(135deg,${group.color}33,${group.color}18)` : "var(--avatar-bubble-bg)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 20, border: selected ? `1.5px solid ${group.color}44` : "1.5px solid var(--border-card)",
                    transition: "all .18s",
                  }}>{m.avatar}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 15, color: "var(--text-body)", fontFamily: "'Noto Sans JP',sans-serif" }}>{m.name}</div>
                    {isCoHostMember && <div style={{ fontSize: 11, fontWeight: 700, color: "#b8860b", marginTop: 1, fontFamily: "'Noto Sans JP',sans-serif" }}>👑 Co-host</div>}
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
            <div style={{ fontWeight: 700, fontSize: 15, color: "var(--text-body)", fontFamily: "'Shippori Mincho',serif" }}>
              🔁 Recurring Game
              {recurringLocked && <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 700, background: "rgba(var(--primary-rgb),0.1)", color: "var(--primary)", borderRadius: 999, padding: "2px 8px", fontFamily: "'Noto Sans JP',sans-serif" }}>Paid plan</span>}
            </div>
            <div style={{ fontSize: 13, color: "#b08090", marginTop: 2, fontFamily: "'Noto Sans JP',sans-serif" }}>
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
                  <div style={{ fontSize: 12, fontWeight: 700, fontFamily: "'Noto Sans JP',sans-serif" }}>{f.label}</div>
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
                  fontFamily: "'Noto Sans JP',sans-serif",
                }}>{n}</div>
              ))}
            </div>

            {/* Preview dates */}
            {date && (
              <div style={{ background: "var(--bg-surface)", borderRadius: 12, padding: "12px 14px", border: "1px solid rgba(var(--border-light-rgb),0.4)" }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "var(--primary-faint)", textTransform: "uppercase", letterSpacing: .5, marginBottom: 8, fontFamily: "'Noto Sans JP',sans-serif" }}>
                  Preview — {occurrences} sessions
                </div>
                {previewDates().map((ts, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: i < occurrences - 1 ? 6 : 0 }}>
                    <div style={{ width: 20, height: 20, borderRadius: 999, background: `linear-gradient(135deg,${group.color}44,${group.color}22)`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: group.color, flexShrink: 0, fontFamily: "'Noto Sans JP',sans-serif" }}>{i + 1}</div>
                    <span style={{ fontSize: 14, color: "var(--text-body)", fontFamily: "'Noto Sans JP',sans-serif" }}>{fmt(ts)} · {fmtT(time)}</span>
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
            <div style={{ fontSize: 12, fontWeight: 700, fontFamily: "'Noto Sans JP',sans-serif",
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
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 6, fontFamily: "'Noto Sans JP',sans-serif" }}>
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
function GuestGameView({ uid, groupId, gameId, go, flash }) {
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
        setGroupMeta({ id: groupId, name: d.name, color: d.color, emoji: d.emoji, members: [], openInvites: false, games: [] });
      }
    }).catch(() => {});
    return unsub;
  }, [groupId, gameId]);

  if (!game || !groupMeta) return (
    <div style={{ minHeight: "100vh", background: "linear-gradient(170deg,var(--bg-shell-start) 0%,var(--bg-shell-mid) 40%,var(--bg-shell-end) 100%)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12 }}>
      <div style={{ fontSize: 41 }}>🀄</div>
      <div style={{ fontFamily: "'Shippori Mincho',serif", fontSize: 17, color: "var(--primary-muted)" }}>Loading game…</div>
    </div>
  );

  return (
    <Game uid={uid} game={game} group={groupMeta} go={go} isGuestView
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
      onDelete={null}
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

/* GAME DETAIL */
function Game({ uid, user, game, group, go, onRsvp, onWaitlist, onDelete, isGuestView = false }) {
  const [showAttendees, setShowAttendees] = useState(false);
  const [rsvpTab, setRsvpTab] = useState("going");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [seatingOpen, setSeatingOpen] = useState(false);
  // Firestore forbids nested arrays, so each table is stored as { players: [...] }.
  // Internally we keep seating as [[uid,...], ...] for simplicity.
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
  const isCreator = !isGuestView && group.members.some((m) => m.id === uid && m.host);
  const isCoHost = !isGuestView && (game.coHostIds || []).includes(uid);
  const canInvite = !isGuestView && (isCreator || isCoHost || (game.hostId === uid) || (group.openInvites ?? false));
  const myRsvp = game.rsvps[uid] || "pending";
  const yes = Object.values(game.rsvps).filter((v) => v === "yes").length;
  const maybe = Object.values(game.rsvps).filter((v) => v === "maybe").length;
  const no = Object.values(game.rsvps).filter((v) => v === "no").length;
  const past = game.date < NOW;
  const rawWaitlist = game.waitlist || [];   // array of IDs (member or guest)
  const onWaitlistMe = rawWaitlist.includes(uid);
  const allGuests = game.guests || [];
  const confirmedGuests = allGuests.filter((g) => !rawWaitlist.includes(g.id));
  const totalSeats = game.seats || 4;
  // filled = yes member RSVPs + confirmed (non-waitlisted) guests
  const filledSeats = yes + confirmedGuests.length;
  const isFull = filledSeats >= totalSeats;
  const seatsLeft = Math.max(0, totalSeats - filledSeats);

  // Build a single unified waitlist display list — drop anyone no longer in the game
  const unifiedWaitlist = rawWaitlist
    .map((id) => {
      const guest = allGuests.find((g) => g.id === id);
      if (guest) return { id, name: guest.name, avatar: guest.avatar, isGuest: true };
      const member = group.members.find((m) => m.id === id);
      if (member) return { id, name: member.name, avatar: member.avatar, isGuest: false };
      return null; // removed from game/group — omit
    })
    .filter(Boolean);

  // ── Seating helpers ──
  const isHost = !isGuestView && (game.hostId === uid || isCoHost);
  const goingUids = Object.entries(game.rsvps || {}).filter(([, v]) => v === "yes").map(([id]) => id);
  const seatingPool = [...goingUids, ...confirmedGuests.map(g => g.id)];
  // Lookup: id → {name, avatar}
  const playerLookup = {};
  group.members.forEach(m => { playerLookup[m.id] = { name: m.name, avatar: m.avatar }; });
  (game.guests || []).forEach(g => { playerLookup[g.id] = { name: g.name, avatar: g.avatar }; });

  // Fetch skill levels for all going members when host opens seating
  useEffect(() => {
    if (!seatingOpen || !isHost) return;
    const missing = goingUids.filter(id => !(id in skillMap));
    if (!missing.length) return;
    setSeatingLoading(true);
    Promise.all(missing.map(id => getDoc(doc(db, "users", id))))
      .then(snaps => {
        const updates = {};
        snaps.forEach((snap, i) => { updates[missing[i]] = snap.data()?.skillLevel ?? null; });
        setSkillMap(prev => ({ ...prev, ...updates }));
      })
      .finally(() => setSeatingLoading(false));
  }, [seatingOpen]);

  const saveSeating = async (next) => {
    setSeating(next);
    // Firestore doesn't support nested arrays — wrap each table in an object
    try { await updateDoc(doc(db, "groups", group.id, "games", game.id), { seating: next.map(t => ({ players: t })) }); } catch (e) { console.error("saveSeating:", e); }
  };

  const doRandomize = () => {
    const tables = generateSeating(seatingPool, skillMap);
    saveSeating(tables);
    setMovingUid(null);
    setConfirmReRandomize(false);
  };

  const handleRandomize = () => {
    if (seating) { setConfirmReRandomize(true); return; }
    doRandomize();
  };

  const handlePlayerTap = (pid) => {
    if (!movingUid) { setMovingUid(pid); return; }
    if (movingUid === pid) { setMovingUid(null); return; }
    // Swap the two players across tables
    const next = seating.map(t => [...t]);
    let [fi, fj, ti, tj] = [-1, -1, -1, -1];
    for (let r = 0; r < next.length; r++) {
      const mi = next[r].indexOf(movingUid); if (mi >= 0) { fi = r; fj = mi; }
      const pi = next[r].indexOf(pid);       if (pi >= 0) { ti = r; tj = pi; }
    }
    if (fi >= 0 && ti >= 0) {
      next[fi][fj] = pid;
      next[ti][tj] = movingUid;
      saveSeating(next);
    }
    setMovingUid(null);
  };

  const SKILL_ICON = { Advanced: "🏆", Intermediate: "🀄", Beginner: "🌱" };

  return (
    <>
    <div style={{ minHeight: "100vh", background: `linear-gradient(170deg,var(--bg-shell-start) 0%,var(--bg-shell-mid) 40%,var(--bg-shell-end) 100%)` }}>
      <div style={{ background: `linear-gradient(135deg,${group.color}f0,${group.color}bb)`, backdropFilter: "blur(14px)", WebkitBackdropFilter: "blur(14px)", padding: "52px 22px 28px", position: "relative", overflow: "hidden", boxShadow: `0 8px 32px ${group.color}44` }}>
        <div style={{ position: "absolute", inset: 0, background: "linear-gradient(135deg,rgba(255,255,255,0.18) 0%,transparent 55%)", pointerEvents: "none" }} />
        {/* Back */}
        <button onClick={() => isGuestView ? go("home") : go("group", group.id)} style={{ position: "absolute", top: 14, left: 14, background: "rgba(255,255,255,.28)", border: "1px solid rgba(255,255,255,.4)", borderRadius: 999, width: 36, height: 36, fontSize: 19, color: "#fff", backdropFilter: "blur(8px)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>‹</button>
        {/* Action icons */}
        <div style={{ position: "absolute", top: 14, right: 14, display: "flex", gap: 7 }}>
          {isHost && (
            <button onClick={() => go("editGame", group.id, game.id)} title="Edit game" style={{ width: 38, height: 38, borderRadius: 11, background: "rgba(255,255,255,.22)", border: "1px solid rgba(255,255,255,.38)", backdropFilter: "blur(8px)", cursor: "pointer", fontSize: 18, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff" }}>✏️</button>
          )}
          {!isGuestView && (
            <button onClick={() => setGameChatOpen(true)} title="Game chat" style={{ width: 38, height: 38, borderRadius: 11, background: "rgba(255,255,255,.22)", border: "1px solid rgba(255,255,255,.38)", backdropFilter: "blur(8px)", cursor: "pointer", fontSize: 18, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff" }}>💬</button>
          )}
          {canInvite && (
            <button onClick={() => go("invite", group.id, game.id)} title="Invite" style={{ width: 38, height: 38, borderRadius: 11, background: "rgba(255,255,255,.22)", border: "1px solid rgba(255,255,255,.38)", backdropFilter: "blur(8px)", cursor: "pointer", fontSize: 18, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff" }}>✉️</button>
          )}
        </div>
        {/* Title + meta */}
        <div style={{ textAlign: "center", position: "relative" }}>
          <h1 style={{ fontFamily: "'Shippori Mincho',serif", fontSize: 25, color: "#fff", textShadow: "0 2px 10px rgba(0,0,0,.2)", marginBottom: 8 }}>{game.title}</h1>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
            <div style={{ fontSize: 15, color: "rgba(255,255,255,0.85)", fontFamily: "'Noto Sans JP',sans-serif" }}>
              📅 {fmt(game.date)}{game.time ? ` · ${fmtT(game.time)}` : ""}{game.endTime ? ` – ${fmtT(game.endTime)}` : ""}
            </div>
            {game.location && (
              <button
                onClick={() => {
                  if (window.confirm(`Open "${game.location}" in Maps?`)) {
                    window.location.href = `https://maps.apple.com/?q=${encodeURIComponent(game.location)}`;
                  }
                }}
                style={{ background: "none", border: "none", cursor: "pointer", padding: "2px 8px", borderRadius: 999, fontSize: 15, color: "rgba(255,255,255,0.72)", fontFamily: "'Noto Sans JP',sans-serif", textDecoration: "underline", textDecorationStyle: "dotted", textUnderlineOffset: 3 }}
              >📍 {game.location}</button>
            )}
          </div>
        </div>
      </div>
      <div style={{ padding: "18px 16px 100px" }}>
        <IRow icon="🎯" label="Host" val={game.host} />
        <IRow icon="👥" label="Seats" val={`${filledSeats} / ${totalSeats} filled${seatsLeft > 0 ? ` · ${seatsLeft} open` : " · Full"}`} />
        {game.recurring && <IRow icon="🔁" label="Recurring" val={{ weekly: "Weekly", biweekly: "Every 2 Weeks", monthly: "Monthly" }[game.recurring] || game.recurring} />}
        {game.note && <IRow icon="📝" label="Host Notes" val={game.note} />}

        {/* Capacity bar */}
        <div style={{ marginBottom: 12 }}>
          <div style={{ height: 8, background: "rgba(var(--primary-rgb),0.15)", borderRadius: 999, overflow: "hidden" }}>
            <div style={{
              height: "100%", borderRadius: 999,
              width: `${Math.min(100, (filledSeats / totalSeats) * 100)}%`,
              background: isFull
                ? "linear-gradient(90deg,var(--primary),#a8426b)"
                : "linear-gradient(90deg,var(--secondary-accent),var(--primary))",
              transition: "width .4s ease",
            }} />
          </div>
          {isFull && (
            <div style={{ fontSize: 12, fontWeight: 700, color: "var(--primary)", marginTop: 4, textAlign: "center", fontFamily: "'Noto Sans JP',sans-serif" }}>
              🀄 Game is full — {unifiedWaitlist.length} on waitlist
            </div>
          )}
        </div>

        {/* RSVPs card */}
        {(() => {
          // Build named lists for each status
          // Returns null if the person is no longer in the game/group
          const resolveName = (id) => {
            const m = group.members.find((m) => m.id === id);
            if (m) return { name: m.name, avatar: m.avatar };
            const g = allGuests.find((g) => g.id === id);
            if (g) return { name: g.name, avatar: g.avatar, isGuest: true };
            return null;
          };
          const goingList = [
            ...Object.entries(game.rsvps).filter(([, v]) => v === "yes")
              .map(([id]) => { const r = resolveName(id); return r ? { id, ...r } : null; })
              .filter(Boolean),
            ...confirmedGuests.map((g) => ({ ...g, isGuest: true })),
          ];
          const maybeList = Object.entries(game.rsvps).filter(([, v]) => v === "maybe")
            .map(([id]) => { const r = resolveName(id); return r ? { id, ...r } : null; })
            .filter(Boolean);
          const noList = Object.entries(game.rsvps).filter(([, v]) => v === "no")
            .map(([id]) => { const r = resolveName(id); return r ? { id, ...r } : null; })
            .filter(Boolean);

          const AttendeeRow = ({ entry }) => (
            <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "5px 0" }}>
              <span style={{ fontSize: 19 }}>{entry.avatar}</span>
              <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text-body)", flex: 1, fontFamily: "'Noto Sans JP',sans-serif" }}>{entry.name}</span>
              {entry.id === game.hostId && <span style={{ fontSize: 11, color: "#8a6a00", fontWeight: 700, background: "rgba(212,168,67,0.15)", borderRadius: 999, padding: "2px 8px" }}>⭐ Host</span>}
              {(game.coHostIds || []).includes(entry.id) && <span style={{ fontSize: 11, color: "#8a6a00", fontWeight: 700, background: "rgba(212,168,67,0.12)", borderRadius: 999, padding: "2px 8px" }}>👑 Co-host</span>}
              {entry.isGuest && <span style={{ fontSize: 11, color: "var(--secondary-accent)", fontWeight: 700, background: "rgba(155,110,168,0.1)", borderRadius: 999, padding: "2px 8px" }}>Guest</span>}
              {entry.id === uid && <span style={{ fontSize: 11, color: "var(--primary)", fontWeight: 700, background: "rgba(var(--primary-rgb),0.1)", borderRadius: 999, padding: "2px 8px" }}>You</span>}
            </div>
          );

          const rsvpTabs = [
            { key: "going",    icon: "✅", color: "var(--secondary-accent)", list: goingList },
            { key: "maybe",    icon: "🤔", color: "#c4936e",                  list: maybeList },
            { key: "no",       icon: "❌", color: "var(--primary)",            list: noList },
            { key: "waitlist", icon: "⏳", color: "var(--text-muted)",         list: unifiedWaitlist },
          ].filter((t) => t.list.length > 0);

          // If current tab was filtered out (count dropped to 0), fall back to going
          const activeTab = rsvpTabs.find((t) => t.key === rsvpTab) ?? rsvpTabs[0];

          return (
            <div style={{ background: "linear-gradient(135deg,var(--bg-card),var(--bg-card-alt))", backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)", borderRadius: 16, marginBottom: 12, boxShadow: "0 4px 16px rgba(var(--shadow-rgb),0.08), inset 0 1px 0 var(--shadow-inset)", border: "1px solid var(--border-card)", overflow: "hidden" }}>
              {/* Header — whole row toggles expand; chips also switch active tab */}
              <div onClick={() => setShowAttendees((v) => !v)} style={{ padding: "15px 16px", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div style={{ fontWeight: 700, color: "var(--text-body)", fontFamily: "'Shippori Mincho',serif" }}>RSVPs</div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ display: "flex", gap: 6 }}>
                    {rsvpTabs.map((t) => {
                      const isActive = showAttendees && activeTab?.key === t.key;
                      return (
                        <button key={t.key}
                          onClick={(e) => { e.stopPropagation(); setShowAttendees(true); setRsvpTab(t.key); }}
                          style={{ background: isActive ? t.color : "rgba(var(--primary-rgb),0.08)", border: isActive ? "none" : "1px solid rgba(var(--primary-rgb),0.15)", borderRadius: 999, padding: "4px 10px", fontSize: 12, fontWeight: 700, color: isActive ? "#fff" : "var(--text-muted)", cursor: "pointer", fontFamily: "'Noto Sans JP',sans-serif", transition: "all .15s", boxShadow: isActive ? `0 2px 8px ${t.color}55` : "none" }}>
                          {t.icon} {t.list.length}
                        </button>
                      );
                    })}
                  </div>
                  <span style={{ fontSize: 17, color: "var(--primary-faint)", transition: "transform .2s", display: "inline-block", transform: showAttendees ? "rotate(180deg)" : "rotate(0deg)" }}>⌄</span>
                </div>
              </div>

              {/* Expanded — only the active tab's list */}
              {showAttendees && activeTab && (
                <div style={{ borderTop: "1px solid rgba(var(--border-light-rgb),0.2)", padding: "10px 16px 14px" }}>
                  {activeTab.key === "waitlist" ? (
                    activeTab.list.map((entry, i) => (
                      <div key={entry.id} style={{ display: "flex", alignItems: "center", gap: 9, padding: "5px 0" }}>
                        <div style={{ width: 20, height: 20, borderRadius: 999, background: "rgba(var(--primary-rgb),0.15)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: "var(--primary)", flexShrink: 0 }}>{i + 1}</div>
                        <span style={{ fontSize: 19 }}>{entry.avatar}</span>
                        <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text-body)", flex: 1, fontFamily: "'Noto Sans JP',sans-serif" }}>{entry.name}</span>
                        {entry.isGuest && <span style={{ fontSize: 11, color: "var(--secondary-accent)", fontWeight: 700, background: "rgba(155,110,168,0.1)", borderRadius: 999, padding: "2px 8px" }}>Guest</span>}
                        {entry.id === uid && <span style={{ fontSize: 11, color: "var(--primary)", fontWeight: 700, background: "rgba(var(--primary-rgb),0.1)", borderRadius: 999, padding: "2px 8px" }}>You</span>}
                      </div>
                    ))
                  ) : (
                    activeTab.list.map((entry) => <AttendeeRow key={entry.id} entry={entry} />)
                  )}
                </div>
              )}
            </div>
          );
        })()}

        {/* Your RSVP / Waitlist */}
        {!past && (
          <div style={{ background: "linear-gradient(135deg,var(--bg-card),var(--bg-card-alt))", backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)", borderRadius: 16, padding: "15px 16px", marginBottom: 12, boxShadow: "0 4px 16px rgba(var(--shadow-rgb),0.08), inset 0 1px 0 var(--shadow-inset)", border: "1px solid var(--border-card)" }}>
            <div style={{ fontWeight: 700, color: "var(--text-body)", marginBottom: 10, fontFamily: "'Shippori Mincho',serif" }}>Your RSVP</div>

            {/* Host / co-host cannot change their own RSVP */}
            {game.hostId === uid || isCoHost ? (
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderRadius: 12, background: "linear-gradient(135deg,rgba(155,110,168,0.15),rgba(var(--primary-rgb),0.1))", border: "1px solid rgba(155,110,168,0.25)", marginBottom: 10 }}>
                  <span style={{ fontSize: 19 }}>{isCoHost && game.hostId !== uid ? "👑" : "⭐"}</span>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 14, color: "var(--text-body)", fontFamily: "'Noto Sans JP',sans-serif" }}>
                      {isCoHost && game.hostId !== uid ? "You're a co-host — you're always going!" : "You're the host — you're always going!"}
                    </div>
                    <div style={{ fontSize: 12, color: "#b08090", marginTop: 2, fontFamily: "'Noto Sans JP',sans-serif" }}>
                      {isCoHost && game.hostId !== uid ? "The host can remove your co-host role in Edit → Players" : "To step down, transfer host in Edit → Players"}
                    </div>
                  </div>
                </div>
              </div>
            ) : isFull && myRsvp !== "yes" ? (
              /* Full game waitlist */
              <div>
                <div style={{ fontSize: 14, color: "#7a4a58", marginBottom: 12, fontFamily: "'Noto Sans JP',sans-serif", lineHeight: 1.6 }}>
                  This game is full. {onWaitlistMe ? "You're on the waitlist — we'll let you know if a spot opens up! 🌸" : "Join the waitlist and you'll be notified if a spot opens up."}
                </div>
                <button onClick={() => onWaitlist(onWaitlistMe ? "leave" : "join")} style={{
                  width: "100%", padding: "11px 0", borderRadius: 12, fontSize: 14, fontWeight: 700,
                  cursor: "pointer", transition: "all .2s", fontFamily: "'Noto Sans JP',sans-serif", border: "none",
                  background: onWaitlistMe ? "rgba(var(--primary-rgb),0.12)" : "linear-gradient(135deg,rgba(155,110,168,0.85),rgba(var(--primary-rgb),0.85))",
                  color: onWaitlistMe ? "var(--primary)" : "#fff",
                  boxShadow: onWaitlistMe ? "none" : "0 4px 14px rgba(var(--shadow-rgb),0.3)",
                }}>
                  {onWaitlistMe ? "✕ Leave Waitlist" : "⏳ Join Waitlist"}
                </button>
              </div>
            ) : (
              /* Normal RSVP buttons */
              <div style={{ display: "flex", gap: 8 }}>
                {[["yes","✅ Going","#9b6ea8"],["maybe","🤔 Maybe","#c4936e"],["no","❌ Can't","#c9607a"]].map(([v, label, col]) => (
                  <button key={v} onClick={() => onRsvp(v)} style={{ flex: 1, padding: "10px 4px", borderRadius: 12, fontSize: 13, fontWeight: 700, background: myRsvp === v ? col : "#f7eef2", color: myRsvp === v ? "#fff" : "#c0a0ac", border: "none", cursor: "pointer", transition: "all .18s", fontFamily: "'Noto Sans JP',sans-serif" }}>{label}</button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Table Seating (host only, collapsible) ── */}
        {(isHost || (!isGuestView && seating)) && (
          <div style={{ background: "linear-gradient(135deg,var(--bg-card),var(--bg-card-alt))", backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)", borderRadius: 16, marginBottom: 12, boxShadow: "0 4px 16px rgba(var(--shadow-rgb),0.08), inset 0 1px 0 var(--shadow-inset)", border: "1px solid var(--border-card)", overflow: "hidden" }}>
            {/* Header row */}
            <div onClick={() => setSeatingOpen(v => !v)} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px", cursor: "pointer", userSelect: "none" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 18 }}>🎲</span>
                <span style={{ fontWeight: 700, fontSize: 15, color: "var(--text-body)", fontFamily: "'Shippori Mincho',serif" }}>Table Seating</span>
                {seating && <span style={{ fontSize: 11, fontWeight: 700, background: "rgba(var(--primary-rgb),0.12)", color: "var(--primary)", borderRadius: 999, padding: "2px 9px", fontFamily: "'Noto Sans JP',sans-serif" }}>Assigned</span>}

              </div>
              <span style={{ fontSize: 17, color: "var(--primary-faint)", display: "inline-block", transform: seatingOpen ? "rotate(180deg)" : "none", transition: "transform .2s" }}>⌄</span>
            </div>

            {seatingOpen && (
              <div style={{ borderTop: "1px solid rgba(var(--border-light-rgb),0.2)", padding: "12px 14px 16px" }}>
                {/* Host-only controls */}
                {isHost && (
                  <>
                    {movingUid && (
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "rgba(var(--primary-rgb),0.1)", border: "1px solid rgba(var(--primary-rgb),0.22)", borderRadius: 10, padding: "8px 12px", marginBottom: 12 }}>
                        <span style={{ fontSize: 13, fontWeight: 700, color: "var(--primary)", fontFamily: "'Noto Sans JP',sans-serif" }}>
                          Tap a player to swap with {playerLookup[movingUid]?.name || "…"}
                        </span>
                        <button onClick={() => setMovingUid(null)} style={{ background: "none", border: "none", fontSize: 16, color: "var(--primary)", cursor: "pointer", padding: "0 4px" }}>✕</button>
                      </div>
                    )}
                    <button onClick={handleRandomize} disabled={seatingPool.length === 0} style={{ width: "100%", padding: "10px 0", borderRadius: 999, border: "none", background: seatingPool.length === 0 ? "rgba(var(--primary-rgb),0.1)" : "var(--active-tab-gradient)", color: seatingPool.length === 0 ? "var(--text-muted)" : "#fff", fontWeight: 700, fontSize: 14, cursor: seatingPool.length === 0 ? "default" : "pointer", fontFamily: "'Noto Sans JP',sans-serif", marginBottom: 14, boxShadow: seatingPool.length === 0 ? "none" : "0 4px 14px rgba(var(--shadow-rgb),0.28)", letterSpacing: 0.3 }}>
                      🎲 Randomize Tables
                    </button>
                  </>
                )}

                {seatingLoading && <div style={{ fontSize: 13, color: "var(--text-muted)", textAlign: "center", marginBottom: 10, fontFamily: "'Noto Sans JP',sans-serif" }}>Loading player profiles…</div>}

                {/* Table cards */}
                {seating ? seating.map((table, ti) => (
                  <div key={ti} style={{ background: "rgba(255,255,255,0.55)", borderRadius: 12, padding: "10px 12px", marginBottom: 10, border: "1px solid rgba(var(--border-light-rgb),0.3)" }}>
                    <div style={{ fontSize: 12, fontWeight: 800, color: "var(--section-title)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 8, fontFamily: "'Noto Sans JP',sans-serif" }}>
                      Table {ti + 1} · {table.length} players
                    </div>
                    {table.map(pid => {
                      const p = playerLookup[pid];
                      const skill = skillMap[pid];
                      const isMoving = movingUid === pid;
                      const isTarget = isHost && !!movingUid && movingUid !== pid;
                      return (
                        <div key={pid}
                          onClick={isHost ? () => handlePlayerTap(pid) : undefined}
                          style={{ display: "flex", alignItems: "center", gap: 9, padding: "6px 8px", borderRadius: 9, cursor: isHost ? "pointer" : "default", marginBottom: 2, transition: "background .15s, box-shadow .15s", background: isMoving ? "rgba(var(--primary-rgb),0.15)" : isTarget ? "rgba(var(--primary-rgb),0.05)" : "transparent", boxShadow: isMoving ? `0 0 0 2px var(--primary)` : isTarget ? "0 0 0 1px rgba(var(--primary-rgb),0.25)" : "none" }}>
                          <span style={{ fontSize: 21, flexShrink: 0 }}>{p?.avatar || "👤"}</span>
                          <span style={{ flex: 1, fontWeight: 600, fontSize: 14, color: "var(--text-body)", fontFamily: "'Noto Sans JP',sans-serif" }}>{p?.name || pid}</span>
                          {skill && <span style={{ fontSize: 14, flexShrink: 0 }} title={skill}>{SKILL_ICON[skill]}</span>}
                          {isMoving && <span style={{ fontSize: 11, fontWeight: 700, color: "var(--primary)", fontFamily: "'Noto Sans JP',sans-serif" }}>moving</span>}
                          {pid === uid && <span style={{ fontSize: 11, color: "var(--primary)", fontWeight: 700, background: "rgba(var(--primary-rgb),0.1)", borderRadius: 999, padding: "2px 8px", fontFamily: "'Noto Sans JP',sans-serif" }}>You</span>}
                        </div>
                      );
                    })}
                  </div>
                )) : isHost && !seatingLoading && (
                  <div style={{ textAlign: "center", padding: "10px 0 4px", fontSize: 13, color: "var(--text-muted)", fontFamily: "'Noto Sans JP',sans-serif" }}>
                    {seatingPool.length === 0 ? "No confirmed players yet." : "Tap Randomize to generate table assignments."}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Add to Calendar */}
        <AddToCalendar game={game} groupName={group.name} />

        {game.hostId === uid && <Btn full outline danger onClick={() => setConfirmDelete(true)}>🗑 Delete Game</Btn>}
      </div>
    </div>
    {confirmDelete && (
      <ConfirmDialog
        title="Delete Game?"
        message={`"${game.title}" will be permanently deleted and cannot be recovered.`}
        confirmLabel="Delete Game"
        onConfirm={() => { setConfirmDelete(false); onDelete(); }}
        onCancel={() => setConfirmDelete(false)}
      />
    )}
    {confirmReRandomize && (
      <ConfirmDialog
        title="Re-randomize Tables?"
        message="Tables have already been assigned. Randomizing again will overwrite the current seating order."
        confirmLabel="Randomize Again"
        onConfirm={doRandomize}
        onCancel={() => setConfirmReRandomize(false)}
      />
    )}
    {gameChatOpen && (
      <GameChat game={game} group={group} uid={uid} user={user} onClose={() => setGameChatOpen(false)} />
    )}
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

  // Guests: people outside the group
  const [guests, setGuests] = useState(game.guests || []);
  const [guestName, setGuestName] = useState("");
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

    // ── Step 3: Lock in confirmed guests (not currently waitlisted) ─────────
    const newGuests = [];
    guests.forEach((g) => {
      const wasConfirmed = (game.guests || []).some((pg) => pg.id === g.id) && !prevWaitlist.includes(g.id);
      if (wasConfirmed) { newGuests.push(g); filled++; }
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

    onSave({ ...game, title: title.trim(), date: ts, time, endTime, location: loc.trim(), note, seats: totalSeats, rsvps: newRsvps, guests: newGuests, waitlist: newWaitlist, coHostIds: [...coHostIds], joinCode });
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
            fontFamily: "'Noto Sans JP',sans-serif", cursor: "pointer", transition: "all .18s",
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
              <div style={{ fontSize: 12, fontWeight: 700, color: "#b08090", textTransform: "uppercase", letterSpacing: .5, marginBottom: 6, fontFamily: "'Noto Sans JP',sans-serif" }}>Start</div>
              <input type="time" value={time} onChange={(e) => setTime(e.target.value)} style={{ ...inputSt, marginBottom: 0 }} />
            </div>
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#b08090", textTransform: "uppercase", letterSpacing: .5, marginBottom: 6, fontFamily: "'Noto Sans JP',sans-serif" }}>End</div>
              <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} style={{ ...inputSt, marginBottom: 0 }} />
            </div>
          </div>
          <Lbl mt>Location</Lbl>
          <Fld value={loc} set={setLoc} placeholder="e.g. 12 Oak Street" />
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "var(--bg-input)", border: "1.5px solid var(--border-input)", borderRadius: "var(--radius-input)", padding: "10px 14px", marginBottom: 14, marginTop: 10 }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 14, color: "var(--text-body)", fontFamily: "'Noto Sans JP',sans-serif" }}>Tables</div>
              <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 1 }}>{tables * 4} seats total</div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <button onClick={() => setTables((t) => Math.max(1, t - 1))} style={{ width: 32, height: 32, borderRadius: 999, border: `1.5px solid rgba(var(--primary-rgb),0.25)`, background: "var(--bg-card)", fontSize: 18, color: "var(--primary)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700 }}>−</button>
              <span style={{ minWidth: 24, textAlign: "center", fontWeight: 700, fontSize: 16, color: group.color, fontFamily: "'Shippori Mincho',serif" }}>{tables}</span>
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
                <span style={{ fontSize: 12, color: "var(--text-muted)", fontFamily: "'Noto Sans JP',sans-serif" }}>🔒 Fixed</span>
              </div>
              <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 6, fontFamily: "'Noto Sans JP',sans-serif" }}>
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
            <div style={{ fontFamily: "'Shippori Mincho',serif", fontSize: 16, color: "var(--section-title)", fontWeight: 700, marginBottom: 12 }}>Invite Group Members</div>
            {group.members.map((m) => {
              const isIn = invitedIds.has(m.id);
              const isMe = m.id === myUid;
              const isCo = coHostIds.has(m.id);
              return (
                <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                  <div style={{ width: 38, height: 38, borderRadius: 999, background: "var(--avatar-bubble-bg)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 21, flexShrink: 0 }}>{m.avatar}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 15, color: "var(--text-body)" }}>{m.name}</div>
                    {isMe && <div style={{ fontSize: 12, color: "var(--primary)", fontWeight: 700 }}>Host · Always invited</div>}
                    {!isMe && isCo && <div style={{ fontSize: 11, fontWeight: 700, color: "#b8860b", marginTop: 1, fontFamily: "'Noto Sans JP',sans-serif" }}>👑 Co-host</div>}
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
            <div style={{ fontFamily: "'Shippori Mincho',serif", fontSize: 16, color: "var(--section-title)", fontWeight: 700, marginBottom: 4 }}>Guests</div>
            <div style={{ fontSize: 13, color: "#b08090", marginBottom: 12, fontFamily: "'Noto Sans JP',sans-serif" }}>Invite someone outside the group</div>

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

          <Btn full onClick={handleSave}>Save Changes ✨</Btn>

          {/* Transfer Host — only shown when I am currently the host */}
          {game.hostId === myUid && (
            <div style={{ marginTop: 16 }}>
              {!transferring ? (
                <button onClick={() => setTransferring(true)} style={{
                  width: "100%", padding: "11px 0", borderRadius: 12, fontSize: 14, fontWeight: 700,
                  cursor: "pointer", fontFamily: "'Noto Sans JP',sans-serif", border: "1px solid rgba(var(--primary-rgb),0.3)",
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
                  <div style={{ fontFamily: "'Shippori Mincho',serif", fontSize: 16, color: "var(--section-title)", fontWeight: 700, marginBottom: 4 }}>Transfer Host</div>
                  <div style={{ fontSize: 13, color: "#b08090", marginBottom: 14, fontFamily: "'Noto Sans JP',sans-serif", lineHeight: 1.6 }}>
                    Select a new host. They'll take over responsibilities and you can update your own RSVP freely.
                  </div>

                  {/* Eligible members — invited, not me, not already host */}
                  {group.members.filter((m) => m.id !== myUid && invitedIds.has(m.id)).length === 0 ? (
                    <div style={{ fontSize: 14, color: "#c0a0b0", textAlign: "center", padding: "12px 0", fontFamily: "'Noto Sans JP',sans-serif" }}>
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
                          <div style={{ width: 36, height: 36, borderRadius: 999, background: "var(--avatar-bubble-bg)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 21, flexShrink: 0 }}>{m.avatar}</div>
                          <div style={{ flex: 1, fontWeight: 700, fontSize: 15, color: "var(--text-body)" }}>{m.name}</div>
                          {selectedNewHost === m.id && <span style={{ fontSize: 17, color: group.color }}>⭐</span>}
                        </div>
                      ))}
                    </div>
                  )}

                  <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={() => { setTransferring(false); setSelectedNewHost(null); }} style={{
                      flex: 1, padding: "10px 0", borderRadius: 12, fontSize: 14, fontWeight: 700,
                      cursor: "pointer", fontFamily: "'Noto Sans JP',sans-serif",
                      background: "rgba(200,180,190,0.25)", border: "1px solid rgba(var(--primary-rgb),0.2)", color: "#b08090",
                    }}>Cancel</button>
                    <button onClick={() => { if (selectedNewHost) onTransferHost(selectedNewHost); }} disabled={!selectedNewHost} style={{
                      flex: 2, padding: "10px 0", borderRadius: 12, fontSize: 14, fontWeight: 700,
                      cursor: selectedNewHost ? "pointer" : "not-allowed", fontFamily: "'Noto Sans JP',sans-serif", border: "none",
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
  const base = `${window.location.origin}${window.location.pathname}`;
  const joinUrl = game
    ? game.joinCode
      ? `${base}?gameCode=${game.joinCode}`
      : `${base}?joinGroup=${group.code}&game=${game.id}`
    : `${base}?joinGroup=${group.code}`;

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
          ["📧","Email","Opens mail app","var(--primary)","email"],
          ["📋","Copy Message","Paste anywhere","#c4936e","copy"],
          ["📤","Share...","All options","#d4829b","share"],
        ].map(([icon, label, sub, color, method]) => (
          <button key={method} onClick={() => share(method)} style={{ background: "#fff", borderRadius: 16, padding: "15px 10px", cursor: "pointer", boxShadow: "0 3px 14px rgba(0,0,0,.08)", border: `2px solid ${color}33`, textAlign: "center", fontFamily: "'Noto Sans JP',sans-serif", transition: "transform .14s" }}
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
          style={{ marginTop: 16, display: "block", width: "100%", background: `${group.color}15`, border: `1px solid ${group.color}30`, borderRadius: 10, padding: "9px 0", fontSize: 13, color: group.color, fontWeight: 700, cursor: "pointer", fontFamily: "'Noto Sans JP',sans-serif" }}
        >
          Copy link
        </button>
      </div>

      {game && game.joinCode && (
        <div style={{ textAlign: "center", background: "#fff", borderRadius: 14, padding: "14px 16px", boxShadow: "0 2px 10px rgba(0,0,0,.05)", marginBottom: 12 }}>
          <div style={{ fontSize: 12, color: "#bbb", fontWeight: 800, textTransform: "uppercase", letterSpacing: 1 }}>Game Join Code</div>
          <div style={{ fontFamily: "monospace", fontSize: 34, color: group.color, letterSpacing: 6, marginTop: 4, fontWeight: 800 }}>{game.joinCode}</div>
          <div style={{ fontSize: 12, color: "#c0a0ac", marginTop: 4, fontFamily: "'Noto Sans JP',sans-serif" }}>Share this code to invite players directly to this game</div>
        </div>
      )}
      {!game && (
        <div style={{ textAlign: "center", background: "#fff", borderRadius: 14, padding: "14px 16px", boxShadow: "0 2px 10px rgba(0,0,0,.05)" }}>
          <div style={{ fontSize: 12, color: "#bbb", fontWeight: 800, textTransform: "uppercase", letterSpacing: 1 }}>Group Join Code</div>
          <div style={{ fontFamily: "'Shippori Mincho',serif", fontSize: 39, color: group.color, letterSpacing: 8, marginTop: 4 }}>{group.code}</div>
        </div>
      )}
    </Shell>
  );
}

/* SHARED COMPONENTS */
function Shell({ title, onBack, color, children }) {
  return (
    <div style={{ minHeight: "100vh", background: `linear-gradient(170deg,var(--bg-shell-start) 0%,var(--bg-shell-mid) 40%,var(--bg-shell-end) 100%)` }}>
      <div style={{
        background: `linear-gradient(135deg,${color}ee,${color}bb)`,
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
        padding: "50px 22px 22px",
        display: "flex", alignItems: "center", gap: 12,
        boxShadow: `0 8px 32px ${color}44`,
        position: "relative", overflow: "hidden",
      }}>
        <div style={{ position: "absolute", inset: 0, background: "linear-gradient(135deg,rgba(255,255,255,0.15) 0%,transparent 60%)", pointerEvents: "none" }} />
        <button onClick={onBack} style={{ background: "rgba(255,255,255,.28)", border: "1px solid rgba(255,255,255,.4)", borderRadius: 999, width: 36, height: 36, fontSize: 19, color: "#fff", flexShrink: 0, backdropFilter: "blur(8px)" }}>‹</button>
        <h1 style={{ fontFamily: "'Shippori Mincho',serif", fontSize: 24, color: "#fff", textShadow: "0 2px 8px rgba(0,0,0,.2)", position: "relative" }}>{title}</h1>
      </div>
      <div style={{
        padding: "20px 16px",
        background: "rgba(255,240,248,0.65)",
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
    fontFamily: "'Noto Sans JP',sans-serif",
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
    transition: "all .18s", fontFamily: "'Noto Sans JP',sans-serif",
    marginBottom: -1,
  });

  return (
    <div style={hubStyle}>
      <div style={headerStyle}>
        <button onClick={() => go("home")} style={{ background: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 10, padding: "7px 14px", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "'Noto Sans JP',sans-serif" }}>
          ← Back
        </button>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: "'Shippori Mincho',serif", fontSize: 22, fontWeight: 700, color: "#fff" }}>🏛️ Admin Hub</div>
          <div style={{ fontSize: 12, color: "rgba(255,255,255,0.5)", marginTop: 2 }}>Signed in as {adminUser.name}</div>
        </div>
        <div style={{ fontSize: 11, fontWeight: 800, color: "#e8a0d0", background: "rgba(232,160,208,0.15)", borderRadius: 999, padding: "4px 12px", textTransform: "uppercase", letterSpacing: 1 }}>Admin</div>
      </div>

      <div style={{ display: "flex", gap: 0, padding: "0 28px", borderBottom: "1px solid rgba(155,110,168,0.2)", marginTop: 8 }}>
        {[["users","👥 Users"],["logs","📋 Logs"],["subscriptions","💳 Subscriptions"]].map(([key, label]) => (
          <button key={key} style={tabStyle(tab === key)} onClick={() => setTab(key)}>{label}</button>
        ))}
      </div>

      <div style={{ padding: "24px 28px", maxWidth: 960, margin: "0 auto" }}>
        {tab === "users"          && <AdminUsers onImpersonate={onImpersonate} go={go} flash={flash} packages={adminPackages} adminUid={adminUid} />}
        {tab === "logs"           && <AdminLogs />}
        {tab === "subscriptions"  && <AdminSubscriptions flash={flash} packages={adminPackages} adminUid={adminUid} />}
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
  };

  const toggleAdmin = async () => {
    if (!selected) return;
    setPromoting(true);
    try {
      await updateDoc(doc(db, "users", selected.uid), { isAdmin: !selected.isAdmin });
      const patch = { isAdmin: !selected.isAdmin };
      updateLocal(selected.uid, patch);
      setSelected((p) => ({ ...p, ...patch }));
      flash(`${selected.name} is now ${!selected.isAdmin ? "an Admin" : "a Standard user"}`);
    } catch { flash("Failed to update user role"); }
    setPromoting(false);
  };

  const handleDeleteUser = async () => {
    if (!selected) return;
    setConfirmDelete(false);
    setDeleting(true);
    try {
      const fns = getFunctions();
      const deleteFn = httpsCallable(fns, "deleteUser");
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

  const inp = { width: "100%", padding: "9px 13px", borderRadius: 10, fontSize: 14, border: "1.5px solid rgba(155,110,168,0.3)", background: "rgba(255,255,255,0.08)", color: "#fff", fontFamily: "'Noto Sans JP',sans-serif", outline: "none", boxSizing: "border-box" };
  const SecHd = ({ children }) => <div style={{ fontSize: 11, fontWeight: 800, color: "rgba(232,160,208,0.65)", textTransform: "uppercase", letterSpacing: 1.2, marginBottom: 10, fontFamily: "'Noto Sans JP',sans-serif" }}>{children}</div>;

  const planChip = (u) => {
    const key = u.subscription?.plan || "free";
    const pkg = packages.find((p) => (p.planKey || p.id) === key);
    return (
      <span style={{ fontSize: 11, fontWeight: 700, background: "rgba(155,63,160,0.22)", color: "#e8a0d0", borderRadius: 999, padding: "2px 9px", fontFamily: "'Noto Sans JP',sans-serif", letterSpacing: 0.3 }}>
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
          <button onClick={() => setSelected(null)} style={{ background: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 10, padding: "6px 14px", color: "#fff", fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "'Noto Sans JP',sans-serif" }}>← Users</button>
          <div style={{ fontFamily: "'Shippori Mincho',serif", fontSize: 18, color: "#fff", flex: 1 }}>{u.name}</div>
          {u.isAdmin && <span style={{ fontSize: 11, fontWeight: 800, color: "#e8a0d0", background: "rgba(232,160,208,0.18)", borderRadius: 999, padding: "3px 10px", textTransform: "uppercase", letterSpacing: 1 }}>Admin</span>}
        </div>

        {/* Profile card */}
        <div style={{ background: "rgba(255,255,255,0.06)", borderRadius: 16, padding: "18px 20px", marginBottom: 14, border: "1px solid rgba(155,110,168,0.2)" }}>
          <SecHd>Profile</SecHd>
          <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 14 }}>
            <span style={{ fontSize: 40 }}>{u.avatar || "👤"}</span>
            <div>
              <div style={{ fontSize: 17, fontWeight: 700, color: "#fff", fontFamily: "'Shippori Mincho',serif" }}>{u.name}</div>
              <div style={{ fontSize: 13, color: "rgba(255,255,255,0.45)", marginTop: 3 }}>{u.email}</div>
              {u.skillLevel && <div style={{ fontSize: 12, color: "rgba(255,255,255,0.35)", marginTop: 2 }}>{u.skillLevel}</div>}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button onClick={toggleAdmin} disabled={promoting} style={{ padding: "7px 14px", borderRadius: 10, background: u.isAdmin ? "rgba(232,160,208,0.15)" : "rgba(255,255,255,0.1)", border: `1px solid ${u.isAdmin ? "rgba(232,160,208,0.35)" : "rgba(255,255,255,0.2)"}`, color: u.isAdmin ? "#e8a0d0" : "#ccc", fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: "'Noto Sans JP',sans-serif", opacity: promoting ? 0.5 : 1 }}>
              {promoting ? "…" : u.isAdmin ? "Revoke Admin" : "Make Admin"}
            </button>
            <button onClick={() => { onImpersonate(u); go("home"); }} style={{ padding: "7px 14px", borderRadius: 10, background: "linear-gradient(135deg,#5a2d6b,#9b3fa0)", border: "none", color: "#fff", fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: "'Noto Sans JP',sans-serif" }}>
              View as
            </button>
            <button onClick={() => setConfirmDelete(true)} disabled={deleting} style={{ padding: "7px 14px", borderRadius: 10, background: "rgba(220,60,60,0.15)", border: "1px solid rgba(220,60,60,0.35)", color: "#ff8080", fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: "'Noto Sans JP',sans-serif", opacity: deleting ? 0.5 : 1 }}>
              {deleting ? "Deleting…" : "Delete User"}
            </button>
          </div>
        </div>

        {/* Subscription card */}
        <div style={{ background: "rgba(255,255,255,0.06)", borderRadius: 16, padding: "18px 20px", marginBottom: 14, border: "1px solid rgba(155,110,168,0.2)" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
            <SecHd>Subscription</SecHd>
            {!planEdit && (
              <button onClick={() => { setPlanEdit(true); setPlanKey(currentPlanKey); setPlanNote(u.subscription?.overrideNote || ""); }} style={{ background: "linear-gradient(135deg,#5a2d6b,#9b3fa0)", border: "none", borderRadius: 8, padding: "5px 13px", color: "#fff", fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: "'Noto Sans JP',sans-serif" }}>
                Change Plan
              </button>
            )}
          </div>

          {!planEdit ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 14, color: "rgba(255,255,255,0.6)", fontFamily: "'Noto Sans JP',sans-serif" }}>Current Plan</span>
                <span style={{ fontSize: 15, fontWeight: 700, color: "#fff", fontFamily: "'Shippori Mincho',serif" }}>{currentPkg?.name || currentPlanKey}</span>
              </div>
              {currentPkg && currentPkg.price > 0 && (
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: 14, color: "rgba(255,255,255,0.6)", fontFamily: "'Noto Sans JP',sans-serif" }}>Standard Price</span>
                  <span style={{ fontSize: 14, color: "#e8a0d0", fontWeight: 700 }}>${currentPkg.price} / {currentPkg.interval}</span>
                </div>
              )}
              {u.subscription?.overrideNote && (
                <div style={{ background: "rgba(155,63,160,0.15)", borderRadius: 10, padding: "9px 13px", border: "1px solid rgba(155,63,160,0.25)" }}>
                  <div style={{ fontSize: 11, fontWeight: 800, color: "rgba(232,160,208,0.6)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 4, fontFamily: "'Noto Sans JP',sans-serif" }}>Admin Note</div>
                  <div style={{ fontSize: 13, color: "rgba(255,255,255,0.75)", fontFamily: "'Noto Sans JP',sans-serif" }}>{u.subscription.overrideNote}</div>
                </div>
              )}
              {u.subscription?.changedAt && (
                <div style={{ fontSize: 12, color: "rgba(255,255,255,0.3)", fontFamily: "'Noto Sans JP',sans-serif" }}>
                  Last changed {new Date(u.subscription.changedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                </div>
              )}
            </div>
          ) : (
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: "rgba(232,160,208,0.65)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6, fontFamily: "'Noto Sans JP',sans-serif" }}>Plan</div>
              <select value={planKey} onChange={(e) => setPlanKey(e.target.value)} style={{ ...inp, marginBottom: 12 }}>
                <option value="free">Free (default)</option>
                {packages.map((p) => {
                  const key = p.planKey || p.id;
                  if (key === "free") return null;
                  return <option key={p.id} value={key}>{p.name}{p.price > 0 ? ` — $${p.price}/${p.interval}` : ""}</option>;
                })}
              </select>
              <div style={{ fontSize: 12, fontWeight: 700, color: "rgba(232,160,208,0.65)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6, fontFamily: "'Noto Sans JP',sans-serif" }}>Admin Note (optional)</div>
              <input value={planNote} onChange={(e) => setPlanNote(e.target.value)} placeholder="e.g. Comped Pro — contest winner, expires Jun 2026" style={{ ...inp, marginBottom: 14 }} />
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => setPlanEdit(false)} style={{ flex: 1, padding: "9px", borderRadius: 10, background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.2)", color: "#fff", fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "'Noto Sans JP',sans-serif" }}>Cancel</button>
                <button onClick={savePlan} disabled={savingPlan} style={{ flex: 2, padding: "9px", borderRadius: 10, background: "linear-gradient(135deg,#5a2d6b,#9b3fa0)", border: "none", color: "#fff", fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "'Noto Sans JP',sans-serif", opacity: savingPlan ? 0.5 : 1 }}>
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
              <div style={{ fontFamily: "'Shippori Mincho',serif", fontSize: 20, fontWeight: 700, color: "#fff", textAlign: "center", marginBottom: 8 }}>Delete {u.name}?</div>
              <div style={{ fontSize: 13, color: "rgba(255,140,140,0.85)", textAlign: "center", lineHeight: 1.6, marginBottom: 24 }}>This will permanently delete their account and remove them from all groups and games. This cannot be undone.</div>
              <div style={{ display: "flex", gap: 10 }}>
                <button onClick={() => setConfirmDelete(false)} style={{ flex: 1, padding: "12px 0", borderRadius: 12, background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.15)", color: "#fff", fontWeight: 700, fontSize: 14, cursor: "pointer", fontFamily: "'Noto Sans JP',sans-serif" }}>Cancel</button>
                <button onClick={handleDeleteUser} style={{ flex: 1, padding: "12px 0", borderRadius: 12, background: "linear-gradient(135deg,#c0392b,#e74c3c)", border: "none", color: "#fff", fontWeight: 700, fontSize: 14, cursor: "pointer", fontFamily: "'Noto Sans JP',sans-serif" }}>Delete permanently</button>
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
        <div style={{ fontFamily: "'Shippori Mincho',serif", fontSize: 18, color: "#fff" }}>All Users</div>
        <div style={{ fontSize: 13, color: "rgba(255,255,255,0.4)" }}>{users.length} total</div>
      </div>

      <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by name or email…"
        style={{ width: "100%", padding: "11px 16px", borderRadius: 12, fontSize: 14, border: "1.5px solid rgba(155,110,168,0.3)", background: "rgba(255,255,255,0.08)", color: "#fff", fontFamily: "'Noto Sans JP',sans-serif", outline: "none", boxSizing: "border-box", marginBottom: 18 }}
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

/* Logs tab — activity log from Firestore `adminLogs` collection */
function AdminLogs() {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const q = query(collection(db, "adminLogs"), orderBy("ts", "desc"));
    const unsub = onSnapshot(q, (snap) => {
      setLogs(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      setLoading(false);
    }, () => setLoading(false));
    return unsub;
  }, []);

  const fmtTs = (ts) => {
    if (!ts) return "";
    const d = ts.toDate ? ts.toDate() : new Date(ts);
    return d.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  };

  const iconFor = (type) => ({ chat: "💬", game: "🀄", join: "👋", leave: "🚪", rsvp: "✅", admin: "🔐" }[type] || "📝");

  return (
    <div>
      <div style={{ fontFamily: "'Shippori Mincho',serif", fontSize: 18, color: "#fff", marginBottom: 20 }}>Activity Logs</div>
      {loading && <div style={{ color: "rgba(255,255,255,0.4)", fontSize: 14 }}>Loading…</div>}
      {!loading && logs.length === 0 && (
        <div style={{ color: "rgba(255,255,255,0.4)", fontSize: 14 }}>No logs yet. Activity will appear here as users interact with the app.</div>
      )}
      {logs.map((log) => (
        <div key={log.id} style={{ background: "rgba(255,255,255,0.05)", borderRadius: 12, padding: "12px 16px", marginBottom: 8, border: "1px solid rgba(255,255,255,0.08)", display: "flex", gap: 12, alignItems: "flex-start" }}>
          <span style={{ fontSize: 20, flexShrink: 0, marginTop: 1 }}>{iconFor(log.type)}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, color: "#fff", fontWeight: 600 }}>{log.message || log.action}</div>
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
    limitMaxGroups: "2", limitGamesPerCycle: "1", limitCycleDays: "30", limitAllowRecurring: false,
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
    limitMaxGroups:     String(pkg.limits?.maxGroups     ?? "2"),
    limitGamesPerCycle: String(pkg.limits?.gamesPerCycle ?? "1"),
    limitCycleDays:     String(pkg.limits?.cycleDays     ?? "30"),
    limitAllowRecurring: pkg.limits?.allowRecurring ?? false,
  });

  const formToData = (f) => ({
    planKey: f.planKey.trim().toLowerCase().replace(/\s+/g, "_"),
    name: f.name.trim(),
    price: parseFloat(f.price) || 0,
    interval: f.interval,
    description: f.description.trim(),
    features: f.features.split("\n").map((s) => s.trim()).filter(Boolean),
    limits: {
      maxGroups:     parseInt(f.limitMaxGroups, 10)     || 2,
      gamesPerCycle: parseInt(f.limitGamesPerCycle, 10) || 1,
      cycleDays:     parseInt(f.limitCycleDays, 10)     || 30,
      allowRecurring: !!f.limitAllowRecurring,
    },
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

  const inp = { width: "100%", padding: "10px 14px", borderRadius: 10, fontSize: 14, border: "1.5px solid rgba(155,110,168,0.3)", background: "rgba(255,255,255,0.08)", color: "#fff", fontFamily: "'Noto Sans JP',sans-serif", outline: "none", boxSizing: "border-box", marginBottom: 10 };
  const Lbl2 = ({ children }) => <div style={{ fontSize: 11, fontWeight: 800, color: "rgba(232,160,208,0.7)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 5, fontFamily: "'Noto Sans JP',sans-serif" }}>{children}</div>;
  const numInp = (field, label, min = 1) => (
    <div style={{ flex: 1 }}>
      <Lbl2>{label}</Lbl2>
      <input type="number" min={min} value={form[field] ?? ""} onChange={(e) => setForm({ ...form, [field]: e.target.value })} style={{ ...inp, marginBottom: 0 }} />
    </div>
  );

  // ── Edit / New form ──────────────────────────────────────────────────────────
  if (view === "edit" || view === "new") {
    const isNew = view === "new";
    return (
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 22 }}>
          <button onClick={() => setView(isNew ? "list" : "detail")} style={{ background: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 10, padding: "6px 14px", color: "#fff", fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "'Noto Sans JP',sans-serif" }}>← Back</button>
          <div style={{ fontFamily: "'Shippori Mincho',serif", fontSize: 18, color: "#fff" }}>{isNew ? "New Plan" : `Edit — ${selected?.name}`}</div>
        </div>

        <Lbl2>Plan Key (ID)</Lbl2>
        <input value={form.planKey} onChange={(e) => setForm({ ...form, planKey: e.target.value })} placeholder="e.g. free, pro, club" disabled={!isNew} style={{ ...inp, opacity: isNew ? 1 : 0.5 }} />
        {isNew && <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", marginTop: -6, marginBottom: 10, fontFamily: "'Noto Sans JP',sans-serif" }}>Permanent ID used in code. Use lowercase letters only (e.g. "free", "pro").</div>}

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

        <Lbl2>Description</Lbl2>
        <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Short description shown to users" style={inp} />

        <Lbl2>Features (one per line — shown in Account)</Lbl2>
        <textarea value={form.features} onChange={(e) => setForm({ ...form, features: e.target.value })} placeholder={"Group & game chat\nSend group and game invites\nAdd games to calendar"} rows={4} style={{ ...inp, resize: "vertical" }} />

        {/* Limits section */}
        <div style={{ background: "rgba(255,255,255,0.05)", borderRadius: 14, padding: "16px", marginBottom: 10, border: "1px solid rgba(155,110,168,0.25)" }}>
          <div style={{ fontFamily: "'Shippori Mincho',serif", fontSize: 15, color: "#e8a0d0", marginBottom: 14 }}>Plan Limits</div>
          <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
            {numInp("limitMaxGroups", "Max Groups")}
            {numInp("limitGamesPerCycle", "Hosted Games / Cycle")}
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
            <div style={{ fontSize: 14, color: "#fff", fontFamily: "'Noto Sans JP',sans-serif" }}>Allow recurring games</div>
          </div>
        </div>

        <div style={{ display: "flex", gap: 10, marginTop: 6 }}>
          <button onClick={() => setView(isNew ? "list" : "detail")} style={{ flex: 1, padding: "11px", borderRadius: 12, background: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.2)", color: "#fff", fontWeight: 700, fontSize: 14, cursor: "pointer", fontFamily: "'Noto Sans JP',sans-serif" }}>Cancel</button>
          <button onClick={save} disabled={saving || !form.name.trim() || !form.planKey.trim()} style={{ flex: 2, padding: "11px", borderRadius: 12, background: "linear-gradient(135deg,#5a2d6b,#9b3fa0)", border: "none", color: "#fff", fontWeight: 700, fontSize: 14, cursor: "pointer", fontFamily: "'Noto Sans JP',sans-serif", opacity: (saving || !form.name.trim() || !form.planKey.trim()) ? 0.5 : 1 }}>
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
          <button onClick={() => setView("list")} style={{ background: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 10, padding: "6px 14px", color: "#fff", fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "'Noto Sans JP',sans-serif" }}>← Plans</button>
          <div style={{ fontFamily: "'Shippori Mincho',serif", fontSize: 18, color: "#fff", flex: 1 }}>{pkg.name}</div>
          <button onClick={() => openEdit(pkg)} style={{ background: "linear-gradient(135deg,#5a2d6b,#9b3fa0)", border: "none", borderRadius: 10, padding: "7px 16px", color: "#fff", fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "'Noto Sans JP',sans-serif" }}>Edit</button>
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
                <div style={{ fontSize: 11, fontWeight: 800, color: "rgba(232,160,208,0.6)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 3, fontFamily: "'Noto Sans JP',sans-serif" }}>{lbl}</div>
                <div style={{ fontSize: 16, color: "#fff", fontWeight: 700, fontFamily: "'Shippori Mincho',serif" }}>{String(val)}</div>
              </div>
            ))}
          </div>
          {pkg.description && <div style={{ fontSize: 13, color: "rgba(255,255,255,0.55)", fontFamily: "'Noto Sans JP',sans-serif" }}>{pkg.description}</div>}
        </div>

        {/* Limits */}
        <div style={{ background: "rgba(255,255,255,0.06)", borderRadius: 16, padding: "18px 20px", marginBottom: 14, border: "1px solid rgba(155,110,168,0.2)" }}>
          <div style={{ fontFamily: "'Shippori Mincho',serif", fontSize: 15, color: "#e8a0d0", marginBottom: 14 }}>Plan Limits</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            {[
              ["Max Groups", lim.maxGroups ?? FREE_PLAN.maxGroups],
              ["Hosted Games / Cycle", lim.gamesPerCycle ?? FREE_PLAN.gamesPerCycle],
              ["Cycle Duration", `${lim.cycleDays ?? FREE_PLAN.cycleDays} days`],
              ["Recurring Games", lim.allowRecurring ? "✅ Allowed" : "🔒 Locked"],
            ].map(([lbl, val]) => (
              <div key={lbl} style={{ background: "rgba(255,255,255,0.04)", borderRadius: 10, padding: "10px 14px" }}>
                <div style={{ fontSize: 11, fontWeight: 800, color: "rgba(232,160,208,0.6)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 4, fontFamily: "'Noto Sans JP',sans-serif" }}>{lbl}</div>
                <div style={{ fontSize: 18, color: "#fff", fontWeight: 700, fontFamily: "'Shippori Mincho',serif" }}>{String(val)}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Features */}
        {pkg.features?.length > 0 && (
          <div style={{ background: "rgba(255,255,255,0.06)", borderRadius: 16, padding: "18px 20px", marginBottom: 14, border: "1px solid rgba(155,110,168,0.2)" }}>
            <div style={{ fontFamily: "'Shippori Mincho',serif", fontSize: 15, color: "#e8a0d0", marginBottom: 12 }}>Included Features</div>
            {pkg.features.map((f, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 14, color: "rgba(255,255,255,0.8)", fontFamily: "'Noto Sans JP',sans-serif", marginBottom: 7 }}>
                <span style={{ color: "#9b3fa0", fontWeight: 700, fontSize: 16 }}>✓</span> {f}
              </div>
            ))}
          </div>
        )}

        {/* Users on this plan */}
        <div style={{ background: "rgba(255,255,255,0.06)", borderRadius: 16, padding: "18px 20px", marginBottom: 14, border: "1px solid rgba(155,110,168,0.2)" }}>
          <div style={{ fontFamily: "'Shippori Mincho',serif", fontSize: 15, color: "#e8a0d0", marginBottom: 14 }}>
            Users on this plan ({planUsersLoading ? "…" : planUsers.length})
          </div>
          {planUsersLoading && <div style={{ fontSize: 13, color: "rgba(255,255,255,0.35)" }}>Loading…</div>}
          {!planUsersLoading && planUsers.length === 0 && (
            <div style={{ fontSize: 13, color: "rgba(255,255,255,0.35)", fontFamily: "'Noto Sans JP',sans-serif" }}>No users on this plan.</div>
          )}
          {planUsers.map((u) => (
            <div key={u.uid}>
              {changingUser?.uid === u.uid ? (
                // Inline plan-change form
                <div style={{ background: "rgba(155,63,160,0.12)", borderRadius: 12, padding: "12px 14px", marginBottom: 8, border: "1px solid rgba(155,63,160,0.3)" }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#fff", marginBottom: 10, fontFamily: "'Noto Sans JP',sans-serif" }}>
                    Move {u.name} to…
                  </div>
                  <select value={changePlanKey} onChange={(e) => setChangePlanKey(e.target.value)} style={{ width: "100%", padding: "8px 12px", borderRadius: 8, fontSize: 13, border: "1px solid rgba(155,110,168,0.4)", background: "rgba(255,255,255,0.1)", color: "#fff", fontFamily: "'Noto Sans JP',sans-serif", marginBottom: 8, outline: "none" }}>
                    <option value="free">Free (default)</option>
                    {packages.map((p) => {
                      const k = p.planKey || p.id;
                      return <option key={p.id} value={k}>{p.name}{p.price > 0 ? ` — $${p.price}/${p.interval}` : ""}</option>;
                    })}
                  </select>
                  <input value={changePlanNote} onChange={(e) => setChangePlanNote(e.target.value)} placeholder="Admin note (optional)" style={{ width: "100%", padding: "8px 12px", borderRadius: 8, fontSize: 13, border: "1px solid rgba(155,110,168,0.3)", background: "rgba(255,255,255,0.08)", color: "#fff", fontFamily: "'Noto Sans JP',sans-serif", marginBottom: 10, outline: "none", boxSizing: "border-box" }} />
                  <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={() => setChangingUser(null)} style={{ flex: 1, padding: "7px", borderRadius: 8, background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.15)", color: "#fff", fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: "'Noto Sans JP',sans-serif" }}>Cancel</button>
                    <button onClick={applyPlanChange} disabled={savingChange} style={{ flex: 2, padding: "7px", borderRadius: 8, background: "linear-gradient(135deg,#5a2d6b,#9b3fa0)", border: "none", color: "#fff", fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: "'Noto Sans JP',sans-serif", opacity: savingChange ? 0.5 : 1 }}>
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
                  <button onClick={() => { setChangingUser(u); setChangePlanKey(u.subscription?.plan || "free"); setChangePlanNote(u.subscription?.overrideNote || ""); }} style={{ padding: "5px 11px", borderRadius: 8, background: "rgba(155,63,160,0.2)", border: "1px solid rgba(155,63,160,0.35)", color: "#e8a0d0", fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: "'Noto Sans JP',sans-serif", flexShrink: 0 }}>
                    Change Plan
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>

        <button onClick={() => remove(pkg)} style={{ width: "100%", padding: "11px", borderRadius: 12, background: "rgba(200,50,80,0.15)", border: "1px solid rgba(200,50,80,0.3)", color: "#e87070", fontWeight: 700, fontSize: 14, cursor: "pointer", fontFamily: "'Noto Sans JP',sans-serif", marginTop: 4 }}>
          Delete Plan
        </button>
      </div>
    );
  }

  // ── List view ────────────────────────────────────────────────────────────────
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <div style={{ fontFamily: "'Shippori Mincho',serif", fontSize: 18, color: "#fff" }}>Subscription Plans</div>
        <button onClick={openNew} style={{ background: "linear-gradient(135deg,#5a2d6b,#9b3fa0)", border: "none", borderRadius: 10, padding: "8px 16px", color: "#fff", fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "'Noto Sans JP',sans-serif" }}>+ New Plan</button>
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
                  <span style={{ fontFamily: "'Shippori Mincho',serif", fontSize: 18, color: "#fff", fontWeight: 700 }}>{pkg.name}</span>
                  <span style={{ fontSize: 13, color: "#e8a0d0", fontWeight: 700, background: "rgba(155,63,160,0.2)", borderRadius: 999, padding: "2px 10px", fontFamily: "'Noto Sans JP',sans-serif" }}>
                    {planKey}
                  </span>
                  <span style={{ fontSize: 13, color: "rgba(255,255,255,0.5)", fontFamily: "'Noto Sans JP',sans-serif" }}>
                    {pkg.price === 0 ? "Free" : `$${pkg.price}/${pkg.interval}`}
                  </span>
                </div>
                <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 12, color: "rgba(255,255,255,0.45)", fontFamily: "'Noto Sans JP',sans-serif" }}>
                    👥 {lim.maxGroups ?? FREE_PLAN.maxGroups} groups
                  </span>
                  <span style={{ fontSize: 12, color: "rgba(255,255,255,0.45)", fontFamily: "'Noto Sans JP',sans-serif" }}>
                    🀄 {lim.gamesPerCycle ?? FREE_PLAN.gamesPerCycle} game/{lim.cycleDays ?? FREE_PLAN.cycleDays}d
                  </span>
                  <span style={{ fontSize: 12, color: "rgba(255,255,255,0.45)", fontFamily: "'Noto Sans JP',sans-serif" }}>
                    🔁 {lim.allowRecurring ? "Recurring ✓" : "No recurring"}
                  </span>
                  <span style={{ fontSize: 12, color: "#e8a0d0", fontWeight: 700, fontFamily: "'Noto Sans JP',sans-serif" }}>
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
