# Empty-state artwork

Generated with the built-in imagegen tool on 2026-09-09. Runtime assets are
384 × 384 WebP files, displayed at 128 × 128 with reserved dimensions and empty
alt text because the adjacent copy describes the state. Activity retains its cream canvas. Collectibles uses a genuine alpha channel,
with two ivory cards bearing the four-chevron Arch mark, referenced from
`public/arch-mark-orange.svg`. Existing token identities and user-owned
collectibles retain their original artwork.

## Prompts


### Activity

Use case: stylized-concept. Asset type: bespoke Chrome wallet empty-state illustration, square. Create a beautifully crafted miniature sculptural tray with a single blank cream transaction receipt floating just above it, a fine curved burnt-orange path joining two small spheres suggests incoming and outgoing activity. Matte terracotta orange #F2640F, warm ivory ceramic, restrained charcoal accents. Orthographic three-quarter studio render, tactile subtle paper and ceramic textures, clean simple silhouette readable at 120px, centered with generous margin. Solid warm cream #FAF6EF background. No text, letters, numbers, logos, coins, currency symbols or watermark. Premium editorial architectural aesthetic, calm and understated.



### Collectibles — original, replaced

Use case: stylized-concept. Asset type: bespoke Chrome wallet collectibles empty-state illustration, square. A miniature sculptural gallery: two overlapping warm ivory ceramic picture frames standing on a low terracotta plinth, the front frame contains a simple burnt-orange arch sculpted in relief. Matte orange #F2640F, warm ivory ceramic, restrained charcoal accents. Orthographic three-quarter studio render, tactile subtle ceramic textures, clean simple silhouette readable at 120px, centered with generous margin. Solid warm cream #FAF6EF background. No text, letters, numbers, logos, coins, currency symbols or watermark. Premium editorial architectural aesthetic, calm and understated.


### Collectibles — current revision

Built-in imagegen edit prompt: Replace the collectibles empty-state artwork.
Use the official Arch logo reference: preserve its FOUR nested peaked chevrons
with gently rounded tips, open bottoms, no crossbar; do not substitute a rounded
doorway or letter A. Create two overlapping ivory collectible cards, front card
nearly face-on with the orange reference mark clearly printed flat on its face.
Subtle terracotta edges and ceramic/paper texture. Remove plant, spheres, plinth
and background. Center with generous margin, legible at 128px. Transparent alpha
background, no cream square, checkerboard, text or watermark. Brand orange #F2640F.

A background-extraction follow-up requested preserving the cards and marks and
removing all surrounding gray checkerboard pixels. The tool still returned RGB
with a baked-in checkerboard. With user authorization, local Pillow processing
flood-filled the neutral background from the canvas edges, contracted the mask
one pixel to remove contaminated edges, and downsampled with Lanczos onto a
transparent 384px canvas. The exported WebP has an alpha range of 0–255.
Visually checked at 128px against #0d0d0f and #faf6ef.
