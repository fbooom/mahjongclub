/**
 * Mahjong Club — Firebase Cloud Functions
 *
 * Push notifications via FCM for:
 *   1. New chat messages in a group
 *   2. Replies in a message thread
 *   3. User added to a game (on creation or after the fact)
 *   4. 24-hour game reminder (scheduled, sent once per game)
 *
 * DEPLOY:
 *   npm install -g firebase-tools
 *   firebase login
 *   firebase use mahjong-club-da606
 *   cd functions && npm install
 *   firebase deploy --only functions
 *
 * NOTE: The scheduled reminder uses a Firestore collectionGroup query on "games".
 * Firestore automatically indexes single fields, so no manual index is needed
 * for the `date` range query. The `reminder24hSent` flag is checked in code.
 */

const { onDocumentCreated, onDocumentUpdated, onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");
const { getAuth } = require("firebase-admin/auth");
const { getStorage } = require("firebase-admin/storage");

const STRIPE_SECRET_KEY    = defineSecret("STRIPE_SECRET_KEY");
const STRIPE_WEBHOOK_SECRET = defineSecret("STRIPE_WEBHOOK_SECRET");

initializeApp();
const db = getFirestore();
const messaging = getMessaging();

/**
 * Fetch all push tokens for a list of user IDs.
 *
 * Sends to ALL tokens (native + web) so users receive notifications on every
 * device they use — phone (native), laptop (web), etc.
 */
async function getTokensForUsers(userIds) {
  if (!userIds.length) return { tokens: [], tokenToUid: {} };
  const chunks = [];
  for (let i = 0; i < userIds.length; i += 10) chunks.push(userIds.slice(i, i + 10));
  const tokenToUid = {};
  for (const chunk of chunks) {
    const snaps = await Promise.all(chunk.map((uid) => db.doc(`users/${uid}`).get()));
    snaps.forEach((snap) => {
      const data = snap.data();
      if (data?.notificationsEnabled === false) return; // explicitly disabled
      const allTokens = [...(data?.nativePushTokens || []), ...(data?.fcmTokens || [])];
      if (!allTokens.length) return; // no tokens — nothing to send to
      allTokens.forEach((t) => { if (t) tokenToUid[t] = snap.id; });
    });
  }
  return { tokens: [...new Set(Object.keys(tokenToUid))], tokenToUid };
}

/** Send FCM messages in batches of 500. Removes stale tokens from Firestore after failures. */
async function sendToTokens({ tokens, tokenToUid }, notification, data = {}) {
  if (!tokens.length) return;
  const staleByUid = {};
  const batches = [];
  for (let i = 0; i < tokens.length; i += 500) batches.push(tokens.slice(i, i + 500));
  for (const batch of batches) {
    const result = await messaging.sendEachForMulticast({
      tokens: batch,
      notification,
      data,
      android: {
        notification: { channelId: "default", sound: "default" },
      },
      apns: {
        headers: { "apns-priority": "10" },
        payload: { aps: { sound: "default" } },
      },
    });
    result.responses.forEach((resp, idx) => {
      if (!resp.success) {
        const code = resp.error?.code || "";
        if (code.includes("registration-token-not-registered") || code.includes("invalid-registration-token")) {
          const token = batch[idx];
          const uid = tokenToUid[token];
          if (uid) { (staleByUid[uid] = staleByUid[uid] || []).push(token); }
        }
      }
    });
  }
  // Remove stale tokens from Firestore (best effort, non-blocking)
  if (Object.keys(staleByUid).length > 0) {
    Promise.allSettled(Object.entries(staleByUid).map(async ([uid, stale]) => {
      const snap = await db.doc(`users/${uid}`).get();
      const d = snap.data();
      if (!d) return;
      const updates = {};
      const newFcm = (d.fcmTokens || []).filter((t) => !stale.includes(t));
      const newNative = (d.nativePushTokens || []).filter((t) => !stale.includes(t));
      if (newFcm.length < (d.fcmTokens || []).length) updates.fcmTokens = newFcm;
      if (newNative.length < (d.nativePushTokens || []).length) updates.nativePushTokens = newNative;
      if (Object.keys(updates).length) await db.doc(`users/${uid}`).update(updates);
    })).catch(() => {});
  }
}

/** Format a ms timestamp for display */
function fmtDate(ms) {
  return new Date(ms).toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric",
  });
}

/* ── ADMIN LOG HELPERS ───────────────────────────────────────────────────────
 * addAdminLog  — writes a structured entry to the adminLogs Firestore collection
 *               (visible in Admin Hub → Logs tab).
 * writeErrorLog — appends a line to a rolling .txt file in Firebase Storage.
 *                 Filename: logs/mjlog_MM_DD_YYYY[_N].txt, max 10 MB per file.
 * ────────────────────────────────────────────────────────────────────────── */
async function addAdminLog(entry) {
  try {
    await db.collection("adminLogs").add({
      ts: FieldValue.serverTimestamp(),
      ...entry,
    });
  } catch (e) {
    console.error("[addAdminLog] Failed to write log entry:", e.message);
  }
}

const LOG_FILE     = "logs/mjlog.txt";
const LOG_MAX_BYTES = 10 * 1024 * 1024; // 10 MB — trim oldest 25% when exceeded

async function writeErrorLog(message) {
  try {
    const bucket  = getStorage().bucket();
    const file    = bucket.file(LOG_FILE);
    const logLine = `[${new Date().toISOString()}] ${message}\n`;

    let existingContent = "";
    try {
      const [meta] = await file.getMetadata();
      const [buf]  = await file.download();
      existingContent = buf.toString("utf8");
      if (parseInt(meta.size || "0", 10) >= LOG_MAX_BYTES) {
        const lines    = existingContent.split("\n").filter(Boolean);
        const keepFrom = Math.floor(lines.length * 0.25); // drop oldest 25%
        existingContent = lines.slice(keepFrom).join("\n") + "\n";
      }
    } catch (e) {
      if (e.code !== 404 && !e.message?.includes("No such object")) throw e;
    }

    await file.save(existingContent + logLine, {
      contentType: "text/plain",
      metadata: { cacheControl: "no-cache" },
    });
  } catch (e) {
    console.error("[writeErrorLog] Failed to write error log file:", e.message);
  }
}

// ── 1. New chat message ──────────────────────────────────────────────────────
exports.onNewChatMessage = onDocumentCreated(
  "groups/{groupId}/messages/{messageId}",
  async (event) => {
    const msg = event.data.data();
    const { groupId } = event.params;

    const groupSnap = await db.doc(`groups/${groupId}`).get();
    if (!groupSnap.exists) return;
    const group = groupSnap.data();

    const recipients = (group.memberIds || []).filter((id) => id !== msg.uid);
    const tokenData = await getTokensForUsers(recipients);

    await sendToTokens(
      tokenData,
      {
        title: `${msg.name} in ${group.name}`,
        body: msg.text?.length > 100 ? msg.text.slice(0, 97) + "…" : msg.text,
      },
      { type: "chat", groupId, messageId: event.params.messageId }
    );
  }
);

// ── 1b. New game chat message — notify all game participants ─────────────────
// Participants = everyone in game.rsvps (group members) + game.guestIds (QR joiners).
// Token routing: getTokensForUsers prefers nativePushTokens (mobile app) and
// falls back to fcmTokens (web) so each user gets one notification on the right channel.
exports.onNewGameChatMessage = onDocumentCreated(
  "groups/{groupId}/games/{gameId}/messages/{messageId}",
  async (event) => {
    const msg = event.data.data();
    const { groupId, gameId } = event.params;

    const gameSnap = await db.doc(`groups/${groupId}/games/${gameId}`).get();
    if (!gameSnap.exists) return;
    const game = gameSnap.data();

    const memberUids = game.memberIds || [];
    const rsvpUids   = Object.keys(game.rsvps || {});
    const guestUids  = game.guestIds || [];
    const recipients = [...new Set([...memberUids, ...rsvpUids, ...guestUids])].filter((id) => id !== msg.uid);
    if (!recipients.length) return;

    const tokenData = await getTokensForUsers(recipients);
    await sendToTokens(
      tokenData,
      {
        title: `${msg.name} · ${game.title}`,
        body: msg.text?.length > 100 ? msg.text.slice(0, 97) + "…" : msg.text,
      },
      { type: "gameChat", groupId, gameId, messageId: event.params.messageId }
    );
  }
);

// ── 1c. New standalone game chat message — notify all game participants ──────
// Standalone games store messages at games/{gameId}/messages/{messageId}
// (no groupId in path). Participants = memberIds + rsvps + guestIds.
exports.onNewStandaloneGameChatMessage = onDocumentCreated(
  "games/{gameId}/messages/{messageId}",
  async (event) => {
    const msg = event.data.data();
    const { gameId } = event.params;

    const gameSnap = await db.doc(`games/${gameId}`).get();
    if (!gameSnap.exists) return;
    const game = gameSnap.data();

    const memberUids = game.memberIds || [];
    const rsvpUids   = Object.keys(game.rsvps || {});
    const guestUids  = game.guestIds || [];
    const recipients = [...new Set([...memberUids, ...rsvpUids, ...guestUids])].filter((id) => id !== msg.uid);
    if (!recipients.length) return;

    const tokenData = await getTokensForUsers(recipients);
    await sendToTokens(
      tokenData,
      {
        title: `${msg.name} · ${game.title}`,
        body: msg.text?.length > 100 ? msg.text.slice(0, 97) + "…" : msg.text,
      },
      { type: "gameChat", gameId, messageId: event.params.messageId }
    );
  }
);

// ── 1d. New reply in a game chat thread ─────────────────────────────────────
// Notifies the original poster and all prior repliers when a new reply is added.
exports.onNewGameChatReply = onDocumentUpdated(
  "groups/{groupId}/games/{gameId}/messages/{messageId}",
  async (event) => {
    const before = event.data.before.data();
    const after  = event.data.after.data();

    const prevReplies = before.replies || [];
    const newReplies  = after.replies  || [];
    if (newReplies.length <= prevReplies.length) return;

    const latestReply = newReplies[newReplies.length - 1];
    const senderUid   = latestReply.uid;
    const { groupId, gameId } = event.params;

    const threadUids = [after.uid, ...prevReplies.map((r) => r.uid)];
    const recipients = [...new Set(threadUids)].filter((id) => id !== senderUid);
    if (!recipients.length) return;

    const gameSnap = await db.doc(`groups/${groupId}/games/${gameId}`).get();
    const gameTitle = gameSnap.data()?.title || "your game";

    const tokenData = await getTokensForUsers(recipients);
    const body = latestReply.text?.length > 100
      ? latestReply.text.slice(0, 97) + "…"
      : latestReply.text;

    await sendToTokens(
      tokenData,
      {
        title: `${latestReply.name} replied in ${gameTitle}`,
        body,
      },
      { type: "gameChat", groupId, gameId, messageId: event.params.messageId }
    );
  }
);

// ── 2. New reply on a message ────────────────────────────────────────────────
exports.onNewReply = onDocumentUpdated(
  "groups/{groupId}/messages/{messageId}",
  async (event) => {
    const before = event.data.before.data();
    const after  = event.data.after.data();

    const prevReplies = before.replies || [];
    const newReplies  = after.replies  || [];

    if (newReplies.length <= prevReplies.length) return;

    const latestReply = newReplies[newReplies.length - 1];
    const senderUid   = latestReply.uid;
    const { groupId }  = event.params;

    const threadUids = [
      after.uid,
      ...prevReplies.map((r) => r.uid),
    ];
    const recipients = [...new Set(threadUids)].filter((id) => id !== senderUid);
    if (!recipients.length) return;

    const groupSnap = await db.doc(`groups/${groupId}`).get();
    const groupName = groupSnap.data()?.name || "your group";

    const tokenData = await getTokensForUsers(recipients);
    const body = latestReply.text?.length > 100
      ? latestReply.text.slice(0, 97) + "…"
      : latestReply.text;

    await sendToTokens(
      tokenData,
      {
        title: `${latestReply.name} replied in ${groupName}`,
        body,
      },
      { type: "reply", groupId, messageId: event.params.messageId }
    );
  }
);

// ── 3a. Game created — notify all members except the host ────────────────────
exports.onGameCreated = onDocumentCreated(
  "groups/{groupId}/games/{gameId}",
  async (event) => {
    const game = event.data.data();
    const { groupId, gameId } = event.params;

    const groupSnap = await db.doc(`groups/${groupId}`).get();
    if (!groupSnap.exists) return;
    const groupName = groupSnap.data()?.name || "your group";

    // Notify everyone in the game except the host who created it
    const recipients = (game.memberIds || []).filter((id) => id !== game.hostId);
    if (!recipients.length) return;

    const tokenData = await getTokensForUsers(recipients);
    await sendToTokens(
      tokenData,
      {
        title: "You've been added to a game!",
        body: `${game.title} · ${groupName}${game.date ? " · " + fmtDate(game.date) : ""}${game.time ? " · " + game.time : ""}`,
      },
      { type: "game", groupId, gameId }
    );
  }
);

// ── 3b. Members added to an existing game ───────────────────────────────────
exports.onGameMembersAdded = onDocumentUpdated(
  "groups/{groupId}/games/{gameId}",
  async (event) => {
    const before = event.data.before.data();
    const after  = event.data.after.data();
    const { groupId, gameId } = event.params;

    // Find members who weren't in the game before
    const prevMembers = new Set(before.memberIds || []);
    const newMembers  = (after.memberIds || []).filter((id) => !prevMembers.has(id));
    if (!newMembers.length) return;

    const groupSnap = await db.doc(`groups/${groupId}`).get();
    const groupName = groupSnap.data()?.name || "your group";

    const tokenData = await getTokensForUsers(newMembers);
    await sendToTokens(
      tokenData,
      {
        title: "You've been added to a game!",
        body: `${after.title} · ${groupName}${after.date ? " · " + fmtDate(after.date) : ""}${after.time ? " · " + after.time : ""}`,
      },
      { type: "game", groupId, gameId }
    );
  }
);

// ── 4. 24-hour game reminders (runs every hour) ──────────────────────────────
// Queries all games starting in the next 24–25 hours.
// Sets `reminder24hSent: true` on each game after notifying so it only fires once.
exports.sendGameReminders = onSchedule("every 60 minutes", async () => {
  const now = Date.now();
  const windowStart = now + 24 * 60 * 60 * 1000;           // 24 hours from now
  const windowEnd   = now + 25 * 60 * 60 * 1000;           // 25 hours from now

  const snap = await db
    .collectionGroup("games")
    .where("date", ">=", windowStart)
    .where("date", "<=", windowEnd)
    .get();

  if (snap.empty) return;

  const batch = db.batch();
  const sends = [];

  for (const gameDoc of snap.docs) {
    const game = gameDoc.data();

    // Skip if reminder already sent
    if (game.reminder24hSent) continue;

    // Derive groupId from path: groups/{groupId}/games/{gameId} (4 parts)
    // Standalone games live at games/{gameId} (2 parts) — skip them since
    // they have no group context and parent.parent would be null.
    const pathParts = gameDoc.ref.path.split("/");
    if (pathParts.length < 4) continue;
    const groupId = pathParts[1];

    const groupSnap = await db.doc(`groups/${groupId}`).get();
    const groupName = groupSnap.data()?.name || "your group";

    // Notify all members plus anyone who RSVP'd yes
    const rsvpYes = Object.entries(game.rsvps || {})
      .filter(([, v]) => v === "yes")
      .map(([uid]) => uid);
    const recipients = [...new Set([...(game.memberIds || []), ...rsvpYes])];

    const tokenData = await getTokensForUsers(recipients);
    sends.push(
      sendToTokens(
        tokenData,
        {
          title: `Game tomorrow: ${game.title}`,
          body: `${groupName}${game.date ? " · " + fmtDate(game.date) : ""}${game.time ? " · " + game.time : ""}`,
        },
        { type: "gameReminder", groupId, gameId: gameDoc.id }
      )
    );

    // Mark as sent so this game is never reminded again
    batch.update(gameDoc.ref, { reminder24hSent: true });
  }

  await Promise.all(sends);
  await batch.commit();
});

// ── 5. Delete a user (admin only) ────────────────────────────────────────────
// Callable function: cleans up all Firestore references then deletes the
// Firebase Auth record.  Only callable by users with isAdmin === true.
//
// Cleanup steps:
//   1. For each group the user is a member of:
//      a. Remove from memberIds and members arrays
//      b. If they were the sole host → transfer host to first remaining member
//         If no remaining members → delete the group and its sub-collections
//      c. For each game in the group → remove from memberIds, rsvps, waitlist,
//         guestIds, guests; if they were the hostId → reassign to first
//         remaining member
//   2. Delete the users/{uid} Firestore document
//   3. Delete the Firebase Auth user record
exports.deleteUser = onCall({ invoker: "public" }, async (request) => {
  // Verify caller is authenticated
  if (!request.auth) throw new HttpsError("unauthenticated", "Must be signed in.");

  // Verify caller is an admin
  const callerSnap = await db.doc(`users/${request.auth.uid}`).get();
  if (callerSnap.data()?.isAdmin !== true) {
    throw new HttpsError("permission-denied", "Only admins can delete users.");
  }

  const { uid } = request.data;
  if (!uid || typeof uid !== "string") {
    throw new HttpsError("invalid-argument", "uid is required.");
  }
  if (uid === request.auth.uid) {
    throw new HttpsError("invalid-argument", "Admins cannot delete their own account.");
  }

  // 1. Find all groups where this user is a member
  const groupsSnap = await db.collection("groups")
    .where("memberIds", "array-contains", uid)
    .get();

  for (const groupDoc of groupsSnap.docs) {
    const g = groupDoc.data();
    const remainingMemberIds = (g.memberIds || []).filter((id) => id !== uid);
    const remainingMembers   = (g.members   || []).filter((m) => m.id !== uid);
    const wasHost = (g.members || []).some((m) => m.id === uid && m.host);

    // If no remaining members → delete games sub-collection then the group
    if (remainingMemberIds.length === 0) {
      const gamesSnap = await groupDoc.ref.collection("games").get();
      const deleteBatch = db.batch();
      gamesSnap.docs.forEach((d) => deleteBatch.delete(d.ref));
      deleteBatch.delete(groupDoc.ref);
      await deleteBatch.commit();
      continue;
    }

    // Build the updated members array, promoting a new host if needed
    let updatedMembers = remainingMembers;
    if (wasHost) {
      updatedMembers = updatedMembers.map((m, i) =>
        i === 0 ? { ...m, host: true } : m
      );
    }

    // Update the group document
    await groupDoc.ref.update({
      memberIds: remainingMemberIds,
      members:   updatedMembers,
    });

    // Clean up every game in this group
    const gamesSnap = await groupDoc.ref.collection("games").get();
    const gameBatch = db.batch();
    for (const gameDoc of gamesSnap.docs) {
      const game = gameDoc.data();
      const updates = {};

      if ((game.memberIds || []).includes(uid)) {
        updates.memberIds = (game.memberIds || []).filter((id) => id !== uid);
      }
      if (game.rsvps && uid in game.rsvps) {
        updates[`rsvps.${uid}`] = FieldValue.delete();
      }
      if ((game.waitlist || []).includes(uid)) {
        updates.waitlist = (game.waitlist || []).filter((id) => id !== uid);
      }
      if ((game.guestIds || []).includes(uid)) {
        updates.guestIds = (game.guestIds || []).filter((id) => id !== uid);
      }
      if ((game.guests || []).some((g) => g.id === uid)) {
        updates.guests = (game.guests || []).filter((g) => g.id !== uid);
      }
      // Reassign hostId if this user was the game host
      if (game.hostId === uid) {
        const nextHost = (updates.memberIds ?? game.memberIds ?? []).find((id) => id !== uid);
        updates.hostId = nextHost || null;
      }

      if (Object.keys(updates).length > 0) gameBatch.update(gameDoc.ref, updates);
    }
    await gameBatch.commit();
  }

  // 2. Delete the Firestore user document
  await db.doc(`users/${uid}`).delete();

  // 3. Delete the Firebase Auth record
  try {
    await getAuth().deleteUser(uid);
  } catch (e) {
    // Auth record may not exist (e.g. created via Firestore only) — not fatal
    if (e.code !== "auth/user-not-found") throw e;
  }

  return { success: true };
});

/* ── STRIPE WEBHOOK ─────────────────────────────────────────────────────────
 * Receives events from Stripe and syncs subscription state to Firestore.
 *
 * After deploying, register this URL in Stripe Dashboard → Developers →
 * Webhooks → Add endpoint:
 *   https://mahjong-club-da606.web.app/api/stripe-webhook
 * (Routes through Firebase Hosting to avoid org policy IAM restrictions)
 *
 * Events to enable:
 *   checkout.session.completed
 *   customer.subscription.updated
 *   customer.subscription.deleted
 *   invoice.payment_failed
 * ────────────────────────────────────────────────────────────────────────── */
exports.stripeWebhook = onRequest(
  { secrets: [STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET] },
  async (req, res) => {
    const stripe = require("stripe")(STRIPE_SECRET_KEY.value());
    const sig    = req.headers["stripe-signature"];

    let event;
    try {
      event = stripe.webhooks.constructEvent(req.rawBody, sig, STRIPE_WEBHOOK_SECRET.value());
    } catch (err) {
      await writeErrorLog(`[stripe] Webhook signature verification failed: ${err.message}`);
      return res.status(400).send("Webhook Error: invalid signature");
    }

    const obj = event.data.object;

    // Helper — find Firebase uid from Stripe metadata or customer lookup
    async function getUid() {
      // Payment links pass uid as client_reference_id on the session
      if (obj.client_reference_id) return obj.client_reference_id;
      // Subscriptions carry it in metadata
      if (obj.metadata?.uid) return obj.metadata.uid;
      // Fall back: look up customer in Firestore by stripeCustomerId
      if (obj.customer) {
        const snap = await db.collection("users")
          .where("stripeCustomerId", "==", obj.customer)
          .limit(1).get();
        if (!snap.empty) return snap.docs[0].id;
      }
      return null;
    }

    try {
      switch (event.type) {

        case "checkout.session.completed": {
          const uid       = await getUid();
          const subId     = obj.subscription;
          const planKey   = obj.metadata?.planKey ?? "club";
          if (!uid) { await writeErrorLog(`[stripe] No uid found for checkout session ${obj.id}`); break; }

          // Retrieve subscription to get trial end date
          let trialEnd = null;
          let isTrial  = false;
          if (subId) {
            const sub = await stripe.subscriptions.retrieve(subId);
            isTrial  = sub.status === "trialing";
            trialEnd = sub.trial_end ? sub.trial_end * 1000 : null; // convert to ms
            // Store customer id for future lookups
            await db.collection("users").doc(uid).update({
              stripeCustomerId: obj.customer,
            });
          }

          await db.collection("users").doc(uid).update({
            "subscription.plan":                planKey,
            "subscription.isTrial":             isTrial,
            "subscription.trialEndsAt":         trialEnd,
            "subscription.stripeSubscriptionId": subId ?? null,
            "subscription.stripeStatus":         "active",
            "subscription.changedAt":            FieldValue.serverTimestamp(),
          });
          await writeErrorLog(`[stripe] checkout.session.completed — uid=${uid} plan=${planKey} trial=${isTrial}`);
          break;
        }

        case "customer.subscription.updated": {
          const uid = await getUid();
          if (!uid) break;
          const isTrial = obj.status === "trialing";
          const trialEnd = obj.trial_end ? obj.trial_end * 1000 : null;
          await db.collection("users").doc(uid).update({
            "subscription.isTrial":     isTrial,
            "subscription.trialEndsAt": trialEnd,
            "subscription.stripeStatus": obj.status,
            "subscription.changedAt":   FieldValue.serverTimestamp(),
          });
          break;
        }

        case "customer.subscription.deleted": {
          const uid = await getUid();
          if (!uid) break;
          await db.collection("users").doc(uid).update({
            "subscription.plan":                 "free",
            "subscription.isTrial":              false,
            "subscription.trialEndsAt":          null,
            "subscription.stripeSubscriptionId": null,
            "subscription.stripeStatus":         "cancelled",
            "subscription.changedAt":            FieldValue.serverTimestamp(),
          });
          await writeErrorLog(`[stripe] subscription cancelled — uid=${uid} → free plan`);
          break;
        }

        case "invoice.payment_failed": {
          const uid = await getUid();
          if (!uid) break;
          await db.collection("users").doc(uid).update({
            "subscription.stripeStatus": "past_due",
            "subscription.changedAt":    FieldValue.serverTimestamp(),
          });
          break;
        }

        default:
          break;
      }
    } catch (err) {
      await writeErrorLog(`[stripe] Error processing event ${event.type}: ${err.message}`);
      return res.status(500).send("Internal error");
    }

    res.json({ received: true });
  }
);

/* ── CANCEL SUBSCRIPTION ────────────────────────────────────────────────── */
exports.cancelSubscription = onCall(
  { secrets: [STRIPE_SECRET_KEY] },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign in required");

    const userSnap = await db.collection("users").doc(uid).get();
    const userData = userSnap.data();

    // Rate limit: one cancellation attempt per 60 seconds per user
    const lastAttempt = userData?.subscription?.lastCancelAttempt;
    if (lastAttempt && (Date.now() - lastAttempt.toMillis()) < 60_000) {
      throw new HttpsError("resource-exhausted", "Please wait before trying again.");
    }
    // Record the attempt timestamp immediately
    await db.collection("users").doc(uid).update({
      "subscription.lastCancelAttempt": FieldValue.serverTimestamp(),
    });

    const subId = userData?.subscription?.stripeSubscriptionId;

    // Cancel in Stripe if a subscription exists
    if (subId) {
      const stripe = require("stripe")(STRIPE_SECRET_KEY.value());
      try {
        await stripe.subscriptions.cancel(subId);
      } catch (err) {
        // If already cancelled in Stripe, continue and clean up Firestore
        if (err.code !== "resource_missing") throw new HttpsError("internal", err.message);
      }
    }

    // Always downgrade in Firestore regardless
    await db.collection("users").doc(uid).update({
      "subscription.plan":                 "free",
      "subscription.isTrial":              false,
      "subscription.trialEndsAt":          null,
      "subscription.stripeSubscriptionId": null,
      "subscription.stripeStatus":         "cancelled",
      "subscription.changedAt":            FieldValue.serverTimestamp(),
    });

    await writeErrorLog(`[stripe] cancelSubscription — uid=${uid} → free plan`);
    return { success: true };
  }
);

/* ── SET ADMIN ROLE ─────────────────────────────────────────────────────────
 * Callable by admins only. Changes a user's isAdmin flag server-side
 * (bypasses Firestore client rules) and writes an immutable audit log entry.
 * The client rule blocks direct isAdmin writes, so this is the only path.
 * ────────────────────────────────────────────────────────────────────────── */
exports.setAdminRole = onCall({ invoker: "public" }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");

  const callerSnap = await db.doc(`users/${request.auth.uid}`).get();
  if (callerSnap.data()?.isAdmin !== true) {
    throw new HttpsError("permission-denied", "Only admins can change user roles.");
  }

  const { targetUid, isAdmin } = request.data;
  if (!targetUid || typeof targetUid !== "string") {
    throw new HttpsError("invalid-argument", "targetUid is required.");
  }
  if (typeof isAdmin !== "boolean") {
    throw new HttpsError("invalid-argument", "isAdmin must be a boolean.");
  }
  if (targetUid === request.auth.uid) {
    throw new HttpsError("invalid-argument", "Admins cannot change their own role.");
  }

  // Admin SDK write — bypasses Firestore client security rules
  await db.doc(`users/${targetUid}`).update({ isAdmin });

  // Immutable audit log
  await db.collection("adminLogs").add({
    ts:        FieldValue.serverTimestamp(),
    type:      "roleChange",
    action:    isAdmin ? "granted admin role" : "revoked admin role",
    targetUid,
    adminUid:  request.auth.uid,
    adminName: callerSnap.data()?.name || "Unknown",
  });

  return { success: true };
});

/* ── ADMIN UPDATE USER ───────────────────────────────────────────────────────
 * Allows an admin to update a user's profile fields and/or email address.
 * Email changes are applied to Firebase Auth so they take effect on next login.
 * ────────────────────────────────────────────────────────────────────────── */
exports.adminUpdateUser = onCall({ invoker: "public" }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");

  const callerSnap = await db.doc(`users/${request.auth.uid}`).get();
  if (callerSnap.data()?.isAdmin !== true) {
    throw new HttpsError("permission-denied", "Admins only.");
  }

  const { targetUid, email } = request.data;
  if (!targetUid || typeof targetUid !== "string") {
    throw new HttpsError("invalid-argument", "targetUid is required.");
  }
  if (typeof email !== "string" || !email.trim()) {
    throw new HttpsError("invalid-argument", "email is required.");
  }

  const newEmail = email.trim().toLowerCase();
  if (!/\S+@\S+\.\S+/.test(newEmail)) {
    throw new HttpsError("invalid-argument", "Invalid email address.");
  }

  await getAuth().updateUser(targetUid, { email: newEmail });
  await db.doc(`users/${targetUid}`).update({ email: newEmail });

  return { success: true };
});

/* ── LOG IMPERSONATION ───────────────────────────────────────────────────────
 * Called by the client when an admin starts or stops impersonating a user.
 * Verifies admin status server-side before writing the audit entry.
 * ────────────────────────────────────────────────────────────────────────── */
exports.logImpersonation = onCall({ invoker: "public" }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");

  const callerSnap = await db.doc(`users/${request.auth.uid}`).get();
  if (callerSnap.data()?.isAdmin !== true) {
    throw new HttpsError("permission-denied", "Only admins can impersonate users.");
  }

  const { targetUid, targetName, action } = request.data;

  // ── SMTP test — piggybacked here because this function already has allUsers IAM ──
  if (action === "_testSmtp") {
    const { to, logResults } = request.data;
    if (!to || !/\S+@\S+\.\S+/.test(to)) {
      throw new HttpsError("invalid-argument", "A valid recipient email is required.");
    }

    let cfg = {};
    try {
      const cfgDoc = await db.doc("adminConfig/smtp").get();
      if (cfgDoc.exists) cfg = cfgDoc.data() || {};
    } catch (e) {
      throw new HttpsError("internal", `Could not read SMTP config: ${e.message}`);
    }

    const missing = ["host", "user", "pass"].filter(k => !cfg[k]);
    if (missing.length) {
      throw new HttpsError("failed-precondition", `SMTP settings incomplete — missing: ${missing.join(", ")}`);
    }

    try {
      await sendEmail({
        to,
        subject: "Mahjong Club — SMTP test",
        html: "<p>This is a test email from your Mahjong Club admin panel. If you received this, your SMTP settings are working correctly.</p>",
      });

      if (logResults) {
        await db.collection("adminLogs").add({
          ts: FieldValue.serverTimestamp(), type: "email",
          message: `[SMTP test] success — delivered to ${to} via ${cfg.host}`,
        }).catch(() => {});
        await writeErrorLog(`[smtpTest] Success: delivered to ${to}`);
      }

      return { success: true };

    } catch (e) {
      const smtpResponse = e.response     || "";
      const smtpCode     = String(e.responseCode || e.code || "");
      const smtpCommand  = e.command      || "";

      const fullMsg = [
        `[SMTP test] failed: ${e.message}`,
        smtpCode     ? `code ${smtpCode}`        : "",
        smtpCommand  ? `cmd ${smtpCommand}`       : "",
        smtpResponse ? `server: ${smtpResponse}`  : "",
      ].filter(Boolean).join(" | ");

      await db.collection("adminLogs").add({
        ts: FieldValue.serverTimestamp(), type: "error",
        message: fullMsg, smtpCode, smtpCommand, smtpResponse,
      }).catch(() => {});

      if (logResults) await writeErrorLog(`[smtpTest] SMTP failure — ${fullMsg}`);

      throw new HttpsError("internal", e.message, { smtpResponse, smtpCode, smtpCommand });
    }
  }

  if (!["start", "stop"].includes(action)) {
    throw new HttpsError("invalid-argument", "action must be 'start' or 'stop'.");
  }

  await db.collection("adminLogs").add({
    ts:        FieldValue.serverTimestamp(),
    type:      "impersonation",
    action:    action === "start"
                 ? `started impersonating ${targetName || targetUid}`
                 : "stopped impersonating",
    targetUid: targetUid || null,
    adminUid:  request.auth.uid,
    adminName: callerSnap.data()?.name || "Unknown",
  });

  return { success: true };
});

/* ── SEND ADMIN PUSH NOTIFICATION ───────────────────────────────────────────
 * Triggered when an admin sets status → "queued" on an adminNotifications doc.
 * Queries users by audience filter, sends FCM push to all their tokens,
 * then updates the doc to status "sent" with recipient counts.
 *
 * Using a Firestore trigger instead of onCall avoids needing
 * roles/functions.admin to set IAM invoker policies.
 * ────────────────────────────────────────────────────────────────────────── */
exports.sendAdminPush = onDocumentWritten("adminNotifications/{notifId}", async (event) => {
  const after = event.data?.after?.data();
  const before = event.data?.before?.data();

  // Only fire when status transitions to "queued"
  if (!after || after.status !== "queued" || before?.status === "queued") return;
  if (after.type !== "push") return;

  const notifId = event.params.notifId;
  const audience = after.audience || "all";

  // Fetch all users
  const allUsersSnap = await db.collection("users").get();
  let userDocs = allUsersSnap.docs;

  // Apply audience filter
  if (audience === "_test_single_uid") {
    userDocs = userDocs.filter(d => d.id === after.testUid);
  } else if (audience === "google") {
    userDocs = userDocs.filter(d => d.data().loginProvider === "google");
  } else if (audience !== "all") {
    userDocs = userDocs.filter(d => {
      const plan = d.data().subscription?.plan || "free";
      return plan === audience;
    });
  }

  // Collect all unique tokens
  const tokenSet = new Set();
  for (const d of userDocs) {
    const data = d.data();
    (data.fcmTokens || []).forEach(t => tokenSet.add(t));
    (data.nativePushTokens || []).forEach(t => tokenSet.add(t));
  }
  const tokens = [...tokenSet].filter(Boolean);

  let successCount = 0;
  const batchSize = 500;
  for (let i = 0; i < tokens.length; i += batchSize) {
    const batch = tokens.slice(i, i + batchSize);
    try {
      const res = await messaging.sendEachForMulticast({
        tokens: batch,
        notification: { title: after.title, body: after.body },
        data: { type: "admin_notification", notificationId: notifId },
      });
      successCount += res.successCount;
    } catch { /* skip failed batches */ }
  }

  await db.doc(`adminNotifications/${notifId}`).update({
    status: "sent",
    sentAt: FieldValue.serverTimestamp(),
    recipientCount: userDocs.length,
    tokensSent: successCount,
  });
});

/* ── EMAIL HELPERS ───────────────────────────────────────────────────────────
 * Creates a nodemailer transporter from SMTP secrets and sends an email.
 * Silently skips if secrets aren't configured yet (returns false).
 * ────────────────────────────────────────────────────────────────────────── */
const nodemailer = require("nodemailer");

async function sendEmail({ to, subject, html }) {
  let cfg = {};
  try {
    const cfgDoc = await db.doc("adminConfig/smtp").get();
    if (cfgDoc.exists) cfg = cfgDoc.data() || {};
  } catch (e) {
    await writeErrorLog(`[sendEmail] Could not read adminConfig/smtp: ${e.message}`);
  }

  const host = cfg.host;
  const user = cfg.user;
  const pass = cfg.pass;
  if (!host || !user || !pass) return false;
  const port      = parseInt(cfg.port || "587", 10);
  const fromEmail = cfg.fromEmail || user;
  const fromName  = cfg.fromName  || "Mahjong Club";

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });

  // Throws on failure — callers are responsible for logging the error details
  await transporter.sendMail({ from: `"${fromName}" <${fromEmail}>`, to, subject, html });
  return true;
}

function applyTemplate(html, vars) {
  return Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{{${k}}}`, v ?? ""), html);
}

/* ── SEND ADMIN EMAIL BLAST ──────────────────────────────────────────────────
 * Triggered when an admin sets status → "queued" on a type:"email" notification.
 * Fans out individual emails to all matching users via SMTP.
 * ────────────────────────────────────────────────────────────────────────── */
exports.sendAdminEmail = onDocumentWritten(
  { document: "adminNotifications/{notifId}" },
  async (event) => {
    const after  = event.data?.after?.data();
    const before = event.data?.before?.data();
    if (!after || after.status !== "queued" || before?.status === "queued") return;
    if (after.type !== "email") return;

    const notifId  = event.params.notifId;
    const audience = after.audience || "all";

    // Safety net — ensures status is always resolved even on unexpected crashes
    const resolveStatus = async (status, extra = {}) => {
      try {
        await db.doc(`adminNotifications/${notifId}`).update({
          status,
          sentAt: FieldValue.serverTimestamp(),
          ...extra,
        });
      } catch (e) {
        await writeErrorLog(`[sendAdminEmail] Failed to update notification status: ${e.message}`);
      }
    };

    try {
      // ── Test send — single recipient, skip user-list fetch entirely ──────
      if (audience === "_test_single") {
        const to = after.testRecipient;
        const shouldLog = after.logResults === true;

        if (shouldLog) await addAdminLog({ type: "email", message: `Test email queued to ${to || "(no recipient)"}`, subject: after.subject });

        if (!to) {
          await resolveStatus("error", { error: "No test recipient specified." });
          return;
        }

        // Read SMTP config so we can surface details in the error
        let cfg = {};
        try {
          const cfgDoc = await db.doc("adminConfig/smtp").get();
          if (cfgDoc.exists) cfg = cfgDoc.data() || {};
        } catch (e) {
          // cfg stays empty; missing fields check below will surface the error
        }
        const missing = ["host", "user", "pass"].filter(k => !cfg[k]);
        if (missing.length) {
          const errMsg = `SMTP settings incomplete — missing: ${missing.join(", ")}`;
          if (shouldLog) await addAdminLog({ type: "error", message: errMsg });
          await resolveStatus("error", { error: errMsg, smtpResponse: "" });
          return;
        }

        try {
          await sendEmail({ to, subject: after.subject || after.title, html: after.body || "" });
          if (shouldLog) await addAdminLog({ type: "email", message: `Test email sent successfully to ${to}`, subject: after.subject });
          await resolveStatus("sent", { emailsSent: 1 });
        } catch (e) {
          const smtpResponse = e.response || "";
          const smtpCode     = String(e.responseCode || e.code || "");
          const smtpCommand  = e.command || "";
          const fullMsg = [
            `SMTP send failed: ${e.message}`,
            smtpCode    ? `code ${smtpCode}`       : "",
            smtpCommand ? `cmd ${smtpCommand}`      : "",
            smtpResponse ? `server: ${smtpResponse}` : "",
          ].filter(Boolean).join(" | ");
          if (shouldLog) await addAdminLog({ type: "error", message: fullMsg });
          await resolveStatus("error", { emailsSent: 0, error: e.message, smtpResponse: fullMsg });
        }
        return;
      }

      // ── Blast send ───────────────────────────────────────────────────────
      const allUsersSnap = await db.collection("users").get();
      let userDocs = allUsersSnap.docs;

      if (audience === "google") {
        userDocs = userDocs.filter(d => d.data().loginProvider === "google");
      } else if (audience !== "all") {
        userDocs = userDocs.filter(d => (d.data().subscription?.plan || "free") === audience);
      }

      await addAdminLog({ type: "email", message: `Email blast started — audience: ${audience}, recipients: ${userDocs.length}`, subject: after.subject });

      let sent = 0;
      let failed = 0;
      for (const d of userDocs) {
        const u = d.data();
        if (!u.email) continue;
        const html = applyTemplate(after.body || "", { name: u.name || "there", email: u.email });
        try {
          const ok = await sendEmail({ to: u.email, subject: after.subject || after.title, html });
          if (ok) sent++;
        } catch {
          failed++;
        }
      }

      await addAdminLog({ type: "email", message: `Email blast completed — sent: ${sent}, failed: ${failed}, audience: ${audience}`, subject: after.subject });
      await resolveStatus("sent", { recipientCount: userDocs.length, emailsSent: sent, emailsFailed: failed });

    } catch (e) {
      // Unexpected crash — log it and mark the notification so it doesn't stay stuck
      const msg = `[sendAdminEmail] Unexpected error: ${e.message}`;
      await addAdminLog({ type: "error", message: `Email function crashed: ${e.message}` });
      await writeErrorLog(msg);
      await resolveStatus("error", { error: e.message });
    }
  }
);

/* ── CUSTOM PASSWORD RESET EMAIL ─────────────────────────────────────────────
 * Triggered when the client writes to passwordResetRequests/{reqId}.
 * Generates a Firebase password reset link, loads the custom template from
 * Firestore (adminNotifications where key=="forgot_password"), and sends it.
 * Falls back to Firebase's built-in email sending if SMTP isn't configured.
 * ────────────────────────────────────────────────────────────────────────── */
exports.sendPasswordReset = onDocumentCreated(
  { document: "passwordResetRequests/{reqId}" },
  async (event) => {
    const { getAuth } = require("firebase-admin/auth");
    const adminAuth = getAuth();

    const data = event.data?.data();
    if (!data?.email) return;
    const email = data.email.trim().toLowerCase();

    // Always delete the request doc (prevent replay)
    await event.data.ref.delete();

    // Verify the account exists in Firebase Auth — if not, silently exit
    let userRecord;
    try {
      userRecord = await adminAuth.getUserByEmail(email);
    } catch {
      return; // no account — don't reveal this to the caller
    }

    // Generate the official Firebase reset link, then rewrite the domain to
    // ourmahjong.club so the URL looks clean. Firebase Hosting serves
    // /__/auth/action on all custom hosting domains automatically.
    let resetLink;
    try {
      const rawLink = await adminAuth.generatePasswordResetLink(email, {
        url: "https://ourmahjong.club",
      });
      const p = new URL(rawLink);
      resetLink = `https://ourmahjong.club/__/auth/action?mode=${p.searchParams.get("mode")}&oobCode=${encodeURIComponent(p.searchParams.get("oobCode"))}&apiKey=${encodeURIComponent(p.searchParams.get("apiKey"))}&lang=en&continueUrl=${encodeURIComponent("https://ourmahjong.club")}`;
    } catch (e) {
      const msg = `[sendPasswordReset] generatePasswordResetLink failed for ${email}: ${e.message}`;
      await addAdminLog({ type: "error", message: `Password reset link generation failed for ${email}: ${e.message}` });
      await writeErrorLog(msg);
      return;
    }

    // Load custom template from Firestore
    const tmplSnap = await db.collection("adminNotifications")
      .where("key", "==", "forgot_password")
      .limit(1)
      .get();

    const tmpl = tmplSnap.empty ? null : tmplSnap.docs[0].data();
    const subject = tmpl?.subject || "Reset your Mahjong Club password";
    const bodyHtml = tmpl?.body || `<p>Hi {{name}},</p><p>Click the link below to reset your password:</p><p><a href="{{resetLink}}">Reset Password</a></p><p>If you didn't request this, you can ignore this email.</p>`;
    const html = applyTemplate(bodyHtml, {
      name: userRecord.displayName || email.split("@")[0],
      email,
      resetLink,
    });

    try {
      await sendEmail({ to: email, subject, html });
    } catch (e) {
      // Error already logged inside sendEmail — no double-log needed
    }
  }
);

/* ── SEND TEST EMAIL (Gen 1 callable) ────────────────────────────────────────
 * Uses firebase-functions v1 API so it runs on the original Cloud Functions
 * infrastructure instead of Cloud Run, bypassing the org-policy IAM restriction
 * that blocks allUsers Cloud Run Invoker on new services.
 * ────────────────────────────────────────────────────────────────────────── */
const functionsV1 = require("firebase-functions/v1");

exports.smtpTest = functionsV1.https.onCall(async (data, context) => {
  if (!context.auth) throw new functionsV1.https.HttpsError("unauthenticated", "Sign in required.");

  let callerData = {};
  try {
    const snap = await db.doc(`users/${context.auth.uid}`).get();
    callerData = snap.data() || {};
  } catch (e) {
    throw new functionsV1.https.HttpsError("internal", `Could not read caller profile: ${e.message}`);
  }
  if (callerData.isAdmin !== true) throw new functionsV1.https.HttpsError("permission-denied", "Admins only.");

  const { to, logResults } = data || {};
  if (!to || !/\S+@\S+\.\S+/.test(to)) {
    throw new functionsV1.https.HttpsError("invalid-argument", "A valid recipient email is required.");
  }

  // Read SMTP config
  let cfg = {};
  try {
    const cfgDoc = await db.doc("adminConfig/smtp").get();
    if (cfgDoc.exists) cfg = cfgDoc.data() || {};
  } catch (e) {
    const msg = `Could not read SMTP config: ${e.message}`;
    await db.collection("adminLogs").add({ ts: FieldValue.serverTimestamp(), type: "error", message: `[SMTP test] ${msg}` }).catch(() => {});
    throw new functionsV1.https.HttpsError("internal", msg);
  }

  const missing = ["host", "user", "pass"].filter(k => !cfg[k]);
  if (missing.length) {
    const msg = `SMTP settings incomplete — missing: ${missing.join(", ")}`;
    await db.collection("adminLogs").add({ ts: FieldValue.serverTimestamp(), type: "error", message: `[SMTP test] ${msg}` }).catch(() => {});
    throw new functionsV1.https.HttpsError("failed-precondition", msg);
  }

  if (logResults) {
    await db.collection("adminLogs").add({
      ts: FieldValue.serverTimestamp(), type: "email",
      message: `[SMTP test] attempting send to ${to} via ${cfg.host}:${cfg.port || 587}`,
    }).catch(() => {});
  }

  try {
    await sendEmail({
      to,
      subject: "Mahjong Club — SMTP test",
      html: "<p>This is a test email from your Mahjong Club admin panel. If you received this, your SMTP settings are working correctly.</p>",
    });

    if (logResults) {
      await db.collection("adminLogs").add({
        ts: FieldValue.serverTimestamp(), type: "email",
        message: `[SMTP test] success — delivered to ${to}`,
      }).catch(() => {});
      await writeErrorLog(`[sendTestEmail] Success: delivered to ${to}`);
    }

    return { success: true };

  } catch (e) {
    const smtpResponse = e.response     || "";
    const smtpCode     = String(e.responseCode || e.code || "");
    const smtpCommand  = e.command      || "";

    const fullMsg = [
      `[SMTP test] failed to ${to}: ${e.message}`,
      smtpCode     ? `SMTP code: ${smtpCode}`      : "",
      smtpCommand  ? `SMTP cmd: ${smtpCommand}`     : "",
      smtpResponse ? `Server: ${smtpResponse}`      : "",
    ].filter(Boolean).join(" | ");

    await db.collection("adminLogs").add({
      ts: FieldValue.serverTimestamp(), type: "error",
      message: fullMsg, smtpCode, smtpCommand, smtpResponse,
    }).catch(() => {});

    if (logResults) await writeErrorLog(`[sendTestEmail] SMTP failure — ${fullMsg}`);

    throw new functionsV1.https.HttpsError("internal", e.message, { smtpResponse, smtpCode, smtpCommand });
  }
});

/* ── ARCHIVE CLEANUP (runs daily) ──────────────────────────────────────────
 * Deletes archived groups and archived games that meet both conditions:
 *   1. archivedAt  > 60 days ago  (been archived long enough)
 *   2. updatedAt   > 10 days ago  (not recently modified)
 *
 * For groups: also deletes all sub-collections (games, messages) and any
 * gameCodes entries that reference deleted games.
 * For games within active groups: deletes the game doc and its gameCodes entry.
 * ────────────────────────────────────────────────────────────────────────── */
exports.archiveCleanup = onSchedule("every 24 hours", async () => {
  const now = Date.now();
  const sixtyDaysAgo = now - 60 * 24 * 60 * 60 * 1000;
  const tenDaysAgo   = now - 10 * 24 * 60 * 60 * 1000;

  let deletedGroups = 0;
  let deletedGames  = 0;

  // ── 1. Archived groups ─────────────────────────────────────────────────
  const archivedGroupsSnap = await db.collection("groups")
    .where("status", "==", "archived")
    .get();

  for (const groupDoc of archivedGroupsSnap.docs) {
    const g = groupDoc.data();
    const archivedAt = g.archivedAt?.toMillis?.() ?? 0;
    const updatedAt  = g.updatedAt?.toMillis?.()  ?? 0;

    if (archivedAt > sixtyDaysAgo) continue;  // not old enough
    if (updatedAt  > tenDaysAgo)   continue;  // recently modified

    // Delete sub-collections: games (and their messages), messages
    const gamesSnap = await groupDoc.ref.collection("games").get();
    for (const gameDoc of gamesSnap.docs) {
      // Delete game chat messages
      const gameMsgSnap = await gameDoc.ref.collection("messages").get();
      const msgBatch = db.batch();
      gameMsgSnap.docs.forEach((d) => msgBatch.delete(d.ref));
      if (!gameMsgSnap.empty) await msgBatch.commit();

      // Delete gameCodes entry if present
      const code = gameDoc.data().joinCode;
      if (code) {
        try { await db.doc(`gameCodes/${code}`).delete(); } catch (_) { /* ok */ }
      }

      await gameDoc.ref.delete();
    }

    // Delete group chat messages
    const groupMsgSnap = await groupDoc.ref.collection("messages").get();
    const gmBatch = db.batch();
    groupMsgSnap.docs.forEach((d) => gmBatch.delete(d.ref));
    if (!groupMsgSnap.empty) await gmBatch.commit();

    // Delete the group document
    await groupDoc.ref.delete();
    deletedGroups++;
  }

  // ── 2. Archived games within active groups ─────────────────────────────
  const archivedGamesSnap = await db.collectionGroup("games")
    .where("status", "==", "archived")
    .get();

  for (const gameDoc of archivedGamesSnap.docs) {
    const game = gameDoc.data();
    const archivedAt = game.archivedAt?.toMillis?.() ?? 0;
    const updatedAt  = game.updatedAt?.toMillis?.()  ?? 0;

    if (archivedAt > sixtyDaysAgo) continue;
    if (updatedAt  > tenDaysAgo)   continue;

    // Check parent group still exists (skip if already deleted in step 1)
    const parentGroupRef = gameDoc.ref.parent.parent;
    const parentSnap = await parentGroupRef.get();
    if (!parentSnap.exists) continue;

    // Delete game chat messages
    const gameMsgSnap = await gameDoc.ref.collection("messages").get();
    const msgBatch = db.batch();
    gameMsgSnap.docs.forEach((d) => msgBatch.delete(d.ref));
    if (!gameMsgSnap.empty) await msgBatch.commit();

    // Delete gameCodes entry if present
    const code = game.joinCode;
    if (code) {
      try { await db.doc(`gameCodes/${code}`).delete(); } catch (_) { /* ok */ }
    }

    await gameDoc.ref.delete();
    deletedGames++;
  }

  await writeErrorLog(`archiveCleanup complete — deleted ${deletedGroups} groups, ${deletedGames} games`);
});
