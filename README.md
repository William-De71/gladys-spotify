# gladys-spotify

External [Gladys Assistant](https://gladysassistant.com) integration to control your **Spotify Connect** devices (play, pause, next, previous, volume) through the Spotify Web API.

Built on the [Gladys integration SDK](https://github.com/GladysAssistant/integration-sdk-js), from the [official template](https://github.com/GladysAssistant/integration-template-js).

## What it does

| Spotify object          | Gladys support                                      |
| ----------------------- | --------------------------------------------------- |
| Spotify Connect devices | One Gladys device per online device                 |
| Playback                | Play, pause, previous, next (transport control)     |
| Volume                  | Set the volume of the active device (0-100)         |
| Playback state          | Read-only playing/paused state, pushed in real time |

A **Spotify Premium** account is required to control playback.

## Architecture

```
index.js                     SDK wiring: OAuth2 flow, handlers, manifest actions
src/SpotifyClient.js         Spotify Web API client: OAuth (PKCE), token refresh, calls
src/devices.js               discovery / setValue / playback-state push orchestration
src/convertToGladysDevice.js Spotify device -> Gladys device/feature conversion
src/constants.js             endpoints, scopes, config keys, timings
```

## Authentication model (OAuth2 + PKCE)

The user creates a Spotify application and pastes its **Client ID** and **Client Secret** in the configuration screen (`config_schema`). Clicking the **"Connect with Spotify"** button (an `oauth2` config field) starts the OAuth2 authorization code flow with PKCE:

- `onOAuthAuthorizeUrl` builds the Spotify authorization URL (scopes, `state`, PKCE `code_challenge`);
- `onOAuthCallback` exchanges the returned code for the access + refresh tokens.

Tokens are persisted through `gladys.setConfig()` under keys **not** declared in the `config_schema` (internal storage, never shown in the UI) and refreshed automatically. Two manifest actions are exposed: **Test the connection** and **Disconnect**.

## Local development

```bash
npm install
GLADYS_HOST_API_URL="http://localhost:1443" \
GLADYS_INTEGRATION_TOKEN="<token>" \
GLADYS_INTEGRATION_SELECTOR="spotify" \
npm start
```

```bash
npm test          # unit tests (node --test)
npm run lint      # eslint
npm run format    # prettier
```

## License

Apache-2.0
