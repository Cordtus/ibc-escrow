// ibcUtils.js
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import axios from 'axios';
import logger from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, 'data');
const IBC_DATA_DIR = path.join(DATA_DIR, 'ibc');

async function loadIBCData(chain1, chain2) {
  logger.info(`Loading IBC data for ${chain1} and ${chain2}`);
  
  try {
    const files = await fs.readdir(IBC_DATA_DIR);
    const matchingFile = files.find(file => 
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
      ibcData.channels.forEach(channel => {
        [channel.chain_1, channel.chain_2] = [channel.chain_2, channel.chain_1];
      });
    }

    logger.info('IBC data loaded successfully');
    return ibcData;
  } catch (error) {
    logger.error(`Error loading IBC data for ${chain1}-${chain2}:`, { error: error.message });
    throw error;
  }
}

function hashIBCDenom(portId, channelId, denom) {
  logger.info(`Hashing IBC denom: ${portId}/${channelId}/${denom}`);
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
    throw new Error(`Invalid ${type} ID format. Expected format like 'xxx-0' where 'xxx' can be 'channel', 'connection', or 'client' followed by up to 5 digits.`);
  }
  logger.info(`${type} ID validated successfully`);
}

async function makeRequest(endpoints, path) {
  logger.info(`Making API request to path: ${path}`);
  for (const endpoint of endpoints) {
    const url = `${endpoint}${path}`;
    logger.info(`Attempting request to: ${url}`);
    try {
      const response = await axios.get(url);
      logger.info(`Successful response from ${url}`);
      return response.data;
    } catch (error) {
      logger.error(`Error fetching data from ${url}:`, { 
        error: error.message, 
        status: error.response ? error.response.status : 'Unknown',
        data: error.response ? error.response.data : 'No data'
      });
    }
  }
  throw new Error(`All endpoints failed for path: ${path}`);
}

async function fetchIBCData(primaryChain, secondaryChain) {
  logger.info(`Fetching IBC data for ${primaryChain} and ${secondaryChain}`);
  const ibcData = await loadIBCData(primaryChain, secondaryChain);
  if (!ibcData) {
    logger.error(`Unable to load IBC data for ${primaryChain}-${secondaryChain}`);
    throw new Error(`Unable to load IBC data for ${primaryChain}-${secondaryChain}`);
  }

  logger.info('Loaded IBC data:', JSON.stringify(ibcData, null, 2));

  const isPrimaryChain1 = ibcData.chain_1.chain_name === primaryChain;
  const primaryChainData = isPrimaryChain1 ? ibcData.chain_1 : ibcData.chain_2;
  const secondaryChainData = isPrimaryChain1 ? ibcData.chain_2 : ibcData.chain_1;
  const primaryChannelData = isPrimaryChain1 ? ibcData.channels[0].chain_1 : ibcData.channels[0].chain_2;
  const secondaryChannelData = isPrimaryChain1 ? ibcData.channels[0].chain_2 : ibcData.channels[0].chain_1;

  logger.info('Primary chain data:', JSON.stringify(primaryChainData, null, 2));
  logger.info('Secondary chain data:', JSON.stringify(secondaryChainData, null, 2));

  const channelId = primaryChannelData.channel_id;
  const counterpartyChannelId = secondaryChannelData.channel_id;

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
    counterparty_channel_id: counterpartyChannelId
  };

  logger.info('IBC data fetched successfully', { output });
  return output;
}

async function validateIBCData(ibcData, primaryChainInfo, secondaryChainInfo, primaryChain) {
  logger.info('Starting IBC data validation');
  const primaryRestEndpoint = primaryChainInfo.apis.rest[0].address;
  const isPrimaryChain1 = ibcData.chain_1.chain_name === primaryChain;
  const primaryChainData = isPrimaryChain1 ? ibcData.chain_1 : ibcData.chain_2;
  const secondaryChainData = isPrimaryChain1 ? ibcData.chain_2 : ibcData.chain_1;
  const channelId = isPrimaryChain1 ? ibcData.channels[0].chain_1.channel_id : ibcData.channels[0].chain_2.channel_id;
  const portId = 'transfer'; // Default port ID

  try {
    const nodeInfo = await makeRequest(primaryRestEndpoint, '/cosmos/base/tendermint/v1beta1/node_info');
    const chainId = nodeInfo.default_node_info.network;

    const channelData = await makeRequest(primaryRestEndpoint, `/ibc/core/channel/v1/channels/${channelId}/ports/${portId}`);
    const counterpartyChannelId = channelData.channel.counterparty.channel_id;
    const connectionId = channelData.channel.connection_hops[0];

    const connectionData = await makeRequest(primaryRestEndpoint, `/ibc/core/connection/v1/connections/${connectionId}`);
    const clientId = connectionData.connection.client_id;
    const counterpartyClientId = connectionData.connection.counterparty.client_id;
    const counterpartyConnectionId = connectionData.connection.counterparty.connection_id;

    const clientState = await makeRequest(primaryRestEndpoint, `/ibc/core/channel/v1/channels/${channelId}/ports/${portId}/client_state`);
    const counterpartyChainId = clientState.identified_client_state.client_state.chain_id;

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

    if (counterpartyChannelId !== (isPrimaryChain1 ? ibcData.channels[0].chain_2.channel_id : ibcData.channels[0].chain_1.channel_id)) {
      logger.error('Counterparty Channel ID mismatch');
      return false;
    }

    if (!/^07-tendermint-[0-9]{1,5}$/.test(clientId)) {
      logger.warn(`Unexpected format in fetched client ID. Received: ${clientId}`);
    }

    logger.info('IBC data validated successfully');
    return true;
  } catch (error) {
    logger.error('Error during IBC data validation:', { error: error.message });
    return false;
  }
}

export {
  loadIBCData,
  hashIBCDenom,
  validateId,
  validateIBCData,
  fetchIBCData
};
