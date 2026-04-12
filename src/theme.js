/**
 * Mahjong Club — Theme System
 *
 * Each theme defines a set of design tokens. The active theme is converted
 * into CSS custom properties injected into :root, so every component can
 * reference `var(--token-name)` in both CSS and inline style props.
 *
 * rgba() patterns use the RGB-channel tokens, e.g.:
 *   `rgba(var(--primary-rgb), 0.25)`
 *
 * To add a new theme:
 *   1. Copy an existing object below and change the values.
 *   2. Add it to the `themes` map with a unique key.
 *   3. The theme picker in Account will display it automatically.
 */

// ── Default theme: Flowers ───────────────────────────────────────────────────
export const sakura = {
  id: "sakura",
  name: "Flowers",
  emoji: "🌸",

  // ── Palette ────────────────────────────────────────────────────────────────
  primary:             "#c9607a",
  primaryDark:         "#a84866",
  primaryMuted:        "#9b5070",
  primarySubtle:       "#c0899e",
  primaryFaint:        "#d4a5c9",
  secondaryAccent:     "#9b6ea8",

  // RGB channel tokens for rgba(var(--primary-rgb), alpha) patterns
  primaryRgb:          "201,96,122",
  shadowRgb:           "168,66,107",
  borderLightRgb:      "255,200,220",
  cardAltRgb:          "255,235,245",

  // Backgrounds
  bgBody:              "#ead0e8",
  bgShellStart:        "#fce8f0",
  bgShellMid:          "#f5d0e0",
  bgShellEnd:          "#ead0e8",
  bgNav:               "#fdf0f6",
  bgInput:             "#ffffff",
  bgCard:              "rgba(255,255,255,0.82)",
  bgCardAlt:           "rgba(255,235,245,0.68)",
  bgCardBase:          "rgba(255,255,255,0.85)",  // gradient "white" end of cards
  bgSurface:           "rgba(255,255,255,0.55)",  // subtle inactive surfaces
  bgMsgOther:          "rgba(255,255,255,0.90)",  // other user's chat bubble
  bgPopup:             "rgba(255,255,255,0.97)",  // dropdowns / overlays

  // Input selection states
  inputSelectedBg:     "#fce4ee",
  inputUnselectedBg:   "#f9f0f3",

  // Borders
  borderInput:         "#f0d9e3",
  borderNav:           "rgba(255,200,220,0.5)",
  borderCard:          "rgba(255,255,255,0.65)",

  // Text
  textBody:            "#4a2c3a",
  textHeading:         "#3a1a2a",
  textMuted:           "#c0899e",
  textSubtle:          "#d4a5c9",
  sectionTitle:        "#7a3050",

  // Shadows
  shadowPrimary:       "rgba(168,66,107,0.18)",
  shadowCard:          "rgba(168,66,107,0.08)",
  shadowBtn:           "#c9607a50",
  shadowInset:         "rgba(255,255,255,0.80)",  // inset 0 1px 0 card top shine

  // Pre-built gradients
  headerGradient:      "linear-gradient(135deg,rgba(168,66,107,0.92),rgba(155,110,168,0.88))",
  headerGradient2:     "linear-gradient(150deg,rgba(168,66,107,0.95) 0%,rgba(201,96,122,0.9) 50%,rgba(155,110,168,0.9) 100%)",
  activeTabGradient:   "linear-gradient(135deg,#c9607a,#9b6ea8)",
  avatarBubbleBg:      "linear-gradient(135deg,#fce4ee,#f5d0e0)",
  chatSheetBg:         "linear-gradient(170deg,#fdf0f6 0%,#f8dcea 50%,#f0d4e8 100%)",

  // Admin (intentionally separate from primary)
  adminDeep:           "#2d1b4e",
  adminMid:            "#5a2d6b",
  adminLight:          "#9b6ea8",
  adminMuted:          "#7a5090",

  // ── Typography ─────────────────────────────────────────────────────────────
  fontBody:            "'Noto Sans JP', sans-serif",
  fontDisplay:         "'Shippori Mincho', serif",
  googleFontUrl:       "https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;700;900&family=Shippori+Mincho:wght@400;500;600;700;800&display=swap",

  // ── Shape ──────────────────────────────────────────────────────────────────
  radiusInput:         "12px",
  radiusCard:          "18px",
  radiusCardSm:        "14px",
  radiusBtn:           "999px",
  radiusBtnSm:         "12px",
  radiusSheet:         "26px",

  // ── Scrollbar ──────────────────────────────────────────────────────────────
  scrollbarThumb:      "rgba(201,96,122,0.25)",
};

// ── Theme: Bam Bird ──────────────────────────────────────────────────────────
export const forest = {
  id: "forest",
  name: "Bam Bird",
  emoji: "🎋",

  primary:             "#5a8a5c",
  primaryDark:         "#3d6b3e",
  primaryMuted:        "#4a7a4b",
  primarySubtle:       "#7aaa7c",
  primaryFaint:        "#a8c8aa",
  secondaryAccent:     "#3d7a5e",

  primaryRgb:          "90,138,92",
  shadowRgb:           "58,100,60",
  borderLightRgb:      "160,210,165",
  cardAltRgb:          "220,244,222",

  bgBody:              "#c8dfc9",
  bgShellStart:        "#e4f2e5",
  bgShellMid:          "#d4ead6",
  bgShellEnd:          "#c4dfc6",
  bgNav:               "#eef6ef",
  bgInput:             "#f7fbf7",
  bgCard:              "rgba(240,252,241,0.88)",
  bgCardAlt:           "rgba(220,244,222,0.72)",
  bgCardBase:          "rgba(245,253,246,0.88)",
  bgSurface:           "rgba(240,252,241,0.60)",
  bgMsgOther:          "rgba(240,252,241,0.92)",
  bgPopup:             "rgba(244,253,245,0.97)",

  inputSelectedBg:     "#d4f0d6",
  inputUnselectedBg:   "#edf7ee",

  borderInput:         "#bddbbf",
  borderNav:           "rgba(140,195,145,0.5)",
  borderCard:          "rgba(200,235,202,0.70)",

  textBody:            "#243a26",
  textHeading:         "#162818",
  textMuted:           "#6a9a6c",
  textSubtle:          "#8eba90",
  sectionTitle:        "#1e4a20",

  shadowPrimary:       "rgba(58,100,60,0.15)",
  shadowCard:          "rgba(58,100,60,0.07)",
  shadowBtn:           "#5a8a5c50",
  shadowInset:         "rgba(255,255,255,0.80)",

  headerGradient:      "linear-gradient(135deg,rgba(58,100,60,0.92),rgba(61,122,94,0.88))",
  headerGradient2:     "linear-gradient(150deg,rgba(28,58,30,0.99) 0%,rgba(48,85,50,0.98) 55%,rgba(36,72,46,0.98) 100%)",
  activeTabGradient:   "linear-gradient(135deg,#5a8a5c,#3d7a5e)",
  avatarBubbleBg:      "linear-gradient(135deg,#d4f0d6,#c4e8c6)",
  chatSheetBg:         "linear-gradient(170deg,#eef6ef 0%,#e0eddf 50%,#d4e8d4 100%)",

  adminDeep:           "#1b2e1b",
  adminMid:            "#2d5a2d",
  adminLight:          "#5a8a5a",
  adminMuted:          "#4a7a4a",

  fontBody:            "'Noto Sans JP', sans-serif",
  fontDisplay:         "'Shippori Mincho', serif",
  googleFontUrl:       "https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;700;900&family=Shippori+Mincho:wght@400;500;600;700;800&display=swap",

  radiusInput:         "12px",
  radiusCard:          "18px",
  radiusCardSm:        "14px",
  radiusBtn:           "999px",
  radiusBtnSm:         "12px",
  radiusSheet:         "26px",

  scrollbarThumb:      "rgba(90,138,92,0.28)",
};

// ── Theme: Jade Dragon (dark) ─────────────────────────────────────────────────
// Inspired by the Dragon tiles (中發白) and the traditional jade mahjong set —
// deep obsidian backgrounds lit by warm gold and amethyst accents.
export const jadeDragon = {
  id: "jadeDragon",
  name: "Jade Dragon",
  emoji: "🐉",

  primary:             "#d4a843",   // warm gold — lit mahjong tile
  primaryDark:         "#b88a2a",
  primaryMuted:        "#c49a38",
  primarySubtle:       "#8a7040",
  primaryFaint:        "#4e3e1c",
  secondaryAccent:     "#8a6bc9",   // amethyst — dragon tile purple

  primaryRgb:          "212,168,67",
  shadowRgb:           "180,140,50",
  borderLightRgb:      "212,168,67",
  cardAltRgb:          "32,28,52",

  bgBody:              "#080810",
  bgShellStart:        "#12121f",
  bgShellMid:          "#181828",
  bgShellEnd:          "#0e0e1c",
  bgNav:               "#0c0c18",
  bgInput:             "#1c1c2e",
  bgCard:              "rgba(22,22,38,0.92)",
  bgCardAlt:           "rgba(30,26,50,0.85)",
  bgCardBase:          "rgba(24,22,42,0.94)",
  bgSurface:           "rgba(28,26,48,0.80)",
  bgMsgOther:          "rgba(26,22,46,0.96)",
  bgPopup:             "rgba(16,14,30,0.98)",

  inputSelectedBg:     "#2a2048",
  inputUnselectedBg:   "#1a1830",

  borderInput:         "#2e2a4a",
  borderNav:           "rgba(212,168,67,0.22)",
  borderCard:          "rgba(212,168,67,0.14)",

  textBody:            "#ddd8f0",
  textHeading:         "#f0ecff",
  textMuted:           "#7870a0",
  textSubtle:          "#4e4870",
  sectionTitle:        "#d4a843",   // gold headings on dark

  shadowPrimary:       "rgba(212,168,67,0.20)",
  shadowCard:          "rgba(0,0,0,0.40)",
  shadowBtn:           "#d4a84355",
  shadowInset:         "rgba(255,255,255,0.05)",  // barely visible on dark

  headerGradient:      "linear-gradient(135deg,rgba(14,12,28,0.97),rgba(38,28,72,0.95))",
  headerGradient2:     "linear-gradient(150deg,rgba(12,10,24,0.98) 0%,rgba(30,22,58,0.96) 50%,rgba(50,32,80,0.93) 100%)",
  activeTabGradient:   "linear-gradient(135deg,#d4a843,#8a6bc9)",
  avatarBubbleBg:      "linear-gradient(135deg,#2a2048,#1c1638)",
  chatSheetBg:         "linear-gradient(170deg,#0c0c18 0%,#141428 50%,#0c0c1e 100%)",

  adminDeep:           "#0c0a1c",
  adminMid:            "#1e1840",
  adminLight:          "#8a6bc9",
  adminMuted:          "#6a50a8",

  fontBody:            "'Noto Sans JP', sans-serif",
  fontDisplay:         "'Shippori Mincho', serif",
  googleFontUrl:       "https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;700;900&family=Shippori+Mincho:wght@400;500;600;700;800&display=swap",

  radiusInput:         "12px",
  radiusCard:          "18px",
  radiusCardSm:        "14px",
  radiusBtn:           "999px",
  radiusBtnSm:         "12px",
  radiusSheet:         "26px",

  scrollbarThumb:      "rgba(212,168,67,0.30)",
};

// ── Theme registry ────────────────────────────────────────────────────────────
export const themes = {
  sakura,
  forest,
  jadeDragon,
};

export const defaultThemeId = "sakura";

// ── CSS variable generator ────────────────────────────────────────────────────
export function buildCSSVars(theme = sakura) {
  const toKebab = (str) => str.replace(/([A-Z])/g, (m) => `-${m.toLowerCase()}`);
  const vars = Object.entries(theme)
    .filter(([k]) => !["id", "name", "emoji", "googleFontUrl"].includes(k))
    .map(([k, v]) => `  --${toKebab(k)}: ${v};`)
    .join("\n");
  return `:root {\n${vars}\n}`;
}
