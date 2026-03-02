# Augment standalone (Electron spike)

This directory is the first standalone desktop surface for desideratum 12.

## What it does

- Opens a native Electron window.
- Creates real PTY-backed terminal sessions (Python `pty` bridge, not simulated output).
- Supports multiple terminals as tabs.

## Files

- `main.cjs`: Electron main process + PTY session lifecycle + IPC.
- `preload.cjs`: Safe renderer bridge (`window.augmentApp`).
- `renderer.ts`: Tab UI + xterm instances + I/O wiring.
- `index.html`: Shell layout.
- `build.mjs`: Bundles `renderer.ts` to `renderer.js`.

## Run

1. Install project dependencies.
2. Install Electron dependencies:
   - `npm install --save-dev electron electron-builder`
3. Build renderer bundle:
   - `npm run electron:build`
4. Launch app in dev mode:
   - `npm run electron:dev`

## Package app artifacts

- Build unpacked app directory:
  - `npm run electron:pack`
- Build distributable zip:
  - `npm run electron:dist`

## Current constraints

- Uses `scripts/terminal_pty.py`, so behavior is currently Unix-first.
- No persistence yet for tab layout or terminal scrollback.
- No packaged distribution step yet (`electron-builder`/`forge` not added in this spike).
