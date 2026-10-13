// -----------------------------------------------------------------------------
// Entry point of the Spotify external integration: the SDK instance (connection,
// auth, reconnection handled for you), every handler registered by createApp()
// BEFORE connect(), then the connection. See src/app.js.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { createApp } from './src/app.js';

const gladys = new GladysIntegration();
createApp(gladys);

logger.info('Starting the Spotify integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
