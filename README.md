# Brisk

A personal, lightweight browser built on Chromium (via Electron) with Brave-style ad and tracker blocking, a clean UI, and bookmark/settings sync across your Mac and Windows computers through your own Google Drive.

## What it does

- **Shields**: blocks ads and trackers with EasyList, EasyPrivacy and related lists (Ghostery's open-source engine), hides leftover ad boxes, and shows a per-page blocked count. Turn shields off per site from the shield button.
- **Privacy defaults**: upgrades connections to HTTPS (falls back automatically), sends Global Privacy Control, presents a plain Chrome user agent, keeps history local only, asks before sites use your camera, mic, location or notifications.
- **Private windows**: nothing is written to disk; everything is erased when the window closes.
- **Sync**: bookmarks, settings and per-site shield choices sync through a hidden app folder in *your* Google Drive. No server, nobody else's cloud.
- **Chrome extensions**: install from the Chrome Web Store with its normal *Add to Chrome* button. Extension buttons appear in the toolbar, popups and right-click items work, and extensions update automatically. Manage them at menu → Extensions.
- **Profiles**: separate profiles (e.g. Personal and Work), each with its own sign-ins, bookmarks, extensions, history, settings, Google sync account, name, picture and color. Switch from the avatar button next to the menu.
- **Bookmark folders**: folders on the bookmarks bar open as dropdowns, extra items collapse behind », and there's an Other bookmarks folder. The manager has a folder tree, drag-and-drop, search, and import/export that keeps folders.
- **Theme colors**: pick a color per profile (Settings → Appearance or the Profiles page); it tints the window and accents. Light/dark/system theme.
- **Everyday browser stuff**: tabs (drag to reorder, mute, reopen closed), address bar with suggestions from bookmarks and history, bookmarks bar and manager, import from Brave/Chrome, find in page, zoom, downloads, session restore, light/dark theme, keyboard shortcuts you already know.

## Download

Get the latest version from **[Releases](https://github.com/EnterTheHero/brisk/releases/latest)**:
- Windows: `Brisk-Setup-<version>.exe`. Brisk then updates itself in the background.
- Mac: `…-mac-AppleSilicon.zip` (M1–M4) or `…-mac-Intel.zip`. Brisk tells you when a new version is out.

Each new version is built automatically by GitHub Actions when a version tag (e.g. `v0.5.1`) is pushed.

## Install on Windows

Double-click **Brisk-Setup-<version>.exe**. It isn't code-signed, so Windows SmartScreen shows "Windows protected your PC": click **More info → Run anyway**. Then follow the installer. It installs just for your user (no admin needed) and adds Start menu and desktop shortcuts.

## Run from source

You need **Node.js 20 or newer** (the LTS installer from nodejs.org is fine) on each computer.

```bash
cd brisk
npm install
npm start
```

The first launch downloads the filter lists (a few seconds). After that they're cached and refreshed every 3 days.

## Build an installer

Build on the platform you're targeting:

```bash
npm run dist:mac   # on your Mac → release/Brisk-0.1.0-arm64.dmg (and x64)
npm run dist:win   # on Windows (or Linux with Wine) → release/Brisk-Setup-<version>.exe
```

The builds aren't code-signed, so the first launch needs one extra click:

- **Mac**: right-click Brisk in Applications → **Open** → **Open**. (Or run `xattr -cr /Applications/Brisk.app`.)
- **Windows**: on the SmartScreen prompt click **More info** → **Run anyway**.

## Set up sync (one time, about 5 minutes)

Brisk talks to Google Drive using an OAuth client that belongs to you. Make it once and use it on every computer.

1. Go to <https://console.cloud.google.com/>, create a project (e.g. "Brisk").
2. **APIs & Services → Library** → enable **Google Drive API**.
3. **Google Auth Platform → Branding**: enter an app name and your email.
   - **Audience**: if you're on a Google Workspace account, choose **Internal** (no review, tokens don't expire).
   - With a personal Gmail account choose **External**, add yourself under **Test users**, then click **Publish app**. Leaving it in "Testing" works, but Google expires the sign-in every 7 days.
4. **Clients → Create client → Desktop app**. Copy the Client ID and Client secret.
5. In Brisk open **Settings** (⌘, / menu → Settings), paste both values, click **Save**, then **Connect**. Approve in the browser tab that opens.
6. On your other computer(s): paste the same Client ID/secret and click **Connect** with the same Google account.

Sync runs at launch, every 5 minutes, and a few seconds after any change. Edits from different computers are merged item by item (newest change wins), and deletions carry over.

**What's stored**: one JSON file (`brisk-sync.json`) in Drive's hidden app-data area, readable only by your OAuth client. The scope requested is `drive.appdata`, so Brisk can't see any of your other Drive files. The sign-in token is encrypted with macOS Keychain / Windows DPAPI.

## Keyboard shortcuts

| Action | Mac | Windows |
|---|---|---|
| New tab / window / private window | ⌘T / ⌘N / ⇧⌘N | Ctrl+T / Ctrl+N / Ctrl+Shift+N |
| Close tab / reopen closed tab | ⌘W / ⇧⌘T | Ctrl+W / Ctrl+Shift+T |
| Address bar | ⌘L | Ctrl+L or Alt+D |
| Next / previous tab | ⌃Tab / ⌃⇧Tab | Ctrl+Tab / Ctrl+Shift+Tab |
| Go to tab 1–8 / last tab | ⌘1–8 / ⌘9 | Ctrl+1–8 / Ctrl+9 |
| Bookmark page / manager | ⌘D / ⌥⌘B | Ctrl+D / Ctrl+Shift+O |
| Toggle bookmarks bar | ⇧⌘B | Ctrl+Shift+B |
| Find / next / previous | ⌘F / ⌘G / ⇧⌘G | Ctrl+F / F3 / Shift+F3 |
| Back / forward | ⌘[ / ⌘] | Alt+← / Alt+→ |
| Reload / hard reload | ⌘R / ⇧⌘R | Ctrl+R or F5 / Ctrl+Shift+R |
| Zoom in / out / reset | ⌘= / ⌘- / ⌘0 | Ctrl+= / Ctrl+- / Ctrl+0 |
| Developer tools | ⌥⌘I | F12 |

## Known limitations

- **Netflix, Disney+, Hulu, Spotify web (DRM video/audio)** won't play. Stock Electron doesn't include Google's Widevine module. Fixable later by switching to Castlabs' Electron build, which adds it.
- **Extensions**: most work, but Electron implements only part of Chrome's extension API. Ones that depend on Chrome-only features (e.g. `chrome.alarms` in some, Chrome sign-in identity, side panels) may misbehave. Only Manifest V3 extensions install (same as current Chrome). Extensions don't sync between computers yet.
- **Google sign-in on websites**: usually works because Brisk identifies as Chrome, but Google occasionally blocks sign-ins from non-Chrome browsers. If it happens, sign in once in a popup or use a passkey.
- **Memory**: it runs the same Chromium engine as Brave and Chrome, so per-tab memory is similar. The speed gain comes from blocking ad and tracker requests and from having no extra services running in the background.
- **Auto-update**: not set up. To update, pull new code and rebuild.

## Project layout

```
src/
  main.js          app startup, sessions, permissions, downloads, menus, IPC
  window.js        one browser window: tabs, navigation, context menus
  shields.js       ad/tracker blocking, HTTPS upgrade, GPC
  extensions.js    Chrome Web Store installs + chrome.* extension APIs
  sync.js          Google sign-in + Drive app-data sync
  merge.js         conflict-free merge used by sync (unit-tested)
  store.js         local bookmarks, settings, history, session
  url-utils.js     address bar: URL vs. search (unit-tested)
  preload-ui.js    bridge for the toolbar
  preload-pages.js bridge for brisk:// pages only
  ui/              tab strip, address bar, bookmarks bar, find bar
  pages/           brisk://newtab, settings, bookmarks, extensions, error
test/              unit tests (npm test) and headless smoke tests
```

Your data lives in the app's data folder: `~/Library/Application Support/Brisk` on Mac, `%APPDATA%\Brisk` on Windows.

## Ideas for next versions

- Bookmark folders, history page (brisk://history)
- Vertical tabs / tab groups
- Castlabs Electron for Netflix/Spotify
- Per-site settings (cookies, JavaScript, autoplay)
- Fingerprinting protections (canvas/audio noise like Brave)
- Auto-update via GitHub Releases
