# Figma MCP Integration Rules — Mahjong Club

This document describes the design system, component patterns, and styling conventions of this codebase to guide accurate Figma-to-code (and code-to-Figma) integration via the Model Context Protocol.

---

## 1. Project Overview

- **Stack**: React 18 + Vite 6, single-page app
- **All app code**: `src/App.jsx` — one large file (~9,000 lines); no separate component files
- **Styling**: 100% inline styles + CSS custom properties (CSS variables); no CSS Modules, no Tailwind, no styled-components
- **Fonts**: Inter (all weights 400–900) + Shippori Mincho 700 (display use), loaded via Google Fonts at runtime per-theme
- **Platform targets**: Web PWA + iOS (Capacitor) + Android (Capacitor)
- **Mobile-first**: App shell is capped at 480px wide, centered on desktop

---

## 2. Design Token System

### Location
`src/theme.js` — single source of truth for all design tokens.

### Structure
Each theme is a flat JS object. Token keys are camelCase; they are converted to kebab-case CSS custom properties by `buildCSSVars()` and injected into `:root` via a `<style>` tag at runtime.

**Example mapping:**
```
primaryDark → --primary-dark
bgShellStart → --bg-shell-start
shadowRgb → --shadow-rgb
```

### Token Categories (all themes share the same keys)

| Category | Token examples |
|---|---|
| **Primary palette** | `primary`, `primaryDark`, `primaryMuted`, `primarySubtle`, `primaryFaint`, `secondaryAccent` |
| **RGB channels** | `primaryRgb`, `shadowRgb`, `borderLightRgb`, `cardAltRgb` — used for `rgba(var(--primary-rgb), 0.25)` patterns |
| **Backgrounds** | `bgBody`, `bgShellStart/Mid/End`, `bgNav`, `bgInput`, `bgCard`, `bgCardAlt`, `bgCardBase`, `bgSurface`, `bgMsgOther`, `bgPopup`, `dateBlockBg` |
| **Input states** | `inputSelectedBg`, `inputUnselectedBg` |
| **Borders** | `borderInput`, `borderNav`, `borderCard` |
| **Text** | `textBody`, `textHeading`, `textMuted`, `textSubtle`, `sectionTitle` |
| **Shadows** | `shadowPrimary`, `shadowCard`, `shadowBtn`, `shadowInset` |
| **Gradients** | `headerGradient`, `headerGradient2`, `activeTabGradient`, `avatarBubbleBg`, `chatSheetBg` |
| **Admin** | `adminDeep`, `adminMid`, `adminLight`, `adminMuted` |
| **Typography** | `fontBody`, `fontDisplay`, `googleFontUrl` |
| **Border radii** | `radiusInput`, `radiusCard`, `radiusCardSm`, `radiusBtn` (999px = pill), `radiusBtnSm`, `radiusSheet` |
| **Scrollbar** | `scrollbarThumb` |

### Available Themes

| ID | Name | Emoji | Character |
|---|---|---|---|
| `sakura` | Flowers | 🌸 | Pink/rose, light mode |
| `forest` | Bam Bird | 🐦 | Forest green, light mode |
| `jadeDragon` | Dragons | 🐉 | Gold + peacock teal, dark mode |
| `tiles` | Tiles | 💠 | Cobalt blue porcelain, light mode |

### How to use tokens in designs
Reference every color, radius, and shadow as a CSS variable rather than a hardcoded value. Examples:

```css
/* Color */
color: var(--text-body);
background: var(--bg-card);

/* Radius */
border-radius: var(--radius-card);

/* Shadow with opacity via RGB channel token */
box-shadow: 0 4px 16px rgba(var(--shadow-rgb), 0.18);

/* Gradient */
background: var(--header-gradient);
```

---

## 3. Component Architecture

### Patterns
- All components are plain React functions defined in `src/App.jsx`
- No external component library (no MUI, no Shadcn, no Radix)
- Styles are **always inline** (`style={{ ... }}`), referencing CSS variables via `var(--token)`
- A handful of animation classes (`bIn`, `sUp`) are defined in `buildGlobalCSS` and applied via `className`

### Primitive / Utility Components

These small components are the building blocks. Match them when generating Figma components:

```jsx
// Shell — page-level wrapper with gradient header + back button
Shell({ title, onBack, color, children })
// Header: var(--header-gradient), padding top = 74px (iOS) or 14px (web)
// Content: var(--bg-surface), blur(16px) backdrop, padding 20px 16px

// Lbl — uppercase field label
// fontSize 13, fontWeight 700, color var(--primary-subtle), letterSpacing 0.5

// SecLbl — secondary uppercase label
// fontSize 12, fontWeight 700, color var(--primary-faint), letterSpacing 1

// Fld — text input (wraps <input> with inputSt)
Fld({ value, set, placeholder })

// Btn — primary action button
Btn({ children, onClick, full, sm, outline, danger, disabled, style })
// Full pill: radius var(--radius-btn) = 999px
// Background: var(--primary) | transparent (outline) | #e5e5e5 (disabled)
// Shadow: 0 4px 16px var(--shadow-btn)
// sm variant: padding 7px 14px, fontSize 13

// Chip — small status/tag badge
Chip({ children, color, big })
// background: color + "18" (10% opacity), color = text color, radius var(--radius-btn)

// IRow — info row with icon
IRow({ icon, label, val })
// Card-styled row: var(--bg-card)/var(--bg-card-alt) gradient, radius var(--radius-card-sm)
```

### Shared Style Objects

```js
// src/App.jsx:428 — the canonical text input style
const inputSt = {
  width: "100%",
  padding: "12px 14px",
  background: "var(--bg-input)",
  borderRadius: "var(--radius-input)",
  fontSize: 16,
  fontWeight: 600,
  marginBottom: 6,
  border: "2px solid var(--border-input)",
  color: "var(--text-body)",
  display: "block",
  boxSizing: "border-box",
  WebkitAppearance: "none",
  appearance: "none",
};
```

### Key Page/Screen Components

| Component | Route key | Purpose |
|---|---|---|
| `App` (default export) | root | Auth gate + shell + bottom nav |
| `Home` | `home` | Dashboard with game cards + floating tiles animation |
| `GamesPage` | `games` | Full games list (upcoming + past) |
| `GroupsPage` | `groups` | Group list |
| `Account` | `account` | Profile, theme picker, plan, notifications |
| `Game` | `game` | Game detail + RSVP + waitlist + seating |
| `Group` | `group` | Group detail + member management |
| `NewGame` | `newGame` | Create/edit game form |
| `NewGroup` | `newGroup` | Create group form |
| `AdminHub` / `AdminUsers` / etc. | admin* | Admin panels |

### Navigation
```js
go(page, param1, param2)
// No React Router — page is a string, params stored in state
// Bottom nav: Home / Games / Groups / Account tabs
```

---

## 4. App Shell & Layout

```
┌─────────────────────── .app-shell (max 480px, centered) ──┐
│  Linear gradient: bgShellStart → bgShellMid → bgShellEnd  │
│                                                            │
│  [Scrollable content area — flex: 1, overflow-y: auto]    │
│                                                            │
│  [.bottom-nav — flex-shrink: 0, bgNav, blur(20px)]        │
└────────────────────────────────────────────────────────────┘
```

- **App shell**: `.app-shell` class, `100vw` capped to 480px, full `100dvh`
- **Content scroll container**: `height: 100%`, `overflow-y: auto`, `-webkit-overflow-scrolling: touch`
- **Bottom nav**: `background: var(--bg-nav)`, `border-top: 1px solid var(--border-nav)`, `padding-bottom: env(safe-area-inset-bottom)`
- **Desktop**: shell floats as a card with `box-shadow: 0 0 60px var(--shadow-primary)`
- **iOS safe area**: headers use hardcoded `paddingTop: 74px` (Dynamic Island); bottom nav uses `env(safe-area-inset-bottom)`

---

## 5. Card Pattern

Every card in the app follows this pattern:

```jsx
<div style={{
  background: "linear-gradient(135deg, var(--bg-card), var(--bg-card-alt))",
  backdropFilter: "blur(10px)",
  WebkitBackdropFilter: "blur(10px)",
  borderRadius: "var(--radius-card)",       // 18px (20px for Dragons)
  border: "1px solid var(--border-card)",
  boxShadow: "0 4px 16px var(--shadow-card), inset 0 1px 0 var(--shadow-inset)",
  padding: "14px 16px",
}}>
```

- **GameCard** (src/App.jsx:3718) — date block left + content right; date block uses `var(--date-block-bg)` with border `rgba(var(--primary-rgb), 0.20)`
- **Small cards** (IRow, settings rows): `var(--radius-card-sm)` (14px / 16px for Dragons)

---

## 6. Header / Navigation Bar Pattern

```jsx
// Full-bleed gradient header (used in Shell component)
{
  background: "var(--header-gradient)",       // or headerGradient2 for depth
  backdropFilter: "blur(12px)",
  padding: `${HEADER_BTN_TOP}px 22px 22px`,  // 74px iOS, 14px web
  boxShadow: "0 8px 32px rgba(var(--shadow-rgb), 0.40)",
}

// Shine overlay (always added inside header)
{
  position: "absolute", inset: 0,
  background: "linear-gradient(135deg, rgba(255,255,255,0.07) 0%, transparent 60%)",
  pointerEvents: "none",
}

// Back button
{
  background: "rgba(255,255,255,.28)",
  border: "1px solid rgba(255,255,255,.4)",
  borderRadius: 999,
  width: 36, height: 36,
  backdropFilter: "blur(8px)",
}
```

---

## 7. Typography Scale

All text uses `Inter`. No separate display font in practice (Shippori Mincho loaded but rarely used).

| Role | Size | Weight | Color token |
|---|---|---|---|
| Page title (header) | 24px | — | #fff (on gradient) |
| Card title / game title | 16px | 700 | `var(--text-body)` |
| Section label (Lbl) | 13px | 700 | `var(--primary-subtle)` |
| Secondary label (SecLbl) | 12px | 700 | `var(--primary-faint)` |
| Body text | 15–16px | 400–600 | `var(--text-body)` |
| Muted text | 13px | 400–500 | `var(--text-muted)` |
| Uppercase caps (Chip, nav) | 9–12px | 700–800 | varies, often `var(--primary)` |
| Button text | 13px (sm) / 15px | 700 | #fff or `var(--primary)` |
| Date block (month/dow) | 9px | 700 | `var(--primary)` |
| Date block (day number) | 24px | 700 | `var(--text-body)` |

---

## 8. Animations

Defined in `buildGlobalCSS` (src/App.jsx:445), applied via className:

| Class | Keyframe | Use |
|---|---|---|
| `.bIn` | scale 0.7→1.06→1, opacity 0→1 | Flash messages, modals entering |
| `.sUp` | translateY(28px)→0, opacity 0→1 | Page content, card lists |

Floating tile animation on Home screen: `f0`, `f1`, `f2` keyframes for 3 tiles with independent timing.

Sheet modals use `sheetUp`: `translateX(-50%) translateY(100%)` → `translateY(0)`.

---

## 9. Icon System

- **No icon library** — all icons are Unicode emoji characters rendered as text/spans
- Common icons: `‹` (back), `›` (forward), `✕` (close), `+` (add), `🀄` (logo)
- Status badges use short text strings ("Hosting", "Waitlisted", "Full", etc.) styled as `Chip` components
- Avatar system: single emoji character stored per user (e.g. `🐼`, `🦋`)

---

## 10. Color Semantic Usage

When implementing Figma designs, map Figma color styles to these tokens:

| Semantic role | CSS variable |
|---|---|
| Primary action / brand | `var(--primary)` |
| Active gradient (tabs, CTA buttons) | `var(--active-tab-gradient)` |
| Page/shell background | `var(--bg-shell-start/mid/end)` (gradient) |
| Card background | `var(--bg-card)` + `var(--bg-card-alt)` (gradient) |
| Input background | `var(--bg-input)` |
| Nav background | `var(--bg-nav)` |
| Body text | `var(--text-body)` |
| Heading text | `var(--text-heading)` |
| Muted / secondary text | `var(--text-muted)` |
| Dividers / card borders | `var(--border-card)` |
| Input borders | `var(--border-input)` |
| Card drop shadow | `var(--shadow-card)` |
| Button shadow | `var(--shadow-btn)` |

---

## 11. Asset Management

- Static assets: `public/` directory
- App icons: `public/icon-192.png`, `public/icon-512.png`
- No image CDN; images are mostly emoji + Firebase Storage for user avatars (accessed via `firebase/storage`)
- No SVG sprite sheet; no bundled icon set
- Vite handles asset fingerprinting on build

---

## 12. Responsive Strategy

- Mobile-first, single breakpoint at 520px
- Below 520px: full-width app shell
- Above 520px: shell floats centered, max 480px, with drop shadow
- No component-level media queries — layout is fixed-width mobile within the 480px shell
- iOS safe areas handled with `env(safe-area-inset-*)` for bottom nav, hardcoded px for top headers

---

## 13. Rules for Generating Code from Figma Designs

1. **Always use CSS variables** — never hardcode theme colors. Map Figma color styles to the token table above.
2. **Use inline `style` props** — this codebase has no CSS files, no Tailwind classes; all styles go in `style={{ ... }}`.
3. **Reference `var(--radius-*)` for corners** — never hardcode border-radius values.
4. **Card blur**: always pair `backdropFilter: "blur(10px)"` with `WebkitBackdropFilter: "blur(10px)"` for iOS support.
5. **No new files for components** — add functions to `src/App.jsx`. No separate component files.
6. **Fonts**: always specify `fontFamily: "var(--font-body)"` or `"'Inter',sans-serif"` — never omit it.
7. **Shadows**: use the two-layer pattern: `box-shadow: "0 4px 16px var(--shadow-card), inset 0 1px 0 var(--shadow-inset)"`.
8. **Gradients on cards**: `background: "linear-gradient(135deg, var(--bg-card), var(--bg-card-alt))"` — don't use flat `var(--bg-card)` alone.
9. **RSVP/status colors** are hardcoded per-semantic: yes=green, no=red, maybe=a distinct color (check `jadeDragon` dark theme for contrast-safe values).
10. **Do not reference `sakura` theme values directly** — only use CSS variables so all 4 themes work.
