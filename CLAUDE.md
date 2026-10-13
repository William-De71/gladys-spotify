# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration** for Spotify: a Node.js service
(Node 22+, ESM, no build step) running in its own sandboxed Docker container,
talking to Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It drives the user's Spotify Connect devices
through the official Spotify Web API, signed in with OAuth2 + PKCE and the
user's own Spotify developer application. Cloud only: Spotify pushes nothing,
the playback is read on a loop.

## Commands

```bash
npm install
npm test                                  # node --test, never touches the network
node --test test/app.test.js              # one file
node --test --test-name-pattern "scene"   # tests whose name matches
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npx github:GladysAssistant/integration-store . --skip-image-check
docs/illustrations/render.sh              # widget illustrations (docs/assets)
```

## Architecture

```
index.js                      SDK wiring only: createApp(new GladysIntegration()) + connect
src/app.js                    every handler, registered before connect(); the tests drive
                              it with the fake Gladys of the SDK (test/app.test.js)
src/SpotifyClient.js          Spotify Web API: PKCE, single-flight token refresh, calls
src/devices.js                discovery, setValue, playback loop (15 s), content loop (20 min)
src/convertToGladysDevice.js  one device per Spotify Connect device
src/convertContentDevice.js   the "Spotify" content device (3 selects)
src/content.js                playlists / recent / favorites -> select options
src/events.js                 scene triggers, on playback transitions only
src/sceneActions.js           play, pause, get_playback
src/transport.js              Cloud / Unreachable badge of each device
src/widgets.js                widget contents and their texts in en / fr / de / es
src/widgetHandlers.js         widget handlers, caches, actions
.github/scripts/release.mjs   version, changelog, version files, PR title checks
```

## Rules

- **External ids are forever**: `gladys.externalIds('spotify', <Spotify device id>)`
  and `('spotify', 'content')`, feature keys (`play`, `volume`,
  `playback-state`, `playlists`…), select option values (`none`, Spotify URIs),
  config, action, widget, widget button, scene trigger and action, field,
  variable and output keys too. Per feature, `category`, `type`, `unit`, `min`
  and `max` are compared by the "Update" button of the Discovery screen:
  `test/structure.test.js` checks them against
  `test/fixtures/discovery.baseline.json` (v1.4.1). A change needs an entry in
  its `ALLOWED_CHANGES` with the migration, in the changelog, the docs and the
  forum message.
- **Polling**: no Gladys polling (`should_poll` absent); the playback loop
  runs its own 15 s timer.
- **States**: `publishChangedStates` with a one-hour heartbeat, only for the
  features of created devices (an unknown feature makes the core refuse the
  batch). In `onDeviceCreated`: states again, transport badge, then
  `requestWidgetRefresh`.
- **Scene events** on transitions only, flat scalar data, never at startup
  and never caused by a scene action of this integration (`events.quiet()`).
- **Language**: Gladys does not send it with setValue or a scene action. The
  option labels of the content device are fixed (`Playlist`, `Récent`,
  `Favori`, a deliberate choice); everything a viewer reads in a widget
  follows its language.
- **The container rootfs is read-only**: the only state is the Gladys config
  (tokens, PKCE material). Never log a token or the Client Secret.
- **User-facing text** exists in en, fr, de and es: manifest,
  `src/widgets.js`, the messages of `src/app.js`, `docs/*.md`, `README*.md`.
  `test/i18n.test.js` checks it.
- **Widget illustrations**: `docs/assets/widgets.<lang>.png` are generated
  from the widget code by `docs/illustrations/render.sh`: run it again after
  any change to a widget content, and keep them labelled as illustrations.
- **Versions belong to the Release workflow**: never edit `version` in
  `package.json`, `package-lock.json` or the manifest, nor the `docker_image`
  tag.
- **Changelog**: Ne jamais éditer CHANGELOG.md à la main, il est généré à la
  release. Écris le titre de PR comme la ligne que l'utilisateur lira.
- **Style**: Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network.
