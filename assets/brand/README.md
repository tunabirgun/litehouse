# Litehouse identity

Litehouse uses a monochrome, typographic identity based on EB Garamond. The
primary logo is the `Litehouse` wordmark. The compact `Lh` lettermark is for
application icons, favicons, avatars, and constrained interface placements.

## Source files

- `litehouse-wordmark.svg` — adaptive horizontal wordmark
- `litehouse-lettermark.svg` — adaptive square lettermark

Both SVGs have transparent backgrounds. With `data-theme="auto"`, they follow
`prefers-color-scheme`. When used inline, set `data-theme="light"` or
`data-theme="dark"` to follow the Litehouse application theme explicitly.

The editable SVGs use EB Garamond with Garamond and system-serif fallbacks.
Litehouse should bundle EB Garamond so the wordmark is rendered consistently.

## PNG files

- `png/litehouse-lettermark-light.png` and `png/litehouse-lettermark-dark.png` —
  512 px square presentation versions
- `png/litehouse-wordmark-light.png` and `png/litehouse-wordmark-dark.png` —
  1200 × 360 px presentation versions
- `png/lettermark/{ink,ivory}/` — transparent production exports from 16 px
  through 1024 px
- `png/wordmark/{ink,ivory}/` — transparent production exports at 512 px,
  1024 px, and 2048 px widths

The platform icon set under `src-tauri/icons/` is generated from the square
lettermark for the sizes required by macOS, Windows, and Linux.

## Colors

- Carbon ink: `#211F1A`
- Ivory ink: `#F1EBDF`
- Light presentation surface: `#F4F0E6`
- Dark presentation surface: `#11100D`

The identity is strictly monochrome. The SVG artwork has a transparent surface;
the PNG presentation files include the approved light or dark surface.

## Usage

- Prefer the wordmark in navigation, reports, websites, and about screens.
- Prefer the lettermark for square or compact placements.
- Preserve clear space equal to the cap height of the wordmark's lowercase `i`.
- Do not add outlines, gradients, shadows, enclosing badges, or pictorial motifs.
- Do not stretch, condense, rotate, or recolor individual letters.
- Use the lettermark at 24 px or larger when possible; use the 16 px export only
  where a platform requires it.
