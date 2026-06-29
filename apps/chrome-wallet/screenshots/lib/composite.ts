import sharp from "sharp";

// Chrome Web Store listing target canvas. CWS accepts 1280x800 or 640x400;
// we produce 1280x800 for crisp marketing tiles.
export const CANVAS_W = 1280;
export const CANVAS_H = 800;

// The popup renders at 400x600. We place it onto the canvas at a 1.2x scale
// (480x720) so it dominates the tile while leaving a branded margin.
const FRAME_W = 480;
const FRAME_H = 720;
const FRAME_LEFT = Math.round((CANVAS_W - FRAME_W) / 2);
const FRAME_TOP = Math.round((CANVAS_H - FRAME_H) / 2);
const FRAME_RADIUS = 22;

export type CanvasTheme = "light" | "dark";

// Brand tokens, mirrored from src/styles/global.css so the marketing canvas
// matches the in-app surfaces. --color-primary (#F2640F) is the Arch orange;
// the surface colors are the light/dark app backgrounds.
const BRAND = {
  orange: "#F2640F",
  light: { from: "#f6f6f8", to: "#e7e7ea", glow: "rgba(242,100,15,0.16)" },
  dark: { from: "#141416", to: "#08080a", glow: "rgba(242,100,15,0.22)" },
} as const;

function backgroundSvg(theme: CanvasTheme): string {
  const c = BRAND[theme];
  return `<svg width="${CANVAS_W}" height="${CANVAS_H}" viewBox="0 0 ${CANVAS_W} ${CANVAS_H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${c.from}"/>
      <stop offset="100%" stop-color="${c.to}"/>
    </linearGradient>
    <radialGradient id="glowTop" cx="0.12" cy="0.1" r="0.55">
      <stop offset="0%" stop-color="${c.glow}"/>
      <stop offset="100%" stop-color="rgba(0,0,0,0)"/>
    </radialGradient>
    <radialGradient id="glowBottom" cx="0.92" cy="0.95" r="0.6">
      <stop offset="0%" stop-color="${c.glow}"/>
      <stop offset="100%" stop-color="rgba(0,0,0,0)"/>
    </radialGradient>
  </defs>
  <rect width="${CANVAS_W}" height="${CANVAS_H}" fill="url(#bg)"/>
  <rect width="${CANVAS_W}" height="${CANVAS_H}" fill="url(#glowTop)"/>
  <rect width="${CANVAS_W}" height="${CANVAS_H}" fill="url(#glowBottom)"/>
</svg>`;
}

function roundedMaskSvg(): string {
  return `<svg width="${FRAME_W}" height="${FRAME_H}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${FRAME_W}" height="${FRAME_H}" rx="${FRAME_RADIUS}" ry="${FRAME_RADIUS}" fill="#fff"/>
</svg>`;
}

function shadowSvg(): string {
  return `<svg width="${CANVAS_W}" height="${CANVAS_H}" xmlns="http://www.w3.org/2000/svg">
  <rect x="${FRAME_LEFT}" y="${FRAME_TOP + 10}" width="${FRAME_W}" height="${FRAME_H}" rx="${FRAME_RADIUS}" ry="${FRAME_RADIUS}" fill="black" opacity="0.42"/>
</svg>`;
}

/**
 * Composite a raw popup screenshot (PNG buffer, captured at 400x600 with a
 * 2x device scale → 800x1200 px) onto a branded 1280x800 canvas with rounded
 * corners and a soft drop shadow.
 */
export async function compositeToCanvas(
  popupPng: Buffer,
  theme: CanvasTheme,
): Promise<Buffer> {
  const mask = Buffer.from(roundedMaskSvg());
  const roundedFrame = await sharp(popupPng)
    .resize(FRAME_W, FRAME_H, { fit: "fill" })
    .composite([{ input: mask, blend: "dest-in" }])
    .png()
    .toBuffer();

  const shadow = await sharp(Buffer.from(shadowSvg())).blur(26).png().toBuffer();

  return sharp(Buffer.from(backgroundSvg(theme)))
    .composite([
      { input: shadow, left: 0, top: 0 },
      { input: roundedFrame, left: FRAME_LEFT, top: FRAME_TOP },
    ])
    .png()
    .toBuffer();
}
