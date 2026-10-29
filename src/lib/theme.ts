import type { ThemePreset } from "./types";

export const THEME_PRESETS: ThemePreset[] = [
  {
    id: "tora-midnight",
    name: "Tora Midnight",
    isDark: true,
    previewBg: "#0c0e14",
    previewCard: "#1a1e2b",
    defaultAccent: "#f59e0b",
    description: "Deep obsidian dark mode with signature Tiger Amber highlights.",
  },
  {
    id: "taiga-classic",
    name: "Taiga Classic",
    isDark: false,
    previewBg: "#f8fafc",
    previewCard: "#ffffff",
    defaultAccent: "#2563eb",
    description: "Crisp daylight desktop theme inspired by classic Taiga.",
  },
  {
    id: "catppuccin-mocha",
    name: "Catppuccin Mocha",
    isDark: true,
    previewBg: "#181825",
    previewCard: "#313244",
    defaultAccent: "#cba6f7",
    description: "Soothing pastel dark mocha with lavender & mauve tones.",
  },
  {
    id: "tokyo-night",
    name: "Tokyo Night",
    isDark: true,
    previewBg: "#16161e",
    previewCard: "#24283b",
    defaultAccent: "#7aa2f7",
    description: "Clean neon night palette inspired by downtown Tokyo lights.",
  },
  {
    id: "cyber-sakura",
    name: "Cyber Sakura (OLED)",
    isDark: true,
    previewBg: "#08070c",
    previewCard: "#1a1426",
    defaultAccent: "#ec4899",
    description: "High-contrast AMOLED black with electric sakura pink.",
  },
  {
    id: "nordic-frost",
    name: "Nordic Frost",
    isDark: true,
    previewBg: "#242933",
    previewCard: "#3b4252",
    defaultAccent: "#88c0d0",
    description: "Arctic slate blues and cool frost cyan.",
  },
];

export const ACCENT_SWATCHES = [
  { name: "Tiger Amber", hex: "#f59e0b" },
  { name: "Taiga Blue", hex: "#3b82f6" },
  { name: "Sakura Pink", hex: "#ec4899" },
  { name: "Emerald Jade", hex: "#10b981" },
  { name: "Violet Pulse", hex: "#8b5cf6" },
  { name: "Crimson Flame", hex: "#ef4444" },
  { name: "Arctic Cyan", hex: "#06b6d4" },
];

export function hexToRgbTriplet(hex: string): string | null {
  const clean = hex.replace("#", "").trim();
  if (clean.length !== 6) return null;
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  if (isNaN(r) || isNaN(g) || isNaN(b)) return null;
  return `${r} ${g} ${b}`;
}

export function applyThemeToDocument(themeId: string, accentHex: string) {
  const root = document.documentElement;
  root.setAttribute("data-theme", themeId);
  const preset = THEME_PRESETS.find((t) => t.id === themeId);
  if (preset && !preset.isDark) {
    root.classList.remove("dark");
  } else {
    root.classList.add("dark");
  }
  const rgb = hexToRgbTriplet(accentHex);
  if (rgb) {
    root.style.setProperty("--accent-primary", rgb);
    root.style.setProperty("--accent-hover", rgb);
  }

  const style = getComputedStyle(root);
  const accent = parseTriplet(rgb ?? style.getPropertyValue("--accent-primary"));
  const track = parseTriplet(style.getPropertyValue("--bg-tertiary"));
  if (accent && track) {
    root.style.setProperty("--progress-strip", progressStripColor(accent, track).join(" "));
  }
}

type Rgb = [number, number, number];

function parseTriplet(value: string): Rgb | null {
  const parts = value.trim().split(/\s+/).map(Number);
  return parts.length === 3 && parts.every((n) => Number.isFinite(n)) ? (parts as Rgb) : null;
}

/** WCAG relative luminance */
function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [r, g, b].map((v) => Math.round((v + m) * 255)) as Rgb;
}

function hueOf([r, g, b]: Rgb): { hue: number; sat: number } {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  if (d === 0) return { hue: 0, sat: 0 };
  const sat = d / (1 - Math.abs(max + min - 1));
  let hue = max === rn ? ((gn - bn) / d) % 6 : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4;
  hue *= 60;
  return { hue: hue < 0 ? hue + 360 : hue, sat };
}

const STRIP_GREEN_DARK: Rgb = [52, 211, 153]; // emerald-400
const STRIP_GREEN_LIGHT: Rgb = [5, 150, 105]; // emerald-600
const STRIP_HUE = 145;
const STRIP_SAT = 0.75;

/**
 * On-disk strip colour for progress bars: emerald green on every theme. Only a green / teal accent
 * too close to it (the strip runs over the watched fill) moves the green to the lightness that
 * contrasts best with both the fill and the empty track.
 */
export function progressStripColor(accent: Rgb, track: Rgb): Rgb {
  const base = luminance(track) < 0.2 ? STRIP_GREEN_DARK : STRIP_GREEN_LIGHT;
  const { hue, sat } = hueOf(accent);
  const greenish = sat > 0.2 && hue >= 90 && hue <= 200;
  if (!greenish || contrastRatio(base, accent) >= 1.5) return base;

  let best = base;
  let bestScore = -1;
  // Lightness stays in a range where the hue still reads (no near-white / near-black)
  for (let l = 0.3; l <= 0.8001; l += 0.025) {
    const c = hslToRgb(STRIP_HUE, STRIP_SAT, l);
    const score = Math.min(contrastRatio(c, accent), contrastRatio(c, track));
    if (score > bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return best;
}
