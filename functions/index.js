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

const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");
const { getAuth } = require("firebase-admin/auth");

const STRIPE_SECRET_KEY    = defineSecret("STRIPE_SECRET_KEY");
const STRIPE_WEBHOOK_SECRET = defineSecret("STRIPE_WEBHOOK_SECRET");

initializeApp();
const db = getFirestore();
const messaging = getMessaging();

/**
 * Fetch the right push tokens for a list of user IDs.
 *
 * Token strategy (prevents duplicate notifications):
 *   - nativePushTokens present → use those only (user has the native app)
 *   - no native tokens         → fall back to web fcmTokens
 *
 * This ensures a user with both the web app and native app installed
 * only receives one notification, delivered via the better channel.
 */
async function getTokensForUsers(userIds) {
  if (!userIds.length) return [];
  const chunks = [];
  for (let i = 0; i < userIds.length; i += 10) chunks.push(userIds.slice(i, i + 10));
  const tokens = [];
  for (const chunk of chunks) {
    const snaps = await Promise.all(chunk.map((uid) => db.doc(`users/${uid}`).get()));
    snaps.forEach((snap) => {
      const data = snap.data();
      if (data?.notificationsEnabled !== true) return;
      const native = data?.nativePushTokens || [];
      const web    = data?.fcmTokens        || [];
      tokens.push(...(native.length > 0 ? native : web));
    });
  }
  return [...new Set(tokens)];
}

/** Send FCM messages in batches of 500 */
async function sendToTokens(tokens, notification, data = {}) {
  if (!tokens.length) return;
  const batches = [];
  for (let i = 0; i < tokens.length; i += 500) batches.push(tokens.slice(i, i + 500));
  for (const batch of batches) {
    await messaging.sendEachForMulticast({ tokens: batch, notification, data });
  }
}

/** Format a ms timestamp for display */
function fmtDate(ms) {
  return new Date(ms).toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric",
  });
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
    const tokens = await getTokensForUsers(recipients);

    await sendToTokens(
      tokens,
      {
        title: `${msg.name} in ${group.name}`,
        body: msg.text?.length > 100 ? msg.text.slice(0, 97) + "…" : msg.text,
      },
      { type: "chat", groupId, messageId: event.params.messageId }
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

    const tokens = await getTokensForUsers(recipients);
    const body = latestReply.text?.length > 100
      ? latestReply.text.slice(0, 97) + "…"
      : latestReply.text;

    await sendToTokens(
      tokens,
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

    const tokens = await getTokensForUsers(recipients);
    await sendToTokens(
      tokens,
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

    const tokens = await getTokensForUsers(newMembers);
    await sendToTokens(
      tokens,
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

    // Derive groupId from the document path: groups/{groupId}/games/{gameId}
    const groupId = gameDoc.ref.parent.parent.id;

    const groupSnap = await db.doc(`groups/${groupId}`).get();
    const groupName = groupSnap.data()?.name || "your group";

    // Notify all members plus anyone who RSVP'd yes
    const rsvpYes = Object.entries(game.rsvps || {})
      .filter(([, v]) => v === "yes")
      .map(([uid]) => uid);
    const recipients = [...new Set([...(game.memberIds || []), ...rsvpYes])];

    const tokens = await getTokensForUsers(recipients);
    sends.push(
      sendToTokens(
        tokens,
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
      console.error("Webhook signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
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
          if (!uid) { console.warn("No uid found for checkout session", obj.id); break; }

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
          console.log(`✓ checkout.session.completed — uid=${uid} plan=${planKey} trial=${isTrial}`);
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
          console.log(`✓ subscription cancelled — uid=${uid} → free plan`);
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
          console.log(`Unhandled Stripe event: ${event.type}`);
      }
    } catch (err) {
      console.error("Error processing Stripe event:", err);
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

    console.log(`✓ cancelSubscription — uid=${uid} → free plan`);
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

  console.log(`archiveCleanup complete — deleted ${deletedGroups} groups, ${deletedGames} games`);
});
