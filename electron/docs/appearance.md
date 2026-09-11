# 🎨 Appearance

The Appearance tab controls the app's **color theme**, **accent color** and **font size**.
Everything applies immediately and is saved to config (`config.json`, or `.env` when
`config.json` is absent) — no restart needed.

## Theme

- **☀️ Light**
- **🌙 Dark**
- **🖥️ System** — follows macOS: the native window chrome and this dashboard both update when the
  OS theme changes.

Saved to `APPEARANCE_THEME`.

## Accent color

Drives `--accent`: buttons, main CTAs, active sidebar/tab items, agent chat bubbles and highlights.

- **Nine presets** — *Theme default* (the built-in crimson in dark / brick red in light), Blue,
  Green, Purple, Pink, Orange, Red, Teal and Yellow.
- **Custom** — pick any color with the OS color picker (stored as `#rrggbb`).

Saved to `APPEARANCE_ACCENT_COLOR`. Choosing *Theme default* (or blanking the field in ⚙️ Config)
removes the override, so the theme's own accent is used again.

## Font size

A preset that scales the **whole UI** — every size in the stylesheet is rem-based, driven by a
`--fs-scale` value on the root element:

| Preset | Scale | Description |
| --- | --- | --- |
| Small | 0.85 | Compact view |
| Medium | 1.00 | Default size |
| Large | 1.15 | Easier reading |
| X-L | 1.35 | Extra large |
| XX-L | 1.60 | Double extra large |

Saved to `APPEARANCE_FONT_SIZE`.

## Notes

- All three settings can also be edited as fields in ⚙️ Config → Appearance.
- Choosing **System** uses the OS preference live — toggling dark mode in macOS updates the app
  without reopening it.
- Layout adapts to the chosen font size (including the collapsible Dashboard service sidebar).
