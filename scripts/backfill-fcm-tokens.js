/**
 * One-time migration: add fcmTokens: [] to every user document that doesn't
 * already have the field.
 *
 * Usage:
 *   node scripts/backfill-fcm-tokens.js
 *
 * Requirements:
 *   - Firebase Admin SDK: npm install firebase-admin   (or use the one in functions/)
 *   - A service account key downloaded from Firebase Console
 *     → Project Settings → Service Accounts → Generate new private key
 *     Save it as scripts/serviceAccountKey.json  (already in .gitignore)
 *
 * The script uses batched writes (max 500 per batch) so it works for any
 * number of users without hitting Firestore limits.
 */

const admin = require("../functions/node_modules/firebase-admin");
const fs = require("fs");
const path = require("path");

// ── Service account ───────────────────────────────────────────────────────────
const keyPath = path.join(__dirname, "serviceAccountKey.json");
if (!fs.existsSync(keyPath)) {
  console.error(
    "\nERROR: Service account key not found at scripts/serviceAccountKey.json\n" +
    "  1. Go to Firebase Console → Project Settings → Service Accounts\n" +
    "  2. Click 'Generate new private key'\n" +
    "  3. Save the downloaded file as scripts/serviceAccountKey.json\n"
  );
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(require(keyPath)),
});

const db = admin.firestore();

async function backfill() {
  console.log("Fetching all user documents…");
  const snapshot = await db.collection("users").get();
  console.log(`Found ${snapshot.size} users.`);

  const toUpdate = snapshot.docs.filter(
    (doc) => !Array.isArray(doc.data().fcmTokens)
  );
  console.log(`${toUpdate.length} users need fcmTokens field added.`);

  if (toUpdate.length === 0) {
    console.log("Nothing to do — all users already have fcmTokens.");
    return;
  }

  // Firestore batch writes are capped at 500 operations each
  const BATCH_SIZE = 500;
  let processed = 0;

  for (let i = 0; i < toUpdate.length; i += BATCH_SIZE) {
    const chunk = toUpdate.slice(i, i + BATCH_SIZE);
    const batch = db.batch();
    chunk.forEach((doc) => {
      batch.update(doc.ref, { fcmTokens: [] });
    });
    await batch.commit();
    processed += chunk.length;
    console.log(`  Updated ${processed} / ${toUpdate.length}`);
  }

  console.log(`Done. ${toUpdate.length} users updated.`);
}

backfill().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
