/**
 * Mahjong Club — Theme System
 *
 * Each theme defines a set of design tokens. The active theme is converted
 * into CSS custom properties injected into :root, so every component can
 * reference `var(--token-name)` in both CSS and inline style props.
 *
 * To add a new theme:
 *   1. Copy the `sakura` object below and change the values.
 *   2. Add it to the `themes` map with a unique key.
 *   3. Pass the key to `buildCSSVars()` in App.jsx (or add a theme picker).
 */

// ── Default theme: Sakura ────────────────────────────────────────────────────
export const sakura = {
  id: "sakura",
  name: "Sakura",
  emoji: "🌸",

  // ── Palette ────────────────────────────────────────────────────────────────
  // Primary accent — buttons, highlights, active states
  primary:        "#c9607a",
  primaryDark:    "#a84866",   // hover / pressed
  primaryMuted:   "#9b5070",   // softer text in primary hue
  primarySubtle:  "#c0899e",   // label / secondary text
  primaryFaint:   "#d4a5c9",   // very light text / dividers

  // Backgrounds
  bgBody:         "#ead0e8",   // outermost page background
  bgShellStart:   "#fce8f0",   // app-shell gradient top
  bgShellMid:     "#f5d0e0",   // app-shell gradient middle
  bgShellEnd:     "#ead0e8",   // app-shell gradient bottom
  bgNav:          "#fdf0f6",   // bottom navigation bar
  bgInput:        "#ffffff",   // text inputs
  bgCard:         "rgba(255,255,255,0.82)",
  bgCardAlt:      "rgba(255,235,245,0.68)",

  // Borders
  borderInput:    "#f0d9e3",
  borderNav:      "rgba(255,200,220,0.5)",
  borderCard:     "rgba(255,255,255,0.65)",

  // Text
  textBody:       "#4a2c3a",   // primary readable text
  textHeading:    "#3a1a2a",   // section headings
  textMuted:      "#c0899e",   // secondary / metadata text
  textSubtle:     "#d4a5c9",   // very soft labels

  // Shadow tokens
  shadowPrimary:  "rgba(168,66,107,0.18)",
  shadowCard:     "rgba(168,66,107,0.08)",
  shadowBtn:      "#c9607a50",

  // Admin / purple accent (intentionally separate from primary)
  adminDeep:      "#2d1b4e",
  adminMid:       "#5a2d6b",
  adminLight:     "#9b6ea8",
  adminMuted:     "#7a5090",

  // ── Typography ─────────────────────────────────────────────────────────────
  fontBody:       "'Noto Sans JP', sans-serif",
  fontDisplay:    "'Shippori Mincho', serif",
  googleFontUrl:  "https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;700;900&family=Shippori+Mincho:wght@400;500;600;700;800&display=swap",

  // ── Shape ──────────────────────────────────────────────────────────────────
  radiusInput:    "12px",
  radiusCard:     "18px",
  radiusCardSm:   "14px",
  radiusBtn:      "999px",    // pill
  radiusBtnSm:    "12px",
  radiusSheet:    "26px",

  // ── Scrollbar ──────────────────────────────────────────────────────────────
  scrollbarThumb: "rgba(201,96,122,0.25)",
};

// ── Theme: Bamboo Forest ─────────────────────────────────────────────────────
export const forest = {
  id: "forest",
  name: "Bamboo Forest",
  emoji: "🎋",

  // ── Palette ────────────────────────────────────────────────────────────────
  primary:        "#5a8a5c",   // sage green
  primaryDark:    "#3d6b3e",
  primaryMuted:   "#4a7a4b",
  primarySubtle:  "#7aaa7c",
  primaryFaint:   "#a8c8aa",

  // Backgrounds
  bgBody:         "#c8dfc9",
  bgShellStart:   "#e4f2e5",
  bgShellMid:     "#d4ead6",
  bgShellEnd:     "#c4dfc6",
  bgNav:          "#eef6ef",
  bgInput:        "#f7fbf7",
  bgCard:         "rgba(240,252,241,0.88)",
  bgCardAlt:      "rgba(220,244,222,0.72)",

  // Borders
  borderInput:    "#bddbbf",
  borderNav:      "rgba(140,195,145,0.5)",
  borderCard:     "rgba(200,235,202,0.7)",

  // Text
  textBody:       "#243a26",
  textHeading:    "#162818",
  textMuted:      "#6a9a6c",
  textSubtle:     "#8eba90",

  // Shadows
  shadowPrimary:  "rgba(58,100,60,0.15)",
  shadowCard:     "rgba(58,100,60,0.07)",
  shadowBtn:      "#5a8a5c50",

  // Admin / purple accent (kept intentionally unchanged — admin context)
  adminDeep:      "#1b2e1b",
  adminMid:       "#2d5a2d",
  adminLight:     "#5a8a5a",
  adminMuted:     "#4a7a4a",

  // ── Typography ─────────────────────────────────────────────────────────────
  fontBody:       "'Noto Sans JP', sans-serif",
  fontDisplay:    "'Shippori Mincho', serif",
  googleFontUrl:  "https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;700;900&family=Shippori+Mincho:wght@400;500;600;700;800&display=swap",

  // ── Shape (same as sakura — consistent feel) ───────────────────────────────
  radiusInput:    "12px",
  radiusCard:     "18px",
  radiusCardSm:   "14px",
  radiusBtn:      "999px",
  radiusBtnSm:    "12px",
  radiusSheet:    "26px",

  // ── Scrollbar ──────────────────────────────────────────────────────────────
  scrollbarThumb: "rgba(90,138,92,0.28)",
};

// ── Theme registry ────────────────────────────────────────────────────────────
export const themes = {
  sakura,
  forest,
};

export const defaultThemeId = "sakura";

// ── CSS variable generator ────────────────────────────────────────────────────
/**
 * Converts a theme object into a :root { ... } CSS block.
 * All tokens are exposed as --<camelCase-to-kebab> custom properties,
 * e.g. theme.primary → --primary, theme.bgShellStart → --bg-shell-start.
 */
export function buildCSSVars(theme = sakura) {
  const toKebab = (str) => str.replace(/([A-Z])/g, (m) => `-${m.toLowerCase()}`);
  const vars = Object.entries(theme)
    .filter(([k]) => !["id", "name", "emoji", "googleFontUrl"].includes(k))
    .map(([k, v]) => `  --${toKebab(k)}: ${v};`)
    .join("\n");
  return `:root {\n${vars}\n}`;
}
