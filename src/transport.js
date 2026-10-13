// -----------------------------------------------------------------------------
// Transport badge of each device (Gladys "Cloud" badge on the device card).
//
// Everything goes through the Spotify cloud. A Spotify Connect device only
// appears in GET /me/player/devices while Spotify runs on it: absent, it is
// `unreachable` (a command would fail with "device not found"). The content
// device answers whenever the account is connected.
//
// Published only when a badge changes, for the devices the user created.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS } from '@gladysassistant/integration-sdk';

import { spotifyDeviceIdFromDevice } from './devices.js';
import { DEVICE_TYPE } from './constants.js';

const CONTENT_DEVICE_ID = 'content';

/**
 * The badge of every created Spotify device.
 * @param {Array<object>} createdDevices - gladys.devices.
 * @param {object} options - Options.
 * @param {boolean} options.connected - Whether the Spotify account is connected.
 * @param {Set<string>|null} options.onlineIds - Spotify ids of the online
 *   devices, null when the list could not be read (badges left as they are).
 * @param {string} options.prefix - External id prefix of this integration's
 *   devices (`ext:<selector>:spotify:`).
 * @returns {Array<{external_id: string, transport: string}>} The badges.
 * @example
 * transportsOf(gladys.devices, { connected: true, onlineIds, prefix });
 */
export function transportsOf(createdDevices, { connected, onlineIds, prefix }) {
  return (createdDevices || [])
    .filter((device) => typeof device.external_id === 'string')
    .filter((device) => device.external_id.startsWith(prefix))
    .flatMap((device) => {
      const id = spotifyDeviceIdFromDevice(device.external_id);
      if (!connected) {
        return [{ external_id: device.external_id, transport: DEVICE_TRANSPORTS.UNREACHABLE }];
      }
      if (id === CONTENT_DEVICE_ID) {
        return [{ external_id: device.external_id, transport: DEVICE_TRANSPORTS.CLOUD }];
      }
      if (!onlineIds) {
        return [];
      }
      return [
        {
          external_id: device.external_id,
          transport: onlineIds.has(id) ? DEVICE_TRANSPORTS.CLOUD : DEVICE_TRANSPORTS.UNREACHABLE,
        },
      ];
    });
}

/**
 * Publish the badges that changed since the last call.
 * @param {object} gladys - The Gladys SDK instance.
 * @returns {Function} `async ({ connected, onlineIds }) => void`; `forget()` on
 *   it publishes everything again next time (device created, reconnection).
 * @example
 * const publishTransports = createTransportPublisher(gladys);
 * await publishTransports({ connected: true, onlineIds: new Set(['abc']) });
 */
export function createTransportPublisher(gladys) {
  const published = new Map();
  const publish = async ({ connected, onlineIds }) => {
    const prefix = `${gladys.externalIds(DEVICE_TYPE, 'x').device.slice(0, -1)}`;
    const changed = transportsOf(gladys.devices, { connected, onlineIds, prefix }).filter(
      (entry) => published.get(entry.external_id) !== entry.transport,
    );
    if (changed.length === 0) {
      return;
    }
    await gladys.publishTransports(changed);
    changed.forEach((entry) => published.set(entry.external_id, entry.transport));
  };
  publish.forget = () => published.clear();
  return publish;
}
