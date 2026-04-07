/**
 * Mahjong Club — Firebase Cloud Functions
 * Sends push notifications via FCM for:
 *   1. New chat messages in a group
 *   2. New games added to a group
 *
 * DEPLOY:
 *   npm install -g firebase-tools
 *   firebase login
 *   firebase use mahjong-club-da606
 *   cd functions && npm install
 *   firebase deploy --only functions
 */

const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");

initializeApp();
const db = getFirestore();
const messaging = getMessaging();

/** Fetch all FCM tokens for a list of user IDs */
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
  return [...new Set(tokens)]; // deduplicate
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

// ── 1. New chat message ──────────────────────────────────────────────────────
exports.onNewChatMessage = onDocumentCreated(
  "groups/{groupId}/messages/{messageId}",
  async (event) => {
    const msg = event.data.data();
    const { groupId } = event.params;

    // Get group membership
    const groupSnap = await db.doc(`groups/${groupId}`).get();
    if (!groupSnap.exists) return;
    const group = groupSnap.data();

    // Notify all members except the sender
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

    // Only act when a reply was actually added
    if (newReplies.length <= prevReplies.length) return;

    const latestReply = newReplies[newReplies.length - 1];
    const senderUid   = latestReply.uid;
    const { groupId }  = event.params;

    // Notify: original message author + everyone who replied before (thread participants)
    // — excluding the person who just replied
    const threadUids = [
      after.uid,                          // original message author
      ...prevReplies.map((r) => r.uid),   // prior reply authors
    ];
    const recipients = [...new Set(threadUids)].filter((id) => id !== senderUid);
    if (!recipients.length) return;

    // Get group name for context
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

// ── 3. New game created ──────────────────────────────────────────────────────
exports.onNewGame = onDocumentCreated(
  "groups/{groupId}/games/{gameId}",
  async (event) => {
    const game = event.data.data();
    const { groupId } = event.params;

    // Get group metadata
    const groupSnap = await db.doc(`groups/${groupId}`).get();
    if (!groupSnap.exists) return;
    const group = groupSnap.data();

    // Notify members who are part of this game
    const gameMembers = [
      ...(game.memberIds || []),
      ...Object.keys(game.rsvps || {}),
      ...(game.guestIds || []),
    ];
    const recipients = [...new Set(gameMembers)];
    const tokens = await getTokensForUsers(recipients);

    // Format date
    const dateStr = game.date
      ? new Date(game.date).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })
      : "";

    await sendToTokens(
      tokens,
      {
        title: `New game: ${game.title}`,
        body: `${group.name} · ${dateStr}${game.time ? " · " + game.time : ""}`,
      },
      { type: "game", groupId, gameId: event.params.gameId }
    );
  }
);
