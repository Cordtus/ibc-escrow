// ibcUtils.js
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import logger from './logger.js';
import { makeRequest } from './chainUtils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, 'data');
const IBC_DATA_DIR = path.join(DATA_DIR, 'ibc');

// Helper function to parse IBC paths that handles complex base denoms
function parseIBCPath(path) {
  // Find the first occurrence of 'transfer/channel-'
  const transferIndex = path.indexOf('transfer/channel-');
  if (transferIndex === -1) {
    throw new Error(`Invalid IBC path structure: ${path}`);
  }

  // Extract the port and channel
  const pathComponents = path.slice(transferIndex).split('/');
  if (pathComponents.length < 2) {
    throw new Error(`Invalid IBC path format: ${path}`);
  }

  return {
    port: pathComponents[0],
    channel: pathComponents[1],
    // Any remaining components would be part of the chain name or base denom
    remainingPath: pathComponents.slice(2).join('/')
  };
}

async function loadIBCData(chain1, chain2) {
  logger.info(`Loading IBC data for ${chain1} and ${chain2}`);

  try {
    const files = await fs.readdir(IBC_DATA_DIR);
    const matchingFile = files.find(
      (file) =>
      file.toLowerCase().includes(chain1.toLowerCase()) &&
      file.toLowerCase().includes(chain2.toLowerCase())
    );

    if (!matchingFile) {
      logger.error(`No matching IBC data file found for ${chain1} and ${chain2}`);
      logger.info('Available IBC data files:', files);
      throw new Error(`No matching IBC data file found for ${chain1} and ${chain2}`);
    }

    const filePath = path.join(IBC_DATA_DIR, matchingFile);
    const data = await fs.readFile(filePath, 'utf8');
    const ibcData = JSON.parse(data);

    const isChain1Primary = ibcData.chain_1.chain_name.toLowerCase() === chain1.toLowerCase();

    if (!isChain1Primary) {
      logger.info('Swapping chain_1 and chain_2 in IBC data');
      [ibcData.chain_1, ibcData.chain_2] = [ibcData.chain_2, ibcData.chain_1];
      ibcData.channels.forEach((channel) => {
        [channel.chain_1, channel.chain_2] = [channel.chain_2, channel.chain_1];
      });
    }

    logger.info('IBC data loaded successfully');
    return ibcData;
  } catch (error) {
    logger.error(`Error loading IBC data for ${chain1}-${chain2}:`, {
      error: error.message,
    });
    throw error;
  }
}

function hashIBCDenom(portId, channelId, denom) {
  logger.info(`Hashing IBC denom: ${portId}/${channelId}/${denom}`);
  // The denom might contain forward slashes, but that's OK - we hash the entire string
  const ibcDenom = `${portId}/${channelId}/${denom}`;
  const hash = crypto.createHash('sha256').update(ibcDenom).digest('hex');
  const result = `ibc/${hash.toUpperCase()}`;
  logger.info(`Hashed IBC denom: ${result}`);
  return result;
}

function validateId(id, type) {
  logger.info(`Validating ${type} ID: ${id}`);
  const regex = /^[a-zA-Z]+-[0-9]{1,5}$/;
  if (!regex.test(id)) {
    logger.error(`Invalid ${type} ID format: ${id}`);
    throw new Error(
      `Invalid ${type} ID format. Expected format like 'xxx-0' where 'xxx' can be 'channel', 'connection', or 'client' followed by up to 5 digits.`
    );
  }
  logger.info(`${type} ID validated successfully`);
}

async function recursiveUnwrap(chainInfo, denom, path = []) {
  // Base case: If denom is not IBC-prefixed, return the denom and path
  if (!denom.startsWith('ibc/')) {
    logger.info(`Resolved base denom: ${denom} on chain: ${chainInfo.chain_name}`);
    return { baseDenom: denom, path };
  }

  const hash = denom.split('/')[1];
  const tracePath = `/ibc/apps/transfer/v1/denom_traces/${hash}`;

  let traceData;
  try {
    traceData = await makeRequest(chainInfo.apis.rest.map(api => api.address), tracePath);
  } catch (error) {
    logger.error(`Error fetching denom trace for ${denom} on ${chainInfo.chain_name}:`, error.message);
    return { baseDenom: denom, path };
  }

  if (!traceData || !traceData.denom_trace) {
    logger.warn(`No denom trace found for ${denom} on ${chainInfo.chain_name}`);
    return { baseDenom: denom, path };
  }

  const trace = traceData.denom_trace;

  try {
    // Use the new parsing function to handle complex paths
    const { port, channel, remainingPath } = parseIBCPath(trace.path);

    // Append the current step to the path
    path.push({
      chain: chainInfo.chain_name,
      channel: channel,
      port: port,
      // Store the full base denom to maintain the complete path
      baseDenom: trace.base_denom
    });

    // Only attempt to load chain info if we have a valid chain name
    if (remainingPath && !remainingPath.includes('/')) {
      try {
        const nextChainInfo = await loadChainInfo(remainingPath);
        if (nextChainInfo) {
          return recursiveUnwrap(nextChainInfo, trace.base_denom, path);
        }
      } catch (error) {
        logger.warn(`Could not load chain info for ${remainingPath}, treating as final hop`);
      }
    }

    // If we can't load the next chain or the path is complex, return current results
    return { baseDenom: trace.base_denom, path };

  } catch (error) {
    logger.error(`Error parsing IBC path for ${denom}:`, error.message);
    return { baseDenom: trace.base_denom, path };
  }
}

async function fetchIBCData(primaryChain, secondaryChain) {
  logger.info(`Fetching IBC data for ${primaryChain} and ${secondaryChain}`);

  // Sort chain names alphabetically to match file naming convention
  const [firstChain, secondChain] = [primaryChain, secondaryChain].sort();

  // Load IBC data
  const ibcData = await loadIBCData(firstChain, secondChain);
  if (!ibcData || typeof ibcData !== 'object') {
    logger.error(`Unable to load valid IBC data for ${firstChain}-${secondChain}`);
    throw new Error(`Unable to load valid IBC data for ${firstChain}-${secondChain}`);
  }

  if (
    !ibcData.chain_1 ||
    !ibcData.chain_2 ||
    !ibcData.channels ||
    !Array.isArray(ibcData.channels) ||
    ibcData.channels.length === 0
  ) {
    logger.error(`Invalid IBC data structure for ${firstChain}-${secondChain}`);
    throw new Error(`Invalid IBC data structure for ${firstChain}-${secondChain}`);
  }

  logger.info('Loaded IBC data:', JSON.stringify(ibcData, null, 2));

  // Determine if the primary chain is chain_1 or chain_2 in the loaded data
  const isPrimaryChain1 = ibcData.chain_1.chain_name === primaryChain;

  // Extract data based on whether primary chain is chain_1 or chain_2
  const primaryChainData = isPrimaryChain1 ? ibcData.chain_1 : ibcData.chain_2;
  const secondaryChainData = isPrimaryChain1 ? ibcData.chain_2 : ibcData.chain_1;
  const primaryChannelData = isPrimaryChain1 ? ibcData.channels[0].chain_1 : ibcData.channels[0].chain_2;
  const secondaryChannelData = isPrimaryChain1 ? ibcData.channels[0].chain_2 : ibcData.channels[0].chain_1;

  if (
    !primaryChainData ||
    !secondaryChainData ||
    !primaryChannelData ||
    !secondaryChannelData
  ) {
    logger.error('Unable to extract required data from IBC data');
    throw new Error('Unable to extract required data from IBC data');
  }

  logger.info('Primary chain data:', JSON.stringify(primaryChainData, null, 2));
  logger.info('Secondary chain data:', JSON.stringify(secondaryChainData, null, 2));

  const channelId = primaryChannelData.channel_id;
  const counterpartyChannelId = secondaryChannelData.channel_id;

  if (!channelId || !counterpartyChannelId) {
    logger.error('Unable to determine channel IDs');
    throw new Error('Unable to determine channel IDs');
  }

  logger.info(`Primary channel ID: ${channelId}`);
  logger.info(`Secondary (counterparty) channel ID: ${counterpartyChannelId}`);

  validateId(channelId, 'channel ID');
  validateId(counterpartyChannelId, 'counterparty channel ID');

  const output = {
    client_id: primaryChainData.client_id,
    connection_id: primaryChainData.connection_id,
    counterparty_client_id: secondaryChainData.client_id,
    counterparty_connection_id: secondaryChainData.connection_id,
    channel_id: channelId,
    counterparty_channel_id: counterpartyChannelId,
  };

  logger.info('IBC data fetched successfully', { output });
  return output;
}

async function validateIBCData(
  ibcData,
  primaryChainInfo,
  secondaryChainInfo,
  primaryChain
) {
  logger.info('Starting IBC data validation');

  // Check if ibcData and its properties exist
  if (!ibcData || typeof ibcData !== 'object') {
    logger.error(
      'Invalid IBC data: ibcData is null, undefined, or not an object'
    );
    return false;
  }

  if (
    !ibcData.chain_1 ||
    !ibcData.chain_2 ||
    !ibcData.channels ||
    !Array.isArray(ibcData.channels) ||
    ibcData.channels.length === 0
  ) {
    logger.error('Invalid IBC data structure: missing required properties');
    return false;
  }

  if (
    typeof ibcData.chain_1.chain_name !== 'string' ||
    typeof ibcData.chain_2.chain_name !== 'string'
  ) {
    logger.error('Invalid IBC data: chain_name is missing or not a string');
    return false;
  }

  const primaryRestEndpoint = primaryChainInfo.apis.rest[0].address;
  const isPrimaryChain1 = ibcData.chain_1.chain_name === primaryChain;
  const primaryChainData = isPrimaryChain1 ? ibcData.chain_1 : ibcData.chain_2;
  const secondaryChainData = isPrimaryChain1
  ? ibcData.chain_2
  : ibcData.chain_1;

  if (!primaryChainData || !secondaryChainData) {
    logger.error('Unable to determine primary and secondary chain data');
    return false;
  }

  const channelData = ibcData.channels[0];
  if (!channelData || !channelData.chain_1 || !channelData.chain_2) {
    logger.error('Invalid channel data structure');
    return false;
  }

  const channelId = isPrimaryChain1
  ? channelData.chain_1.channel_id
  : channelData.chain_2.channel_id;
  if (!channelId) {
    logger.error('Unable to determine channel ID');
    return false;
  }

  const portId = 'transfer'; // Default port ID

  try {
    const nodeInfo = await makeRequest(
      [primaryRestEndpoint],
      '/cosmos/base/tendermint/v1beta1/node_info'
    );
    const chainId = nodeInfo.default_node_info.network;

    const channelData = await makeRequest(
      [primaryRestEndpoint],
      `/ibc/core/channel/v1/channels/${channelId}/ports/${portId}`
    );
    const counterpartyChannelId = channelData.channel.counterparty.channel_id;
    const connectionId = channelData.channel.connection_hops[0];

    const connectionData = await makeRequest(
      [primaryRestEndpoint],
      `/ibc/core/connection/v1/connections/${connectionId}`
    );
    const clientId = connectionData.connection.client_id;
    const counterpartyClientId =
    connectionData.connection.counterparty.client_id;
    const counterpartyConnectionId =
    connectionData.connection.counterparty.connection_id;

    const clientState = await makeRequest(
      [primaryRestEndpoint],
      `/ibc/core/channel/v1/channels/${channelId}/ports/${portId}/client_state`
    );
    const counterpartyChainId =
    clientState.identified_client_state.client_state.chain_id;

    if (chainId !== primaryChainInfo.chain_id) {
      logger.error('Chain ID mismatch');
      return false;
    }

    if (counterpartyChainId !== secondaryChainInfo.chain_id) {
      logger.error('Counterparty Chain ID mismatch');
      return false;
    }

    if (clientId !== primaryChainData.client_id) {
      logger.error('Client ID mismatch');
      return false;
    }

    if (connectionId !== primaryChainData.connection_id) {
      logger.error('Connection ID mismatch');
      return false;
    }

    if (
      counterpartyChannelId !==
      (isPrimaryChain1
      ? ibcData.channels[0].chain_2.channel_id
      : ibcData.channels[0].chain_1.channel_id)
    ) {
      logger.error('Counterparty Channel ID mismatch');
      return false;
    }

    if (counterpartyClientId !== secondaryChainData.client_id) {
      logger.error('Counterparty Client ID mismatch');
      return false;
    }

    if (counterpartyConnectionId !== secondaryChainData.connection_id) {
      logger.error('Counterparty Connection ID mismatch');
      return false;
    }

    if (!/^07-tendermint-[0-9]{1,5}$/.test(clientId)) {
      logger.warn(
        `Unexpected format in fetched client ID. Received: ${clientId}`
      );
    }

    logger.info('IBC data validated successfully');
    return true;
  } catch (error) {
    logger.error('Error during IBC data validation:', { error: error.message });
    return false;
  }
}

// Helper function to retry API requests with exponential backoff
async function retryRequest(fn, maxRetries = 3, initialDelay = 1000) {
  let retries = 0;
  while (retries < maxRetries) {
    try {
      return await fn();
    } catch (error) {
      retries++;
      if (retries === maxRetries) throw error;
      const delay = initialDelay * Math.pow(2, retries - 1);
      logger.warn(`Request failed, retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

export {
  loadIBCData,
  hashIBCDenom,
  validateId,
  validateIBCData,
  fetchIBCData,
  recursiveUnwrap,
  parseIBCPath,
  retryRequest
};
