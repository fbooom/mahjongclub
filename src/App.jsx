import { useState, useEffect, useRef } from "react";
import {
  onAuthStateChanged, createUserWithEmailAndPassword,
  signInWithEmailAndPassword, signInWithPopup, signOut,
} from "firebase/auth";
import {
  collection, doc, setDoc, getDoc, getDocs, updateDoc, deleteDoc,
  onSnapshot, query, where, orderBy, addDoc, serverTimestamp,
  arrayUnion, arrayRemove, runTransaction,
} from "firebase/firestore";
import { auth, db, googleProvider, messagingReady } from "./firebase";
import { getToken, onMessage } from "firebase/messaging";
import { sakura as defaultTheme, themes, buildCSSVars } from "./theme";

// VAPID key — get from Firebase Console → Project Settings → Cloud Messaging → Web Push certificates
const VAPID_KEY = "BKkYCO7TpfkGKyFGFwxP9qv_SqUyey_tLi5yzk5bngZxZ6ZBd3S9IgYSsHwIlRMinuGxmiFK4bQDjwxIPj8M0Bg";

const showBrowserNotif = (title, body, tag) => {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try { new Notification(title, { body, icon: "/favicon.ico", tag }); } catch(e) {}
};

// Silently register/refresh the FCM token for a user and persist it to Firestore.
// Called on sign-in and after the user enables notifications.
async function registerFcmToken(uid) {
  try {
    const messaging = await messagingReady;
    if (!messaging) return;
    if (typeof Notification !== "undefined" && Notification.permission !== "granted") return;
    const token = await getToken(messaging, { vapidKey: VAPID_KEY });
    if (token) {
      await updateDoc(doc(db, "users", uid), {
        notificationsEnabled: true,
        fcmTokens: arrayUnion(token),
      });
    }
  } catch (e) {
    // Non-fatal — FCM unavailable in this browser/context
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
  const [impersonating, setImpersonating] = useState(null); // { uid, name, avatar, email }
  const gamesUnsubs = useRef({});
  const groupMeta = useRef({});
  const guestGameUnsubs = useRef({});
  const guestGroupCache = useRef({});
  const knownGameIds = useRef({}); // { [groupId]: Set<gameId> } — per-group tracking

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
            // Refresh FCM token on every sign-in if notifications are enabled or already permitted
            if (data.notificationsEnabled || (typeof Notification !== "undefined" && Notification.permission === "granted")) {
              registerFcmToken(fbUser.uid);
            }
          } else {
            const profile = { name: fbUser.displayName || fbUser.email.split("@")[0], email: fbUser.email, avatar: randAvatar(), phone: "" };
            await setDoc(doc(db, "users", fbUser.uid), profile);
            setUser({ uid: fbUser.uid, ...profile });
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
  const [pendingJoin] = useState(() => {
    const p = new URLSearchParams(window.location.search);
    const code = p.get("joinGroup"), gameId = p.get("game");
    if (code) window.history.replaceState({}, "", window.location.pathname);
    return { code, gameId };
  });

  useEffect(() => {
    if (!pendingJoin.code || !authUser || !user) return;
    const { code, gameId } = pendingJoin;
    const go_ = (p, g, gm) => { setPage(p); setGid(g || null); setGmid(gm || null); };
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

  const go = (p, g, gm) => { setPage(p); if (g !== undefined) setGid(g); if (gm !== undefined) setGmid(gm || null); };
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

  const NAV_ITEMS = [
    { id: "home",    icon: "🀄", label: "Home"    },
    { id: "account", icon: "👤", label: "Account" },
  ];

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

      {/* Page content */}
      <div style={{ flex: 1, overflowY: "auto", WebkitOverflowScrolling: "touch", paddingBottom: 16, paddingTop: impersonating ? 52 : 0 }}>
        {page === "home" && <Home groups={groups} guestGames={guestGames} go={go} user={displayUser} activeTheme={activeTheme} />}
        {page === "account" && <Account uid={uid} user={displayUser} setUser={setUser} groups={groups} guestGames={guestGames} flash={flash} go={go} onSignOut={handleSignOut} isAdmin={!!user?.isAdmin} onImpersonate={startImpersonating} isImpersonating={!!impersonating} activeThemeId={activeTheme.id} onThemeChange={handleThemeChange} />}
        {page === "newGroup" && (
          <NewGroup onBack={() => go("home")}
            onSave={async (g) => {
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
                go("home"); flash("Left group");
              } catch { flash("Error leaving group", "❌"); }
            }} />
        )}
        {page === "newGame" && group && (
          <NewGame uid={uid} user={user} group={group} onBack={() => go("group", group.id)}
            onSave={async (games) => {
              try {
                const arr = Array.isArray(games) ? games : [games];
                await Promise.all(arr.map((gm) => setDoc(doc(db, "groups", group.id, "games", gm.id), gm)));
                if (arr.length === 1) { go("game", group.id, arr[0].id); flash("Game scheduled!", "🀄"); }
                else { go("group", group.id); flash(`${arr.length} games scheduled! 🀄`); }
              } catch { flash("Error scheduling game", "❌"); }
            }} />
        )}
        {page === "game" && game && group && (
          <Game uid={uid} game={game} group={group} go={go}
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
                await deleteDoc(doc(db, "groups", group.id, "games", game.id));
                go("group", group.id); flash("Deleted");
              } catch { flash("Error deleting game", "❌"); }
            }} />
        )}
        {page === "editGame" && game && group && (
          <EditGame uid={uid} game={game} group={group} onBack={() => go("game", group.id, game.id)}
            onSave={async (updated) => {
              try {
                const { id: gameId, ...data } = updated;
                await updateDoc(doc(db, "groups", group.id, "games", gameId), data);
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
          const active = item.id === "account" ? page === "account" : page !== "account";
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

        <p style={{ fontSize: 12, color: "#c0a0b0", marginTop: 14, fontFamily: "'Noto Sans JP',sans-serif" }}>
          Tap anywhere outside to dismiss
        </p>
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
      await signInWithEmailAndPassword(auth, email.trim(), password);
      // onAuthStateChanged in App handles the rest
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
      // onAuthStateChanged in App handles the rest
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
      await signInWithPopup(auth, googleProvider);
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
      background: "var(--header-gradient-2)",
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
function Account({ uid, user, setUser, groups, guestGames, flash, go, onSignOut, isAdmin, onImpersonate, isImpersonating, activeThemeId, onThemeChange }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email);
  const [notifEnabled, setNotifEnabled] = useState(
    user.notificationsEnabled === true ||
    (typeof Notification !== "undefined" && Notification.permission === "granted")
  );
  const AVATARS = [
    "🐼","🌸","🦋","🍀","🌹","🦚","🎋","🌿","🦩","🌺","🎍","🐝",
    "🦊","🐱","🐰","🦁","🐨","🦄","🐸","🦜","🌙","⭐","🌊","🍵",
    "🎀","🍄","🌻","🪷","🦢","🐞","🍒","🫧","🌈","🪸","🫶","🎐",
  ];
  const [avatar, setAvatar] = useState(user.avatar);

  const save = async () => {
    const newName = name.trim() || user.name;
    try {
      await updateDoc(doc(db, "users", uid), { name: newName, avatar });
      setUser({ ...user, name: newName, avatar });
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
        // Save preference anyway so FCM can still deliver via service worker
        await updateDoc(doc(db, "users", uid), { notificationsEnabled: true });
        setNotifEnabled(true);
        // Show platform-specific guidance
        if (isIOS) {
          flash("On iPhone, add app to Home Screen first", "📱");
        } else {
          flash("Open in Chrome or Firefox to enable notifications", "🌐");
        }
        return;
      }
      const perm = await Notification.requestPermission();
      if (perm === "denied") { flash("Notifications blocked — check browser settings", "🔕"); return; }
      await registerFcmToken(uid);
      setNotifEnabled(true);
      flash("Notifications enabled!", "🔔");
    } else {
      await updateDoc(doc(db, "users", uid), { notificationsEnabled: false });
      setNotifEnabled(false);
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
            </div>
          )}
        </div>

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
  const [showAll, setShowAll] = useState(false);

  // Flatten all member games across all groups, then merge in guest games
  const memberGames = groups.flatMap((g) =>
    g.games.map((gm) => ({ ...gm, groupName: g.name, groupColor: g.color, groupId: g.id, groupEmoji: g.emoji }))
  );
  const allGames = [...memberGames, ...guestGames];
  const upcoming = allGames.filter((gm) => gm.date > NOW).sort((a, b) => a.date !== b.date ? a.date - b.date : (a.time || "").localeCompare(b.time || ""));
  const history = allGames.filter((gm) => gm.date <= NOW).sort((a, b) => a.date !== b.date ? b.date - a.date : (b.time || "").localeCompare(a.time || ""));
  const fullList = tab === "upcoming" ? upcoming : history;
  const list = showAll ? fullList : fullList.slice(0, 3);

  return (
    <div style={{ marginTop: 4 }}>
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
                {/* Group tag + optional guest badge */}
                <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 6 }}>
                  <span style={{ fontSize: 14 }}>{gm.groupEmoji}</span>
                  <span style={{ fontSize: 12, fontWeight: 700, color: gm.groupColor, fontFamily: "'Noto Sans JP',sans-serif" }}>{gm.groupName}</span>
                  {gm.isGuestGame && <span style={{ fontSize: 11, fontWeight: 800, color: "var(--secondary-accent)", background: "rgba(155,110,168,0.12)", borderRadius: 999, padding: "1px 7px", marginLeft: 2 }}>Guest</span>}
                </div>
                <div style={{ fontWeight: 700, fontSize: 15, color: "var(--text-body)", fontFamily: "'Shippori Mincho',serif" }}>{gm.title}</div>
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
            <button onClick={() => setShowAll(v => !v)} style={{
              width: "100%", padding: "10px 0", background: "none", border: "1px dashed rgba(var(--primary-rgb),0.3)",
              borderRadius: 12, color: "var(--primary)", fontSize: 14, fontWeight: 700,
              fontFamily: "'Noto Sans JP',sans-serif", cursor: "pointer", marginTop: 2,
            }}>
              {showAll ? "See less ↑" : `See ${fullList.length - 3} more ↓`}
            </button>
          )}
        </>
      )}
    </div>
  );
}

/* HOME */
function Home({ groups, guestGames, go, user, activeTheme }) {
  const [showAllGroups, setShowAllGroups] = useState(false);

  // SVG mahjong tile pattern — color adapts to active theme's primary
  const tileColor = encodeURIComponent(activeTheme?.primary || "#a0456e");
  const bgSVG = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Crect width='120' height='120' fill='none'/%3E%3Cg opacity='0.07' fill='${tileColor}'%3E%3Crect x='10' y='10' width='28' height='38' rx='5' fill='none' stroke='${tileColor}' stroke-width='2'/%3E%3Crect x='14' y='16' width='20' height='4' rx='2'/%3E%3Crect x='14' y='23' width='20' height='4' rx='2'/%3E%3Crect x='14' y='30' width='20' height='4' rx='2'/%3E%3Crect x='64' y='10' width='28' height='38' rx='5' fill='none' stroke='${tileColor}' stroke-width='2'/%3E%3Ccircle cx='78' cy='24' r='5' fill='none' stroke='${tileColor}' stroke-width='2'/%3E%3Ccircle cx='78' cy='37' r='3'/%3E%3Crect x='10' y='68' width='28' height='38' rx='5' fill='none' stroke='${tileColor}' stroke-width='2'/%3E%3Cpath d='M18 78 Q24 72 30 78 Q24 84 18 78Z'/%3E%3Cpath d='M18 90 Q24 84 30 90 Q24 96 18 90Z'/%3E%3Crect x='64' y='68' width='28' height='38' rx='5' fill='none' stroke='${tileColor}' stroke-width='2'/%3E%3Crect x='70' y='75' width='16' height='18' rx='3' fill='none' stroke='${tileColor}' stroke-width='1.5'/%3E%3Cline x1='78' y1='75' x2='78' y2='93' stroke='${tileColor}' stroke-width='1.5'/%3E%3C/g%3E%3C/svg%3E")`;

  const BT = ["🀄","🀇","🀅","🀙","🀃","🀆"];
  const pos = [
    { top: "8%", left: "4%", a: "f0" }, { top: "10%", right: "6%", a: "f1" },
    { top: "32%", left: "1%", a: "f2" }, { top: "30%", right: "2%", a: "f0" },
    { top: "50%", left: "6%", a: "f1" }, { top: "48%", right: "5%", a: "f2" },
  ];

  return (
    <div style={{ minHeight: "100vh", background: `${bgSVG}, linear-gradient(170deg,var(--bg-shell-start) 0%,var(--bg-shell-mid) 40%,var(--bg-shell-end) 100%)`, backgroundSize: "120px 120px, cover" }}>
      {/* Hero header — glassy */}
      <div style={{
        background: "var(--header-gradient-2)",
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

      {/* Content panel — glassy frosted */}
      <div style={{
        background: "var(--bg-card-base)",
        backdropFilter: "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
        borderRadius: "28px 28px 0 0",
        marginTop: -18,
        padding: "26px 16px 40px",
        minHeight: "68vh",
        border: "1px solid var(--border-card)",
        borderBottom: "none",
        boxShadow: "0 -4px 24px rgba(var(--shadow-rgb),0.08)",
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <h2 style={{ fontFamily: "'Shippori Mincho',serif", fontSize: 23, color: "var(--section-title)", letterSpacing: 0.5 }}>Your Groups</h2>
          <div style={{ display: "flex", gap: 8 }}>
            <Btn sm outline onClick={() => go("joinGroup")}>Join</Btn>
            <Btn sm onClick={() => go("newGroup")}>+ New</Btn>
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
            {(showAllGroups ? groups : groups.slice(0, 3)).map((g, i) => (
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
                    <div style={{ fontSize: 13, color: "#b08090", marginTop: 2 }}>{g.members.length} members · Code: <b style={{ color: g.color }}>{g.code}</b></div>
                  </div>
                  {g.games.filter((gm) => gm.date > NOW).length > 0 && (
                    <div style={{ background: `linear-gradient(135deg,${g.color},${g.color}cc)`, color: "#fff", borderRadius: 999, width: 26, height: 26, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 900, boxShadow: `0 2px 8px ${g.color}55` }}>{g.games.filter((gm) => gm.date > NOW).length}</div>
                  )}
                  <span style={{ color: "var(--primary-faint)", fontSize: 21 }}>›</span>
                </div>
              </div>
            ))}
            {groups.length > 3 && (
              <button onClick={() => setShowAllGroups(v => !v)} style={{
                width: "100%", padding: "10px 0", background: "none", border: "1px dashed rgba(var(--primary-rgb),0.3)",
                borderRadius: 12, color: "var(--primary)", fontSize: 14, fontWeight: 700,
                fontFamily: "'Noto Sans JP',sans-serif", cursor: "pointer", marginBottom: 16,
              }}>
                {showAllGroups ? "See less ↑" : `See ${groups.length - 3} more ↓`}
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
function JoinGroup({ uid, groups, onBack, onJoin }) {
  const [code, setCode] = useState("");
  const [match, setMatch] = useState(null);
  const [searching, setSearching] = useState(false);
  const clean = code.trim().toUpperCase();
  const alreadyIn = match && (match.memberIds || []).includes(uid);

  useEffect(() => {
    setMatch(null);
    if (clean.length < 4) return;
    setSearching(true);
    getDocs(query(collection(db, "groups"), where("code", "==", clean)))
      .then((snap) => { setMatch(snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data(), games: [] }); })
      .catch(() => setMatch(null))
      .finally(() => setSearching(false));
  }, [clean]);

  return (
    <Shell title="Join a Group" onBack={onBack} color="var(--secondary-accent)">
      <div style={{ textAlign: "center", fontSize: 53, margin: "8px 0 20px" }}>🔑</div>
      <Lbl>Enter Group Code</Lbl>
      <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="e.g. TUE42"
        style={{ width: "100%", padding: "14px 16px", background: "#fff", borderRadius: 14, fontSize: 23, fontWeight: 900, textAlign: "center", letterSpacing: 6, textTransform: "uppercase", marginBottom: 14, border: "2px solid var(--border-input)", color: "var(--text-body)" }} />
      {searching && <p style={{ color: "var(--secondary-accent)", fontWeight: 700, fontSize: 15, marginBottom: 14, textAlign: "center" }}>Searching…</p>}
      {!searching && clean.length >= 4 && !match && <p style={{ color: "var(--primary)", fontWeight: 800, fontSize: 15, marginBottom: 14 }}>No group found with that code</p>}
      {match && !alreadyIn && (
        <div className="bIn" style={{ background: "#fdf0f7", border: "2px solid var(--primary-faint)33", borderRadius: 16, padding: "14px 18px", marginBottom: 18 }}>
          <div style={{ fontSize: 29 }}>{match.emoji}</div>
          <div style={{ fontWeight: 800, fontSize: 18, color: "var(--text-body)" }}>{match.name}</div>
          <div style={{ fontSize: 14, color: "#b08090" }}>{(match.members || []).length} members</div>
        </div>
      )}
      {alreadyIn && <p style={{ color: "var(--secondary-accent)", fontWeight: 800, fontSize: 15, marginBottom: 14 }}>You're already in this group!</p>}
      <Btn full disabled={!match || !!alreadyIn} onClick={() => onJoin(match.id)}>Join Group</Btn>
    </Shell>
  );
}

/* GROUP DETAIL */
function Group({ uid, group, go, flash, onLeave }) {
  const [tab, setTab] = useState("games");
  const [gamesTab, setGamesTab] = useState("upcoming");
  const [chatOpen, setChatOpen] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const upcoming = group.games.filter((g) => g.date > NOW).sort((a, b) => a.date !== b.date ? a.date - b.date : (a.time || "").localeCompare(b.time || ""));
  const past = group.games.filter((g) => g.date <= NOW).sort((a, b) => a.date !== b.date ? b.date - a.date : (b.time || "").localeCompare(a.time || ""));
  const gamesList = gamesTab === "upcoming" ? upcoming : past;
  const isCreator = group.members.some((m) => m.id === uid && m.host);
  const canInvite = isCreator || (group.openInvites ?? false);
  return (
    <div style={{ minHeight: "100vh", background: `linear-gradient(170deg,var(--bg-shell-start) 0%,var(--bg-shell-mid) 40%,var(--bg-shell-end) 100%)` }}>
      <div style={{
        background: `linear-gradient(135deg,${group.color}f0,${group.color}bb)`,
        backdropFilter: "blur(14px)", WebkitBackdropFilter: "blur(14px)",
        padding: "50px 22px 26px", position: "relative", overflow: "hidden",
        boxShadow: `0 8px 32px ${group.color}44`,
      }}>
        <div style={{ position: "absolute", inset: 0, background: "linear-gradient(135deg,rgba(255,255,255,0.18) 0%,transparent 55%)", pointerEvents: "none" }} />
        <button onClick={() => go("home")} style={{ position: "absolute", top: 14, left: 14, background: "rgba(255,255,255,.28)", border: "1px solid rgba(255,255,255,.4)", borderRadius: 999, width: 36, height: 36, fontSize: 19, color: "#fff", backdropFilter: "blur(8px)" }}>‹</button>
        <div style={{ position: "absolute", top: 14, right: 14, display: "flex", gap: 8 }}>
          {isCreator && <button onClick={() => go("editGroup", group.id)} style={{ background: "rgba(255,255,255,.22)", border: "1px solid rgba(255,255,255,.35)", borderRadius: 999, padding: "7px 14px", fontSize: 13, fontWeight: 700, color: "#fff", fontFamily: "'Noto Sans JP',sans-serif", backdropFilter: "blur(8px)", cursor: "pointer" }}>✏️ Edit</button>}
          {canInvite && <button onClick={() => go("invite", group.id)} style={{ background: "rgba(255,255,255,.22)", border: "1px solid rgba(255,255,255,.35)", borderRadius: 999, padding: "7px 14px", fontSize: 13, fontWeight: 700, color: "#fff", fontFamily: "'Noto Sans JP',sans-serif", backdropFilter: "blur(8px)", cursor: "pointer" }}>✉️ Invite</button>}
        </div>
        <div style={{ textAlign: "center", position: "relative" }}>
          <div style={{ fontSize: 51, marginBottom: 6 }}>{group.emoji}</div>
          <h1 style={{ fontFamily: "'Shippori Mincho',serif", fontSize: 27, color: "#fff", textShadow: "0 2px 10px rgba(0,0,0,.25)", letterSpacing: 1 }}>{group.name}</h1>
          <div style={{ marginTop: 12 }}>
            <button onClick={() => setChatOpen(true)} style={{
              background: "rgba(255,255,255,.22)", border: "1px solid rgba(255,255,255,.45)",
              borderRadius: 999, padding: "7px 20px", fontSize: 14, fontWeight: 700,
              color: "#fff", cursor: "pointer", backdropFilter: "blur(8px)",
              fontFamily: "'Noto Sans JP',sans-serif", display: "inline-flex",
              alignItems: "center", gap: 7, transition: "transform .15s",
            }}
              onMouseDown={(e) => e.currentTarget.style.transform = "scale(.94)"}
              onMouseUp={(e) => e.currentTarget.style.transform = "scale(1)"}
              onTouchStart={(e) => e.currentTarget.style.transform = "scale(.94)"}
              onTouchEnd={(e) => e.currentTarget.style.transform = "scale(1)"}
            >💬 Group Chat</button>
          </div>
        </div>
      </div>

      <div style={{ display: "flex", background: "rgba(255,240,248,0.75)", backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)", borderBottom: "1px solid rgba(var(--border-light-rgb),.4)" }}>
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
            <div style={{ marginTop: 18 }}>
              <Btn full outline danger onClick={() => setConfirmLeave(true)}>Leave Group</Btn>
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
    if (typeof Notification === "undefined") return;
    const perm = await Notification.requestPermission();
    setNotifBanner(false);
    if (perm === "granted") {
      await updateDoc(doc(db, "users", uid), { notificationsEnabled: true });
    }
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
                        borderRadius: 999, width: 28, height: 28, fontSize: 16,
                        cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center",
                        transition: "all .13s",
                      }}
                    >😊</button>
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
      <div style={{ fontWeight: 700, fontSize: 16, color: "var(--text-body)", fontFamily: "'Shippori Mincho',serif" }}>{game.title}</div>
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
function NewGame({ uid: myUid, user: myUser, group, onBack, onSave }) {
  const [title, setTitle] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("19:00");
  const [endTime, setEndTime] = useState("22:00");
  const [loc, setLoc] = useState("");
  const [note, setNote] = useState("");
  const [seats, setSeats] = useState(4);
  const [recurring, setRecurring] = useState(false);
  const [freq, setFreq] = useState("weekly");
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

  const ok = title.trim() && date && time && loc.trim();

  const handleSave = () => {
    if (!ok) return;
    if (!recurring) {
      const ts = new Date(`${date}T${time}`).getTime();
      onSave({ id: "gm" + uid(), title: title.trim(), host: myUser.name, hostId: myUid, date: ts, time, endTime, location: loc.trim(), seats, rsvps: { [myUid]: "yes" }, note, waitlist: [] });
    } else {
      const dates = previewDates();
      const games = dates.map((ts) => ({
        id: "gm" + uid(),
        title: title.trim(),
        host: myUser.name, hostId: myUid,
        date: ts, time, endTime,
        location: loc.trim(),
        seats, rsvps: { [myUid]: "yes" },
        note,
        waitlist: [],
        recurring: freq,
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
      <Lbl mt>Seats</Lbl>
      <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
        {[4, 8, 12, 16].map((n) => (
          <div key={n} onClick={() => setSeats(n)} style={{
            flex: 1, height: 46, borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "center",
            cursor: "pointer", fontWeight: 700, fontSize: 16, transition: "all .18s",
            fontFamily: "'Noto Sans JP',sans-serif",
            background: seats === n ? `linear-gradient(135deg,${group.color},${group.color}cc)` : "var(--border-card)",
            color: seats === n ? "#fff" : "#7a4a58",
            border: seats === n ? "none" : "1px solid rgba(var(--primary-rgb),0.2)",
            boxShadow: seats === n ? `0 4px 12px ${group.color}44` : "none",
          }}>{n}</div>
        ))}
      </div>
      <Lbl mt>Host Notes (optional)</Lbl>
      <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Style of play, what to bring, house rules..." rows={3} style={{ ...inputSt, resize: "none", height: "auto", padding: "12px 14px" }} />

      {/* Recurring toggle */}
      <div style={{ height: 10 }} />
      <div style={{
        background: "linear-gradient(135deg,var(--bg-card),var(--bg-card-alt))",
        backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)",
        borderRadius: 16, padding: "16px", marginBottom: 16,
        border: "1px solid rgba(var(--border-light-rgb),0.4)",
        boxShadow: "0 4px 16px rgba(var(--shadow-rgb),0.07), inset 0 1px 0 var(--shadow-inset)",
      }}>
        {/* Toggle row */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 15, color: "var(--text-body)", fontFamily: "'Shippori Mincho',serif" }}>🔁 Recurring Game</div>
            <div style={{ fontSize: 13, color: "#b08090", marginTop: 2, fontFamily: "'Noto Sans JP',sans-serif" }}>Automatically schedule repeating sessions</div>
          </div>
          {/* Toggle switch */}
          <div onClick={() => setRecurring(!recurring)} style={{
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

/* GAME DETAIL */
function Game({ uid, game, group, go, onRsvp, onWaitlist, onDelete, isGuestView = false }) {
  const [showAttendees, setShowAttendees] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isCreator = !isGuestView && group.members.some((m) => m.id === uid && m.host);
  const canInvite = !isGuestView && (isCreator || (group.openInvites ?? false));
  const myRsvp = game.rsvps[uid] || "pending";
  // Member RSVPs only (guests tracked separately)
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

  // Build a single unified waitlist display list with name + avatar for everyone
  const unifiedWaitlist = rawWaitlist.map((id) => {
    // Is it a guest?
    const guest = allGuests.find((g) => g.id === id);
    if (guest) return { id, name: guest.name, avatar: guest.avatar, isGuest: true };
    // Is it a group member?
    const member = group.members.find((m) => m.id === id);
    if (member) return { id, name: member.name, avatar: member.avatar, isGuest: false };
    return { id, name: "Unknown", avatar: "👤", isGuest: false };
  });
  return (
    <>
    <div style={{ minHeight: "100vh", background: `linear-gradient(170deg,var(--bg-shell-start) 0%,var(--bg-shell-mid) 40%,var(--bg-shell-end) 100%)` }}>
      <div style={{ background: `linear-gradient(135deg,${group.color},${group.color}aa)`, padding: "50px 22px 28px", position: "relative" }}>
        <button onClick={() => isGuestView ? go("home") : go("group", group.id)} style={{ position: "absolute", top: 14, left: 14, background: "rgba(255,255,255,.25)", border: "none", borderRadius: 999, width: 36, height: 36, fontSize: 19, color: "#fff" }}>‹</button>
        {!isGuestView && game.hostId === uid && (
          <button onClick={() => go("editGame", group.id, game.id)} style={{ position: "absolute", top: 14, right: 14, background: "rgba(255,255,255,.22)", border: "1px solid rgba(255,255,255,.35)", borderRadius: 999, padding: "7px 14px", fontSize: 13, fontWeight: 700, color: "#fff", fontFamily: "'Noto Sans JP',sans-serif", backdropFilter: "blur(8px)", cursor: "pointer" }}>✏️ Edit</button>
        )}
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 14, fontWeight: 800, color: "rgba(255,255,255,.65)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>{group.name}</div>
          <h1 style={{ fontFamily: "'Shippori Mincho',serif", fontSize: 25, color: "#fff", textShadow: "0 2px 10px rgba(0,0,0,.2)" }}>{game.title}</h1>
        </div>
      </div>
      <div style={{ padding: "18px 16px 100px" }}>
        <IRow icon="📅" label="Date" val={fmt(game.date)} />
        <IRow icon="🕐" label="Time" val={fmtRange(game.time, game.endTime)} />
        <IRow icon="📍" label="Location" val={game.location} />
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

        {/* Add to Calendar */}
        <AddToCalendar game={game} groupName={group.name} />

        {/* RSVPs card */}
        {(() => {
          // Build named lists for each status
          const resolveName = (id) => {
            const m = group.members.find((m) => m.id === id);
            if (m) return { name: m.name, avatar: m.avatar };
            const g = allGuests.find((g) => g.id === id);
            if (g) return { name: g.name, avatar: g.avatar, isGuest: true };
            return { name: "Unknown", avatar: "👤" };
          };
          const goingList = Object.entries(game.rsvps).filter(([, v]) => v === "yes").map(([id]) => ({ id, ...resolveName(id) }));
          const maybeList = Object.entries(game.rsvps).filter(([, v]) => v === "maybe").map(([id]) => ({ id, ...resolveName(id) }));
          const noList    = Object.entries(game.rsvps).filter(([, v]) => v === "no").map(([id]) => ({ id, ...resolveName(id) }));

          const AttendeeRow = ({ entry }) => (
            <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "5px 0" }}>
              <span style={{ fontSize: 19 }}>{entry.avatar}</span>
              <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text-body)", flex: 1, fontFamily: "'Noto Sans JP',sans-serif" }}>{entry.name}</span>
              {entry.isGuest && <span style={{ fontSize: 11, color: "var(--secondary-accent)", fontWeight: 700, background: "rgba(155,110,168,0.1)", borderRadius: 999, padding: "2px 8px" }}>Guest</span>}
              {entry.id === uid && <span style={{ fontSize: 11, color: "var(--primary)", fontWeight: 700, background: "rgba(var(--primary-rgb),0.1)", borderRadius: 999, padding: "2px 8px" }}>You</span>}
            </div>
          );

          return (
            <div style={{ background: "linear-gradient(135deg,var(--bg-card),var(--bg-card-alt))", backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)", borderRadius: 16, marginBottom: 12, boxShadow: "0 4px 16px rgba(var(--shadow-rgb),0.08), inset 0 1px 0 var(--shadow-inset)", border: "1px solid var(--border-card)", overflow: "hidden" }}>
              {/* Tappable header */}
              <div onClick={() => setShowAttendees((v) => !v)} style={{ padding: "15px 16px", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div style={{ fontWeight: 700, color: "var(--text-body)", fontFamily: "'Shippori Mincho',serif" }}>RSVPs</div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ display: "flex", gap: 6 }}>
                    <Chip big color="var(--secondary-accent)">✅ {yes}</Chip>
                    <Chip big color="#c4936e">🤔 {maybe}</Chip>
                    <Chip big color="var(--primary)">❌ {no}</Chip>
                  </div>
                  <span style={{ fontSize: 17, color: "var(--primary-faint)", transition: "transform .2s", display: "inline-block", transform: showAttendees ? "rotate(180deg)" : "rotate(0deg)" }}>⌄</span>
                </div>
              </div>

              {/* Expanded attendee list */}
              {showAttendees && (
                <div style={{ borderTop: "1px solid rgba(212,165,201,0.25)", padding: "10px 16px 14px" }}>
                  {[
                    { label: "✅ Going", list: goingList, color: "#9b6ea8" },
                    { label: "🤔 Maybe", list: maybeList, color: "#c4936e" },
                    { label: "❌ Can't Go", list: noList, color: "#c9607a" },
                  ].map(({ label, list, color }) => list.length > 0 && (
                    <div key={label} style={{ marginBottom: 12 }}>
                      <div style={{ fontSize: 12, fontWeight: 800, color, textTransform: "uppercase", letterSpacing: .5, marginBottom: 4, fontFamily: "'Noto Sans JP',sans-serif" }}>{label} · {list.length}</div>
                      {list.map((entry) => <AttendeeRow key={entry.id} entry={entry} />)}
                    </div>
                  ))}

                  {/* Confirmed guests */}
                  {confirmedGuests.length > 0 && (
                    <div style={{ marginTop: 4, paddingTop: 10, borderTop: "1px solid rgba(212,165,201,0.15)" }}>
                      <div style={{ fontSize: 12, fontWeight: 800, color: "var(--secondary-accent)", textTransform: "uppercase", letterSpacing: .5, marginBottom: 4, fontFamily: "'Noto Sans JP',sans-serif" }}>Guests · {confirmedGuests.length}</div>
                      {confirmedGuests.map((g) => <AttendeeRow key={g.id} entry={{ ...g, isGuest: true }} />)}
                    </div>
                  )}

                  {/* Waitlist */}
                  {unifiedWaitlist.length > 0 && (
                    <div style={{ marginTop: 4, paddingTop: 10, borderTop: "1px solid rgba(212,165,201,0.15)" }}>
                      <div style={{ fontSize: 12, fontWeight: 800, color: "var(--primary)", textTransform: "uppercase", letterSpacing: .5, marginBottom: 4, fontFamily: "'Noto Sans JP',sans-serif" }}>⏳ Waitlist · {unifiedWaitlist.length}</div>
                      {unifiedWaitlist.map((entry, i) => (
                        <div key={entry.id} style={{ display: "flex", alignItems: "center", gap: 9, padding: "5px 0" }}>
                          <div style={{ width: 20, height: 20, borderRadius: 999, background: "rgba(var(--primary-rgb),0.15)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: "var(--primary)", flexShrink: 0 }}>{i + 1}</div>
                          <span style={{ fontSize: 19 }}>{entry.avatar}</span>
                          <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text-body)", flex: 1, fontFamily: "'Noto Sans JP',sans-serif" }}>{entry.name}</span>
                          {entry.isGuest && <span style={{ fontSize: 11, color: "var(--secondary-accent)", fontWeight: 700, background: "rgba(155,110,168,0.1)", borderRadius: 999, padding: "2px 8px" }}>Guest</span>}
                          {entry.id === uid && <span style={{ fontSize: 11, color: "var(--primary)", fontWeight: 700, background: "rgba(var(--primary-rgb),0.1)", borderRadius: 999, padding: "2px 8px" }}>You</span>}
                        </div>
                      ))}
                    </div>
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

            {/* Host cannot change their own RSVP */}
            {game.hostId === uid ? (
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderRadius: 12, background: "linear-gradient(135deg,rgba(155,110,168,0.15),rgba(var(--primary-rgb),0.1))", border: "1px solid rgba(155,110,168,0.25)", marginBottom: 10 }}>
                  <span style={{ fontSize: 19 }}>⭐</span>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 14, color: "var(--text-body)", fontFamily: "'Noto Sans JP',sans-serif" }}>You're the host — you're always going!</div>
                    <div style={{ fontSize: 12, color: "#b08090", marginTop: 2, fontFamily: "'Noto Sans JP',sans-serif" }}>To step down, transfer host in Edit → Players</div>
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

        <Btn full onClick={() => go("invite", group.id, game.id)} style={{ marginBottom: 10 }}>✉️ Invite Players</Btn>
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
  const [seats, setSeats] = useState(() => {
    const s = game.seats || 4;
    const valid = [4, 8, 12, 16];
    return valid.includes(s) ? s : valid.reduce((a, b) => Math.abs(b - s) < Math.abs(a - s) ? b : a);
  });

  // Invited members: start with group members, track who's invited to this specific game
  const [invitedIds, setInvitedIds] = useState(() => {
    const existing = Object.keys(game.rsvps || {});
    return new Set(existing.length ? existing : group.members.map((m) => m.id));
  });

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
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

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
    const totalSeats = seats;
    const newWaitlist = [...(game.waitlist || [])];

    // Build rsvps for members — respect capacity
    const newRsvps = { [myUid]: game.rsvps?.[myUid] || "yes" };
    let filled = 1; // host always takes one seat

    group.members.forEach((m) => {
      if (m.id === myUid || !invitedIds.has(m.id)) return;
      const existing = game.rsvps?.[m.id];
      const prevYes = existing === "yes";

      if (prevYes) {
        // Already confirmed — keep their seat
        newRsvps[m.id] = "yes";
        filled++;
      } else if (existing && existing !== "pending") {
        // Had a real non-yes answer — keep it, no seat consumed
        newRsvps[m.id] = existing;
      } else {
        // Newly added or pending
        if (filled < totalSeats) {
          newRsvps[m.id] = "yes";
          filled++;
        } else {
          // No room — move to waitlist
          newRsvps[m.id] = "pending";
          if (!newWaitlist.includes(m.id)) newWaitlist.push(m.id);
        }
      }
    });

    // Build guests — confirmed vs waitlisted
    const newGuests = [];
    guests.forEach((g) => {
      const prevConfirmed = (game.guests || []).find((pg) => pg.id === g.id) &&
        !(game.waitlist || []).includes(g.id);

      if (prevConfirmed) {
        // Already had a confirmed seat
        newGuests.push(g);
        filled++;
      } else if (filled < totalSeats) {
        // Room available — confirm
        newGuests.push(g);
        // Remove from waitlist if they were on it
        const wIdx = newWaitlist.indexOf(g.id);
        if (wIdx > -1) newWaitlist.splice(wIdx, 1);
        filled++;
      } else {
        // Full — put on waitlist
        newGuests.push(g);
        if (!newWaitlist.includes(g.id)) newWaitlist.push(g.id);
      }
    });

    onSave({ ...game, title: title.trim(), date: ts, time, endTime, location: loc.trim(), note, seats, rsvps: newRsvps, guests: newGuests, waitlist: newWaitlist });
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
          <Lbl mt>Seats</Lbl>
          <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
            {[4, 8, 12, 16].map((n) => (
              <div key={n} onClick={() => setSeats(n)} style={{
                flex: 1, height: 46, borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "center",
                cursor: "pointer", fontWeight: 700, fontSize: 16, transition: "all .18s",
                fontFamily: "'Noto Sans JP',sans-serif",
                background: seats === n ? `linear-gradient(135deg,${group.color},${group.color}cc)` : "var(--border-card)",
                color: seats === n ? "#fff" : "#7a4a58",
                border: seats === n ? "none" : "1px solid rgba(var(--primary-rgb),0.2)",
                boxShadow: seats === n ? `0 4px 12px ${group.color}44` : "none",
              }}>{n}</div>
            ))}
          </div>
          <Lbl>Host Notes (optional)</Lbl>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Style of play, what to bring, house rules..." rows={3} style={{ ...inputSt, resize: "none", height: "auto", padding: "12px 14px" }} />
          <div style={{ height: 8 }} />
          <Btn full disabled={!ok} onClick={handleSave}>Save Changes ✨</Btn>
        </div>
      )}

      {/* ── PLAYERS TAB ── */}
      {tab === "players" && (
        <div className="sUp">
          {/* Group members */}
          <div style={glassCard}>
            <div style={{ fontFamily: "'Shippori Mincho',serif", fontSize: 16, color: "var(--section-title)", fontWeight: 700, marginBottom: 12 }}>Group Members</div>
            {group.members.map((m) => {
              const isIn = invitedIds.has(m.id);
              const isMe = m.id === myUid;
              return (
                <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 11, marginBottom: 10 }}>
                  <div style={{ width: 38, height: 38, borderRadius: 999, background: "var(--avatar-bubble-bg)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 21, flexShrink: 0 }}>{m.avatar}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700, fontSize: 15, color: "var(--text-body)" }}>{m.name}</div>
                    {isMe && <div style={{ fontSize: 12, color: "var(--primary)", fontWeight: 700 }}>Host · Always invited</div>}
                  </div>
                  {!isMe && (
                    <div onClick={() => toggleMember(m.id)} style={{
                      width: 32, height: 32, borderRadius: 999, cursor: "pointer",
                      display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16,
                      transition: "all .18s",
                      background: isIn ? `linear-gradient(135deg,${group.color},${group.color}cc)` : "rgba(200,180,190,0.25)",
                      boxShadow: isIn ? `0 2px 8px ${group.color}44` : "none",
                      border: isIn ? "none" : "1px solid rgba(var(--primary-rgb),0.25)",
                    }}>{isIn ? "✅" : "➕"}</div>
                  )}
                  {isMe && <div style={{ width: 32, height: 32, borderRadius: 999, background: `linear-gradient(135deg,${group.color},${group.color}cc)`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16 }}>✅</div>}
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
    ? `${base}?joinGroup=${group.code}&game=${game.id}`
    : `${base}?joinGroup=${group.code}`;

  const txt = game
    ? `You're invited to a Mahjong game!\n\n📅 ${fmt(game.date)} at ${fmtT(game.time)}\n📍 ${game.location}\n🎯 Host: ${game.host}\n🃏 Style: ${game.style}${game.note ? `\n📝 ${game.note}` : ""}\n\nTap to join and RSVP:\n${joinUrl}`
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
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 11, marginBottom: 22 }}>
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

      <div style={{ textAlign: "center", background: "#fff", borderRadius: 14, padding: "14px 16px", boxShadow: "0 2px 10px rgba(0,0,0,.05)" }}>
        <div style={{ fontSize: 12, color: "#bbb", fontWeight: 800, textTransform: "uppercase", letterSpacing: 1 }}>Group Join Code</div>
        <div style={{ fontFamily: "'Shippori Mincho',serif", fontSize: 39, color: group.color, letterSpacing: 8, marginTop: 4 }}>{group.code}</div>
      </div>
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
        {tab === "users"          && <AdminUsers onImpersonate={onImpersonate} go={go} flash={flash} />}
        {tab === "logs"           && <AdminLogs />}
        {tab === "subscriptions"  && <AdminSubscriptions flash={flash} />}
      </div>
    </div>
  );
}

/* Users tab — list all users, search, view-as */
function AdminUsers({ onImpersonate, go, flash }) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [promoting, setPromoting] = useState(null);

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

  const toggleAdmin = async (u) => {
    setPromoting(u.uid);
    try {
      await updateDoc(doc(db, "users", u.uid), { isAdmin: !u.isAdmin });
      setUsers((prev) => prev.map((x) => x.uid === u.uid ? { ...x, isAdmin: !x.isAdmin } : x));
      flash(`${u.name} is now ${!u.isAdmin ? "an Admin" : "a Standard user"}`);
    } catch { flash("Failed to update user role"); }
    setPromoting(null);
  };

  const filtered = users.filter((u) => {
    const q = search.toLowerCase();
    return !q || (u.name || "").toLowerCase().includes(q) || (u.email || "").toLowerCase().includes(q);
  });

  const cardSt = {
    background: "rgba(255,255,255,0.06)", borderRadius: 14,
    padding: "14px 16px", marginBottom: 10,
    border: "1px solid rgba(255,255,255,0.1)",
    display: "flex", alignItems: "center", gap: 12,
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <div style={{ fontFamily: "'Shippori Mincho',serif", fontSize: 18, color: "#fff" }}>All Users</div>
        <div style={{ fontSize: 13, color: "rgba(255,255,255,0.4)" }}>{users.length} total</div>
      </div>

      <input
        value={search} onChange={(e) => setSearch(e.target.value)}
        placeholder="Search by name or email…"
        style={{ width: "100%", padding: "11px 16px", borderRadius: 12, fontSize: 14, border: "1.5px solid rgba(155,110,168,0.3)", background: "rgba(255,255,255,0.08)", color: "#fff", fontFamily: "'Noto Sans JP',sans-serif", outline: "none", boxSizing: "border-box", marginBottom: 18 }}
      />

      {loading && <div style={{ color: "rgba(255,255,255,0.4)", fontSize: 14 }}>Loading…</div>}

      {filtered.map((u) => (
        <div key={u.uid} style={cardSt}>
          <span style={{ fontSize: 26, flexShrink: 0 }}>{u.avatar || "👤"}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: 15, fontWeight: 700, color: "#fff" }}>{u.name || "Unnamed"}</span>
              {u.isAdmin && (
                <span style={{ fontSize: 11, fontWeight: 800, color: "#e8a0d0", background: "rgba(232,160,208,0.18)", borderRadius: 999, padding: "2px 8px", textTransform: "uppercase", letterSpacing: 1 }}>Admin</span>
              )}
            </div>
            <div style={{ fontSize: 13, color: "rgba(255,255,255,0.45)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{u.email}</div>
          </div>
          <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
            <button
              onClick={() => toggleAdmin(u)}
              disabled={promoting === u.uid}
              style={{ background: u.isAdmin ? "rgba(232,160,208,0.15)" : "rgba(255,255,255,0.1)", border: `1px solid ${u.isAdmin ? "rgba(232,160,208,0.35)" : "rgba(255,255,255,0.2)"}`, borderRadius: 10, padding: "6px 12px", color: u.isAdmin ? "#e8a0d0" : "var(--border-card)", fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: "'Noto Sans JP',sans-serif", opacity: promoting === u.uid ? 0.5 : 1 }}
            >
              {u.isAdmin ? "Revoke Admin" : "Make Admin"}
            </button>
            <button
              onClick={() => { onImpersonate(u); go("home"); }}
              style={{ background: "linear-gradient(135deg,#5a2d6b,#9b3fa0)", border: "none", borderRadius: 10, padding: "6px 12px", color: "#fff", fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: "'Noto Sans JP',sans-serif" }}
            >
              View as
            </button>
          </div>
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
function AdminSubscriptions({ flash }) {
  const [packages, setPackages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // null | "new" | docId
  const [form, setForm] = useState({ name: "", price: "", interval: "month", description: "", features: "" });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const q = query(collection(db, "subscriptionPackages"), orderBy("price", "asc"));
    const unsub = onSnapshot(q, (snap) => {
      setPackages(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      setLoading(false);
    }, () => setLoading(false));
    return unsub;
  }, []);

  const startNew = () => {
    setForm({ name: "", price: "", interval: "month", description: "", features: "" });
    setEditing("new");
  };

  const startEdit = (pkg) => {
    setForm({ name: pkg.name, price: String(pkg.price), interval: pkg.interval || "month", description: pkg.description || "", features: (pkg.features || []).join("\n") });
    setEditing(pkg.id);
  };

  const save = async () => {
    if (!form.name.trim() || !form.price) return;
    setSaving(true);
    const data = {
      name: form.name.trim(),
      price: parseFloat(form.price) || 0,
      interval: form.interval,
      description: form.description.trim(),
      features: form.features.split("\n").map((s) => s.trim()).filter(Boolean),
      updatedAt: serverTimestamp(),
    };
    try {
      if (editing === "new") {
        await addDoc(collection(db, "subscriptionPackages"), { ...data, createdAt: serverTimestamp() });
        flash("Package created");
      } else {
        await updateDoc(doc(db, "subscriptionPackages", editing), data);
        flash("Package updated");
      }
      setEditing(null);
    } catch { flash("Failed to save package"); }
    setSaving(false);
  };

  const remove = async (id, name) => {
    if (!window.confirm(`Delete "${name}"? This cannot be undone.`)) return;
    try {
      await deleteDoc(doc(db, "subscriptionPackages", id));
      flash("Package deleted");
    } catch { flash("Failed to delete package"); }
  };

  const inputSt2 = { width: "100%", padding: "10px 14px", borderRadius: 10, fontSize: 14, border: "1.5px solid rgba(155,110,168,0.3)", background: "rgba(255,255,255,0.08)", color: "#fff", fontFamily: "'Noto Sans JP',sans-serif", outline: "none", boxSizing: "border-box", marginBottom: 10 };

  if (editing !== null) {
    return (
      <div>
        <div style={{ fontFamily: "'Shippori Mincho',serif", fontSize: 18, color: "#fff", marginBottom: 20 }}>
          {editing === "new" ? "New Package" : "Edit Package"}
        </div>
        <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Package name (e.g. Pro)" style={inputSt2} />
        <div style={{ display: "flex", gap: 10, marginBottom: 0 }}>
          <input value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} placeholder="Price (e.g. 9.99)" type="number" min="0" step="0.01" style={{ ...inputSt2, flex: 1 }} />
          <select value={form.interval} onChange={(e) => setForm({ ...form, interval: e.target.value })} style={{ ...inputSt2, flex: 1 }}>
            <option value="month">/ month</option>
            <option value="year">/ year</option>
            <option value="once">one-time</option>
          </select>
        </div>
        <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Short description" style={inputSt2} />
        <textarea value={form.features} onChange={(e) => setForm({ ...form, features: e.target.value })} placeholder={"Features (one per line)\nUnlimited groups\nPriority support"} rows={5} style={{ ...inputSt2, resize: "vertical" }} />
        <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
          <button onClick={() => setEditing(null)} style={{ flex: 1, padding: "11px", borderRadius: 12, background: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.2)", color: "#fff", fontWeight: 700, fontSize: 14, cursor: "pointer", fontFamily: "'Noto Sans JP',sans-serif" }}>Cancel</button>
          <button onClick={save} disabled={saving || !form.name.trim() || !form.price} style={{ flex: 1, padding: "11px", borderRadius: 12, background: "linear-gradient(135deg,#5a2d6b,#9b3fa0)", border: "none", color: "#fff", fontWeight: 700, fontSize: 14, cursor: "pointer", fontFamily: "'Noto Sans JP',sans-serif", opacity: (saving || !form.name.trim() || !form.price) ? 0.5 : 1 }}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <div style={{ fontFamily: "'Shippori Mincho',serif", fontSize: 18, color: "#fff" }}>Subscription Packages</div>
        <button onClick={startNew} style={{ background: "linear-gradient(135deg,#5a2d6b,#9b3fa0)", border: "none", borderRadius: 10, padding: "8px 16px", color: "#fff", fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "'Noto Sans JP',sans-serif" }}>+ New Package</button>
      </div>

      {loading && <div style={{ color: "rgba(255,255,255,0.4)", fontSize: 14 }}>Loading…</div>}
      {!loading && packages.length === 0 && (
        <div style={{ color: "rgba(255,255,255,0.4)", fontSize: 14, marginBottom: 16 }}>No packages yet. Create your first subscription package.</div>
      )}

      {packages.map((pkg) => (
        <div key={pkg.id} style={{ background: "rgba(255,255,255,0.06)", borderRadius: 16, padding: "18px 20px", marginBottom: 12, border: "1px solid rgba(155,110,168,0.2)" }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
                <span style={{ fontFamily: "'Shippori Mincho',serif", fontSize: 18, color: "#fff", fontWeight: 700 }}>{pkg.name}</span>
                <span style={{ fontSize: 20, color: "#e8a0d0", fontWeight: 800 }}>${pkg.price}</span>
                <span style={{ fontSize: 13, color: "rgba(255,255,255,0.4)" }}>/ {pkg.interval}</span>
              </div>
              {pkg.description && <div style={{ fontSize: 13, color: "var(--bg-surface)", marginTop: 4 }}>{pkg.description}</div>}
              {pkg.features?.length > 0 && (
                <ul style={{ margin: "8px 0 0", paddingLeft: 18 }}>
                  {pkg.features.map((f, i) => <li key={i} style={{ fontSize: 13, color: "var(--border-card)", marginBottom: 3 }}>{f}</li>)}
                </ul>
              )}
            </div>
            <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
              <button onClick={() => startEdit(pkg)} style={{ background: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 10, padding: "6px 12px", color: "#fff", fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: "'Noto Sans JP',sans-serif" }}>Edit</button>
              <button onClick={() => remove(pkg.id, pkg.name)} style={{ background: "rgba(var(--primary-rgb),0.15)", border: "1px solid rgba(var(--primary-rgb),0.3)", borderRadius: 10, padding: "6px 12px", color: "var(--primary)", fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: "'Noto Sans JP',sans-serif" }}>Delete</button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
