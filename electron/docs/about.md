# ℹ️ About

The About tab has two sub-tabs:

## About

Shows the app name + version and a one-line description of Frontdesk Operator.

## Guide

This is the **documentation browser** — the page you're reading now. It lists the end-user guides
for every tab in the app:

- 🏠 Overview & Getting Started
- 🌐 Netlify / Frontdesk Setup
- 📊 Dashboard
- 🔴 Queue
- 📄 Logs
- 👥 Sessions
- 🔑 Licenses
- 🔐 Accounts & Keys
- ⚙️ Config
- 🧰 Tools
- 📜 Scripts
- 💬 Chat
- 🎨 Appearance
- ℹ️ About (this page)

Pick a title from the list to view that guide. The guides are Markdown files stored under
`electron/docs/` in the repo — add a file there (or a new `##` topic in the file you want to
expand) and it shows up in this list.

## Notes

- The version shown comes from the app package (`electron/package.json`).
- This app is the **operator control plane**; the public-facing chat webapp and its hosting are
  described in 🌐 Netlify / Frontdesk Setup.
