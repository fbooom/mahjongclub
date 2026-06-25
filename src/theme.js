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

  // Date block on game cards — warm parchment, distinct from pink card + pink shell
  dateBlockBg:         "#ede8e0",

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
  googleFontUrl:       "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=Shippori+Mincho:wght@700&display=swap",

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
  secondaryAccent:     "#2a8080",   // teal jade — mist and water through bamboo

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

  // Date block on game cards — warm sand, distinct from green card + green shell
  dateBlockBg:         "#e6dfd0",

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

  // Gradients — deep forest into teal jade mist
  headerGradient:      "linear-gradient(135deg,rgba(20,72,44,0.95),rgba(42,128,128,0.82))",
  headerGradient2:     "linear-gradient(150deg,rgba(10,30,18,0.99) 0%,rgba(26,92,56,0.97) 52%,rgba(30,100,100,0.90) 100%)",
  activeTabGradient:   "linear-gradient(135deg,#2e7d4f,#2a8080)",
  avatarBubbleBg:      "linear-gradient(135deg,#cce8d8,#b8d8c4)",
  chatSheetBg:         "linear-gradient(170deg,#ecf6f0 0%,#d8ecdf 50%,#c8e0d0 100%)",

  adminDeep:           "#0e2016",
  adminMid:            "#1a5c38",
  adminLight:          "#2e7d4f",
  adminMuted:          "#246040",

  fontBody:            "'Inter', sans-serif",
  fontDisplay:         "'Inter', sans-serif",
  googleFontUrl:       "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=Shippori+Mincho:wght@700&display=swap",

  radiusInput:         "12px",
  radiusCard:          "18px",
  radiusCardSm:        "14px",
  radiusBtn:           "999px",
  radiusBtnSm:         "12px",
  radiusSheet:         "26px",

  scrollbarThumb:      "rgba(46,125,79,0.28)",
};

// ── Theme: Dragons (dark luxury) ─────────────────────────────────────────────
// Midnight navy-plum shell, elevated indigo-plum cards, rich gold and peacock
// teal accents — luxury jewel-tone aesthetic for a sophisticated social club.
export const jadeDragon = {
  id: "jadeDragon",
  name: "Dragons",
  emoji: "🐉",

  primary:             "#d4a843",   // rich warm gold
  primaryDark:         "#a8841e",
  primaryMuted:        "#c4983a",
  primarySubtle:       "#8a6c22",
  primaryFaint:        "#4a380e",
  secondaryAccent:     "#1ec8b8",   // peacock teal

  primaryRgb:          "212,168,67",
  shadowRgb:           "160,120,40",
  borderLightRgb:      "170,110,255",
  cardAltRgb:          "44,28,76",

  // Shell — deep midnight with plum undertone; distinctly darker than cards
  bgBody:              "#08051a",
  bgShellStart:        "#130c28",
  bgShellMid:          "#0e0920",
  bgShellEnd:          "#09061a",
  bgNav:               "#0b0820",
  bgInput:             "#1e1540",   // sunken below card surface

  // Cards — elevated indigo-plum; ~20pt lightness jump above the shell
  bgCard:              "rgba(52,36,90,0.88)",
  bgCardAlt:           "rgba(42,28,76,0.84)",
  bgCardBase:          "rgba(62,44,102,0.90)",  // gradient bright end — satin sheen
  bgSurface:           "rgba(46,32,80,0.72)",
  bgMsgOther:          "rgba(54,38,90,0.96)",
  bgPopup:             "rgba(16,10,36,0.98)",

  // Date block — warm gold tint, stands out on indigo-plum card
  dateBlockBg:         "rgba(212,168,67,0.22)",

  inputSelectedBg:     "#2e205a",
  inputUnselectedBg:   "#1a1238",

  borderInput:         "#3a2870",
  borderNav:           "rgba(212,168,67,0.28)",
  // Subtle amethyst/plum edge glow — elevates cards like ambient studio lighting
  borderCard:          "rgba(170,110,255,0.26)",

  textBody:            "#e6e2f8",   // warm white with slight violet
  textHeading:         "#f5f2ff",   // near-white, barely-there lavender
  textMuted:           "#8a7ab8",   // muted lavender-gray
  textSubtle:          "#524878",   // deep muted lavender
  sectionTitle:        "#d4a843",

  shadowPrimary:       "rgba(212,168,67,0.24)",
  // Deep ambient shadow — critical for card elevation feel
  shadowCard:          "rgba(0,0,18,0.62)",
  shadowBtn:           "#d4a84362",
  // Violet shimmer on the top edge of cards — satin catch-light
  shadowInset:         "rgba(200,160,255,0.12)",

  // Header: deep midnight plum bloom; premium, not harsh
  headerGradient:      "linear-gradient(135deg,rgba(10,6,28,0.97),rgba(46,24,84,0.95))",
  headerGradient2:     "linear-gradient(150deg,rgba(6,3,18,0.99) 0%,rgba(28,14,60,0.97) 50%,rgba(54,22,86,0.94) 100%)",
  // CTA: gold → peacock teal — jewel-tone luxury
  activeTabGradient:   "linear-gradient(135deg,#d4a843,#1ec8b8)",
  avatarBubbleBg:      "linear-gradient(135deg,#2e1a5c,#1e1044)",
  chatSheetBg:         "linear-gradient(170deg,#120a28 0%,#0e0820 50%,#090618 100%)",

  adminDeep:           "#080420",
  adminMid:            "#1e1448",
  adminLight:          "#8a6bc9",
  adminMuted:          "#6a50a8",

  fontBody:            "'Inter', sans-serif",
  fontDisplay:         "'Inter', sans-serif",
  googleFontUrl:       "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=Shippori+Mincho:wght@700&display=swap",

  radiusInput:         "14px",   // slightly softer for premium feel
  radiusCard:          "20px",
  radiusCardSm:        "16px",
  radiusBtn:           "999px",
  radiusBtnSm:         "14px",
  radiusSheet:         "28px",

  scrollbarThumb:      "rgba(212,168,67,0.34)",
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

  // Date block on game cards — warm parchment, distinct from blue-white card + blue shell
  dateBlockBg:         "#ede8e0",

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
  googleFontUrl:       "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=Shippori+Mincho:wght@700&display=swap",

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
