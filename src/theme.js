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
  fontBody:            "'Inter', sans-serif",
  fontDisplay:         "'Inter', sans-serif",
  googleFontUrl:       "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap",

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
// Bamboo grove at dusk — deep forest greens anchored by warm amber/gold
// accents (the glow of paper lanterns through bamboo leaves).
// Gradients shift from cool shadow-green into warm canopy light.
export const forest = {
  id: "forest",
  name: "Bam Bird",
  emoji: "🐦",

  // ── Palette ────────────────────────────────────────────────────────────────
  primary:             "#2e7d4f",   // deep bamboo green
  primaryDark:         "#1a5c38",   // forest shadow
  primaryMuted:        "#3a7a50",
  primarySubtle:       "#6aab80",
  primaryFaint:        "#a8ccb4",
  secondaryAccent:     "#c47c28",   // warm amber — lantern glow through leaves

  primaryRgb:          "46,125,79",
  shadowRgb:           "20,72,44",
  borderLightRgb:      "130,200,155",
  cardAltRgb:          "210,240,220",

  // Backgrounds — misty forest floor, cool greens deepening to near-shadow
  bgBody:              "#b8d9c4",
  bgShellStart:        "#e0f0e8",
  bgShellMid:          "#cce3d6",
  bgShellEnd:          "#b8d4c4",
  bgNav:               "#ecf6f0",
  bgInput:             "#f5fbf7",
  bgCard:              "rgba(238,252,243,0.88)",
  bgCardAlt:           "rgba(210,240,222,0.72)",
  bgCardBase:          "rgba(244,253,247,0.90)",
  bgSurface:           "rgba(224,244,232,0.60)",
  bgMsgOther:          "rgba(238,252,243,0.93)",
  bgPopup:             "rgba(244,253,247,0.97)",

  inputSelectedBg:     "#cce8d8",
  inputUnselectedBg:   "#e8f5ed",

  borderInput:         "#a8d4bc",
  borderNav:           "rgba(120,185,145,0.50)",
  borderCard:          "rgba(200,238,214,0.72)",

  textBody:            "#17311f",
  textHeading:         "#0e2016",
  textMuted:           "#5a8c6c",
  textSubtle:          "#88b89a",
  sectionTitle:        "#1a5c38",

  shadowPrimary:       "rgba(20,72,44,0.18)",
  shadowCard:          "rgba(20,72,44,0.08)",
  shadowBtn:           "#2e7d4f55",
  shadowInset:         "rgba(255,255,255,0.82)",

  // Gradients — deep forest into warm canopy glow
  headerGradient:      "linear-gradient(135deg,rgba(20,72,44,0.95),rgba(196,124,40,0.82))",
  headerGradient2:     "linear-gradient(150deg,rgba(10,30,18,0.99) 0%,rgba(26,92,56,0.97) 52%,rgba(160,96,20,0.90) 100%)",
  activeTabGradient:   "linear-gradient(135deg,#2e7d4f,#c47c28)",
  avatarBubbleBg:      "linear-gradient(135deg,#cce8d8,#b8d8c4)",
  chatSheetBg:         "linear-gradient(170deg,#ecf6f0 0%,#d8ecdf 50%,#c8e0d0 100%)",

  adminDeep:           "#0e2016",
  adminMid:            "#1a5c38",
  adminLight:          "#2e7d4f",
  adminMuted:          "#246040",

  fontBody:            "'Inter', sans-serif",
  fontDisplay:         "'Inter', sans-serif",
  googleFontUrl:       "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap",

  radiusInput:         "12px",
  radiusCard:          "18px",
  radiusCardSm:        "14px",
  radiusBtn:           "999px",
  radiusBtnSm:         "12px",
  radiusSheet:         "26px",

  scrollbarThumb:      "rgba(46,125,79,0.28)",
};

// ── Theme: Dragons (dark) ────────────────────────────────────────────────────
// Inspired by the Dragon tiles (中發白) and the traditional jade mahjong set —
// deep obsidian backgrounds lit by warm gold and amethyst accents.
export const jadeDragon = {
  id: "jadeDragon",
  name: "Dragons",
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

  fontBody:            "'Inter', sans-serif",
  fontDisplay:         "'Inter', sans-serif",
  googleFontUrl:       "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap",

  radiusInput:         "12px",
  radiusCard:          "18px",
  radiusCardSm:        "14px",
  radiusBtn:           "999px",
  radiusBtnSm:         "12px",
  radiusSheet:         "26px",

  scrollbarThumb:      "rgba(212,168,67,0.30)",
};

// ── Theme: Tiles ─────────────────────────────────────────────────────────────
// Inspired by 青花瓷 (qīnghuā cí) — Chinese blue-and-white porcelain.
// Deep cobalt glazes on near-white porcelain, highlighted by glazed cyan.
export const tiles = {
  id: "tiles",
  name: "Tiles",
  emoji: "💠",

  // ── Palette ────────────────────────────────────────────────────────────────
  primary:             "#1762c8",   // cobalt — the signature 青花瓷 glaze blue
  primaryDark:         "#0d4daa",   // deep indigo-navy
  primaryMuted:        "#1e69c4",
  primarySubtle:       "#5c96d8",
  primaryFaint:        "#a0c4eb",
  secondaryAccent:     "#0891b2",   // glazed cyan — light catching on porcelain

  primaryRgb:          "23,98,200",
  shadowRgb:           "13,77,170",
  borderLightRgb:      "140,190,255",
  cardAltRgb:          "210,232,255",

  // Backgrounds — polished porcelain: cool blue-whites with quiet depth
  bgBody:              "#c4d9f4",
  bgShellStart:        "#e8f2fc",
  bgShellMid:          "#d4e7f9",
  bgShellEnd:          "#bfd5f4",
  bgNav:               "#f2f7fd",
  bgInput:             "#ffffff",
  bgCard:              "rgba(255,255,255,0.86)",
  bgCardAlt:           "rgba(210,232,255,0.70)",
  bgCardBase:          "rgba(255,255,255,0.90)",
  bgSurface:           "rgba(228,241,255,0.60)",
  bgMsgOther:          "rgba(255,255,255,0.93)",
  bgPopup:             "rgba(255,255,255,0.97)",

  inputSelectedBg:     "#d4e8ff",
  inputUnselectedBg:   "#edf4fc",

  borderInput:         "#b5d1f5",
  borderNav:           "rgba(140,190,255,0.48)",
  borderCard:          "rgba(255,255,255,0.72)",

  textBody:            "#0f2a54",
  textHeading:         "#081a3c",
  textMuted:           "#527ec0",
  textSubtle:          "#86ace0",
  sectionTitle:        "#0d4daa",

  shadowPrimary:       "rgba(13,77,170,0.18)",
  shadowCard:          "rgba(13,77,170,0.07)",
  shadowBtn:           "#1762c852",
  shadowInset:         "rgba(255,255,255,0.90)",

  // Pre-built gradients — the visual soul of the theme
  headerGradient:      "linear-gradient(135deg,rgba(13,77,170,0.95),rgba(8,145,178,0.88))",
  headerGradient2:     "linear-gradient(150deg,rgba(8,20,60,0.99) 0%,rgba(13,77,170,0.97) 55%,rgba(8,145,178,0.94) 100%)",
  activeTabGradient:   "linear-gradient(135deg,#1762c8,#0891b2)",
  avatarBubbleBg:      "linear-gradient(135deg,#d4e8ff,#c0d8f4)",
  chatSheetBg:         "linear-gradient(170deg,#f2f7fd 0%,#dae9f8 50%,#c8ddf5 100%)",

  // Admin — deep navy tones, distinct from the primary cobalt
  adminDeep:           "#080f24",
  adminMid:            "#122870",
  adminLight:          "#1762c8",
  adminMuted:          "#1354b0",

  // ── Typography ─────────────────────────────────────────────────────────────
  fontBody:            "'Inter', sans-serif",
  fontDisplay:         "'Inter', sans-serif",
  googleFontUrl:       "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap",

  // ── Shape ──────────────────────────────────────────────────────────────────
  radiusInput:         "12px",
  radiusCard:          "18px",
  radiusCardSm:        "14px",
  radiusBtn:           "999px",
  radiusBtnSm:         "12px",
  radiusSheet:         "26px",

  // ── Scrollbar ──────────────────────────────────────────────────────────────
  scrollbarThumb:      "rgba(23,98,200,0.28)",
};

// ── Theme registry ────────────────────────────────────────────────────────────
export const themes = {
  sakura,
  forest,
  jadeDragon,
  tiles,
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
