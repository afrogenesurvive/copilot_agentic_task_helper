# 🎨 Appearance

The Appearance tab controls the app's **color theme**, **accent color**, **font size** and
**sidebar width**. The first three apply immediately and are saved to config (`config.json`, or `.env`
when `config.json` is absent) — no restart needed. The sidebar width is a per-machine preference and
is stored locally instead (`localStorage`), because it is about this display rather than this account.

## Theme

- **Light**
- **Dark** (the default)
- **System** — follows macOS: the native window chrome and this dashboard both update when the
  OS theme changes.

Saved to `APPEARANCE_THEME`.

## Accent color

Drives `--accent`: primary buttons, active sidebar and tab items, focus rings, log source labels and
highlights. Two derived tokens follow it automatically — `--accent-hover` (80% alpha) and
`--accent-border` (27% alpha).

- **Ten presets** — *Theme default* (the built-in blue in dark / near-white in light), Blue, Green,
  Purple, Pink, Orange, Red, Teal, Yellow and Grey.
- **Custom** — pick any color with the OS color picker (stored as `#rrggbb`).

Saved to `APPEARANCE_ACCENT_COLOR`. Choosing *Theme default* (or blanking the field in ⚙️ Config)
removes the override, so the theme's own accent is used again.

## Font size

A preset that scales **text only**. `--fs-scale` multiplies the *root* font size, so every `rem`/`em`
size in the stylesheets follows it while the `px` paddings, radii and borders stay put — a larger
preset reads as bigger type rather than a zoomed-in window.

| Preset | Scale | Description |
| --- | --- | --- |
| Small | 0.85 | Compact view |
| Medium | 1.00 | Default size |
| Large | 1.15 | Easier reading |
| X-L | 1.35 | Extra large |
| XX-L | 1.60 | Double extra large |

Saved to `APPEARANCE_FONT_SIZE`.

## Sidebar width

A slider (200–420 px) that also has a drag handle on the sidebar's right edge. The width is written to
`--sidebar-width` live while dragging and persisted only on release. Stored in `localStorage` under
`frontdesk.sidebarWidth`.

## Notes

- Theme, accent color and font size can also be edited as fields in ⚙️ Config → Appearance.
- Choosing **System** uses the OS preference live — toggling dark mode in macOS updates the app
  without reopening it.
- Layout adapts to the chosen font size (including the collapsible Dashboard service sidebar).

## Where the tokens live

`electron/src/renderer/tokens.js` is the single source of truth for the palette, the font presets and
the token names. It is written as plain browser JS exposing `window.Appearance`, and the main process
imports nothing from it — but `electron/src/main.js`'s `WINDOW_BG` map is kept in sync by hand, so the
window's pre-paint background matches the theme instead of flashing white.

The stylesheets never mention a theme: they only use `var(--token)`. There is no `.dark` block
anywhere; dark is the default and `data-theme="light"` exists as a hook for light-only overrides.

Status colors are deliberately **not** theme-customisable. `--color-red`, `--color-yellow` and
`--color-green` are re-written to the same constants on every apply, so "bad" can never be confused
with "accent".

### Do not add inline styles

The renderer pins `style-src 'self'` with no `'unsafe-inline'`. That blocks inline `style="…"`
attributes **and** `<style>` blocks — both are silently dropped, with only a console warning. Tokens
are written with `element.style.setProperty()` (CSSOM, which CSP does not govern) and every visual
rule lives in an external stylesheet. If you need a per-element color, use a `data-*` attribute and an
attribute selector — that is how the accent swatches work (`components/_appearance-panel.css`).
