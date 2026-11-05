# RM Context — Brand Guidelines

**Product:** RM Context · **Organization:** RM Template · **Plugin id:** `rm-context`
**Tagline:** *Your Project Intelligence Layer for AI Coding Agents.*  
**Website:** [rmtemplate.com](https://rmtemplate.com)

## The mark

The symbol is an uppercase **R** drawn as a graph:

- **Edges** form the letter: the stem, the bowl and the leg are each one edge, stroked at uniform weight with round caps.
- **Nodes** appear only where edges start, end or meet: the top of the stem, the foot of the stem, the end of the leg, and the **hub**, where the bowl returns and the leg departs.
- **The hub is the only accent-coloured node.** It is the point where knowledge connects, so the graph reads as structure rather than decoration.

Geometry sits on a 96-unit grid. The stem runs x=30 from y20 to y76. The bowl is `M30 20 H48 A15 15 0 0 1 48 50 H30`. The leg runs from the hub (46,50) to (68,76). Strokes are 8 units, terminal nodes r=7, and the hub is r=9 with a 3-unit ring in the background colour.

## Files

| File | Use |
|---|---|
| `assets/icon.svg` | App/marketplace/terminal icon: tile with the white mark. Readable down to 16 px. |
| `assets/logo.svg` | Primary lockup: tile and wordmark. Default choice on light or neutral backgrounds. |
| `assets/logo-light.svg` | Tile-less mark and wordmark for light backgrounds. |
| `assets/logo-dark.svg` | Tile-less mark and wordmark for dark backgrounds. |
| `assets/banner.svg` | README / social banner, 1280×360. |
| `.claude-plugin/icon.png` | 512×512 PNG rendered from `icon.svg` for the plugin directory, which does not accept SVG. |

All files are hand-written vector SVG with no embedded raster images. Regenerate the PNG after changing `icon.svg` (see *Development* in the README).

## Colour

| Token | Hex | Use |
|---|---|---|
| Charcoal | `#16161D` | Primary: tile, marks and text on light backgrounds |
| Violet | `#7C6FF7` | Hub on charcoal; accents on dark UI |
| Violet (deep) | `#5B4CF0` | Hub/accent on white, links in light UI |
| Violet (light) | `#8F84FF` | Hub on transparent dark backgrounds |
| Paper | `#F4F4F7` / `#FFFFFF` | Marks on dark backgrounds |
| Muted | `#A9A9B8` | Secondary text on dark |

Use violet sparingly: one accent element per composition. No gradients, glows or 3D effects.

## Typography

The wordmark is set in **Inter** (fallbacks: Segoe UI, Helvetica Neue, Arial): **RM** at weight 700 and *Context* at weight 500, with tight tracking. The SVG wordmarks use live text so they stay editable. Convert them to outlines in a vector editor before print or any use where the font may be missing.

## Clear space and minimum size

- Keep clear space equal to the tile's corner radius (22 units at 96) on all sides.
- Minimum icon size is 16 px. Below 24 px use `icon.svg` without the wordmark.

## Don'ts

Don't recolour the edges and nodes differently from each other. Don't add nodes along the edges. Don't rotate, outline or stretch the mark. Don't place `logo-light.svg` on dark backgrounds. Don't reintroduce the retired retro raster logos (`assets/rm-context-logo.png`, `assets/rm-context-banner.png`).
