# Mahjong Club — Claude Notes

## Project
- React + Vite SPA, deployed to Firebase Hosting
- Firebase project: `mahjong-club-da606`
- Live URL: https://ourmahjong.club (also https://mahjong-club-da606.web.app)
- All app code lives in `src/App.jsx` (single large file)

## Deploying

Run:
```
npm run deploy
```

This builds with Vite and pushes to Firebase Hosting. The deploy script explicitly unsets `FIREBASE_TOKEN` before running so stale session tokens never block deploys.

**Auth:** Firebase CLI uses OAuth credentials stored in `~/.config/firebase/` (set via `firebase login`). If deploy fails with an auth error, the user must run `firebase login --reauth` once. Do not claim an auth fix is in place until a real deploy is confirmed successful.

**Do not:**
- Tell the user a fix is working before running `npm run deploy` and confirming it succeeds
- Assume `GOOGLE_APPLICATION_CREDENTIALS` is sufficient — the stored OAuth credentials from `firebase login` are what Firebase CLI actually uses for this project

## General rules
- When adding, updating, or removing files, clean up after yourself — remove stale references, orphaned build inputs, duplicate files, and dead imports left behind by the change

## Code conventions
- Single-file React app — all components and pages are functions defined in `src/App.jsx`
- Navigation is page-based via `go(page, param1, param2)` — no React Router, no modal state for full-page views
- Firestore is the database; groups are top-level collections, games are subcollections under groups
- `NOW = Date.now()` constant used throughout for date comparisons
- Status field: `"archived"` and `"deleted"` are the two non-active statuses for both groups and games
