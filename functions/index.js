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
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");

initializeApp();
const db = getFirestore();
const messaging = getMessaging();

/** Fetch all FCM tokens for a list of user IDs (only users with notifications enabled) */
async function getTokensForUsers(userIds) {
  if (!userIds.length) return [];
  const chunks = [];
  for (let i = 0; i < userIds.length; i += 10) chunks.push(userIds.slice(i, i + 10));
  const tokens = [];
  for (const chunk of chunks) {
    const snaps = await Promise.all(chunk.map((uid) => db.doc(`users/${uid}`).get()));
    snaps.forEach((snap) => {
      const fcmTokens = snap.data()?.fcmTokens || [];
      const enabled = snap.data()?.notificationsEnabled === true;
      if (enabled) tokens.push(...fcmTokens);
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
