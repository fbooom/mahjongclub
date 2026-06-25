# Mahjong Club — Claude Notes

## Project
- React + Vite SPA, deployed to Firebase Hosting
- Firebase project: `mahjong-club-da606`
- Live URL: https://ourmahjong.club (also https://mahjong-club-da606.web.app)
- All app code lives in `src/App.jsx` (single large file)

## Deploying

After every code change, always run BOTH commands:
```
npm run deploy && npm run sync
```

- `npm run deploy` — builds with Vite and pushes to Firebase Hosting (web app)
- `npm run sync` — builds with Vite and copies assets into the iOS bundle (`ios/App/App/public/`)

Both must run together so web and iOS are never out of sync. After `npm run sync`, tell the user to do **Shift+Cmd+K (Clean Build Folder)** in Xcode, then rebuild.

**Auth:** Firebase CLI uses OAuth credentials stored in `~/.config/firebase/` (set via `firebase login`). If deploy fails with an auth error, the user must run `firebase login --reauth` once. Do not claim an auth fix is in place until a real deploy is confirmed successful.

**Do not:**
- Run only `npm run deploy` without also running `npm run sync` — iOS will miss the change
- Tell the user a fix is working before running both commands and confirming deploy succeeds
- Assume `GOOGLE_APPLICATION_CREDENTIALS` is sufficient — the stored OAuth credentials from `firebase login` are what Firebase CLI actually uses for this project

## iOS deploy workflow
**Do not run `npm run deploy:ios` or any xcodebuild/xcrun commands.** CLI-based Xcode deploys corrupt margins on device. The user deploys to iOS manually via a full rebuild in Xcode.

After running `npm run sync`, tell the user to Clean Build Folder (Shift+Cmd+K) in Xcode and rebuild.

## General rules
- When adding, updating, or removing files, clean up after yourself — remove stale references, orphaned build inputs, duplicate files, and dead imports left behind by the change

## Code conventions
- Single-file React app — all components and pages are functions defined in `src/App.jsx`
- Navigation is page-based via `go(page, param1, param2)` — no React Router, no modal state for full-page views
- Firestore is the database; groups are top-level collections, games are subcollections under groups
- `NOW = Date.now()` constant used throughout for date comparisons
- Status field: `"archived"` and `"deleted"` are the two non-active statuses for both groups and games
