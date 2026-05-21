import { useId, type CSSProperties } from "react";

/**
 * The 4 nested chevrons that make up the Arch mark, ordered innermost
 * → outermost. Listed once and reused for both the rendered foreground
 * paths and the SVG <mask> used by the flare overlay, so there's a
 * single source of truth for the geometry.
 */
const CHEVRON_PATHS = [
  "M554.569 873.994H514.625C510.446 873.994 506.52 871.884 504.291 868.317L311.385 560.676C306.851 553.492 299.784 552.713 296.947 552.713C294.136 552.713 286.968 553.467 282.51 560.676L89.6039 868.317C87.3749 871.884 83.4489 873.994 79.2696 873.994H39.3258C29.7767 873.994 23.951 863.569 28.9915 855.531L233.093 530.181C246.923 508.076 270.833 494.963 297.023 494.963C323.239 494.963 347.124 508.076 360.954 530.181L565.055 855.531C570.096 863.569 564.295 873.994 554.721 873.994H554.569Z",
  "M666.206 873.996H626.077C621.878 873.996 617.934 871.878 615.695 868.297L323.37 402.476C317.543 393.221 308.026 387.951 297.033 387.951C286.066 387.951 276.447 393.221 270.696 402.476L-21.6288 868.297C-23.868 871.878 -27.8122 873.996 -32.0108 873.996H-72.1394C-81.7326 873.996 -87.5852 863.53 -82.5214 855.461L220.975 371.887C237.438 345.635 265.836 329.975 297.033 329.975C312.632 329.975 327.467 333.884 340.597 341.122C353.625 348.334 364.873 358.799 373.092 371.887L676.562 855.461C681.651 863.53 675.799 873.996 666.206 873.996Z",
  "M773.154 873.998H733.294C729.124 873.998 725.206 871.875 722.982 868.287L334.821 244.229C326.48 230.861 312.679 223.205 296.907 223.205C281.135 223.205 267.36 230.861 258.993 244.229L-129.143 868.287C-131.367 871.875 -135.285 873.998 -139.455 873.998H-179.315C-188.844 873.998 -194.658 863.511 -189.628 855.424L209.68 213.476C228.157 183.759 259.853 165.691 294.784 165.009C331.585 164.251 365.834 183.835 385.322 215.093L783.619 855.349C788.648 863.435 782.86 873.922 773.306 873.922L773.154 873.998Z",
  "M884.642 873.999H844.655C840.471 873.999 836.541 871.874 834.31 868.281L346.734 85.8787C335.806 68.3182 317.676 58.2475 296.909 58.2475C276.142 58.2475 258.038 68.3182 247.084 85.8787L-240.466 868.281C-242.697 871.874 -246.627 873.999 -250.811 873.999H-290.798C-300.357 873.999 -306.189 863.499 -301.143 855.401L197.64 55.0846C219.167 20.6469 256.263 -0.000610352 297.011 -0.000610352C337.784 -0.000610352 374.854 20.5456 396.382 55.0846L895.139 855.401C900.185 863.499 894.379 873.999 884.819 873.999H884.642Z",
];

/**
 * Animated hero logo for onboarding-style screens.
 *
 * Composition:
 *   - Each chevron is filled with a "polished metal" linear gradient
 *     (cream highlight → warm gold mid-tone → cream) so the mark
 *     reads as 3D / premium even when nothing is moving.
 *   - The 4 chevrons cascade in and out on a 4.2s loop (innermost
 *     first), driven by per-path --i delays.
 *   - A masked specular streak sweeps left-to-right across the mark
 *     once per cycle, timed to land while the cascade is at peak
 *     visibility -- this is the "metallic flare".
 *
 * The surrounding halo lives on the parent `.onboarding-logo`
 * element (see global.css) and breathes on its own.
 */
export default function ArchLogoAnimated({ size = 56 }: { size?: number }) {
  // Per-instance suffix so two logos on one page don't collide on
  // gradient / mask ids. Cheap insurance via React's useId.
  const uid = useId().replace(/:/g, "");
  const metallicId = `arch-metallic-${uid}`;
  const flareId = `arch-flare-${uid}`;
  const maskId = `arch-flare-mask-${uid}`;

  return (
    <svg
      className="arch-logo-animated"
      width={size}
      height={size}
      viewBox="-310 -10 1220 900"
      fill="none"
      aria-hidden="true"
    >
      <defs>
        {/* Polished-metal base: cream highlight at top, falls into a
            warm gold mid-tone, settles back to cream at the bottom.
            Vertical gradient so the brightest band sits where light
            would naturally catch the top of the chevrons. */}
        <linearGradient id={metallicId} x1="0.5" y1="0" x2="0.5" y2="1">
          <stop offset="0%" stopColor="#FFF6DC" />
          <stop offset="38%" stopColor="#F3EFD7" />
          <stop offset="62%" stopColor="#D8B077" />
          <stop offset="100%" stopColor="#F0E6C5" />
        </linearGradient>

        {/* Bright specular streak painted into the flare rect. The
            gradient itself is static; the rect translates across the
            viewBox (see global.css) to create the moving highlight.
            Soft falloff on both sides so the streak reads as a
            reflection, not a hard edge. */}
        <linearGradient id={flareId} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0" />
          <stop offset="35%" stopColor="#FFFFFF" stopOpacity="0" />
          <stop offset="50%" stopColor="#FFFFFF" stopOpacity="0.95" />
          <stop offset="65%" stopColor="#FFFFFF" stopOpacity="0" />
          <stop offset="100%" stopColor="#FFFFFF" stopOpacity="0" />
        </linearGradient>

        {/* Chevron-shaped mask so the sweeping flare only illuminates
            the mark itself, never the empty space around it. The mask
            geometry is static (the foreground chevrons handle the
            cascade); during the dissolve phase the flare is parked
            off-screen so this static mask doesn't leak a ghost. */}
        <mask
          id={maskId}
          maskUnits="userSpaceOnUse"
          x="-310"
          y="-10"
          width="1220"
          height="900"
        >
          {CHEVRON_PATHS.map((d, i) => (
            <path key={i} d={d} fill="white" />
          ))}
        </mask>
      </defs>

      {CHEVRON_PATHS.map((d, i) => (
        <path
          key={i}
          className="arch-logo-animated__chevron"
          style={{ "--i": i } as CSSProperties}
          fill={`url(#${metallicId})`}
          d={d}
        />
      ))}

      {/* Flare overlay. The rect starts off-screen left of the
          viewBox; CSS translates it across so the bright streak inside
          it sweeps over the chevron silhouette. `mask` clips it to
          the mark; `mix-blend-mode: screen` brightens the underlying
          metallic gradient rather than just stamping white on top. */}
      <rect
        className="arch-logo-animated__flare"
        x="-700"
        y="-10"
        width="400"
        height="900"
        fill={`url(#${flareId})`}
        mask={`url(#${maskId})`}
      />
    </svg>
  );
}
