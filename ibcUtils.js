const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const logger = require('./logger');

const DATA_DIR = path.join(__dirname, 'data');
const IBC_DATA_DIR = path.join(DATA_DIR, 'ibc');

async function loadIBCData(chain1, chain2) {
  logger.info(`Loading IBC data for ${chain1} and ${chain2}`);
  const [sortedChain1, sortedChain2] = [chain1, chain2].sort();
  const fileName = `${sortedChain1}-${sortedChain2}.json`;
  const filePath = path.join(IBC_DATA_DIR, fileName);

  try {
    const data = await fs.readFile(filePath, 'utf8');
    const ibcData = JSON.parse(data);
    
    if (chain1 !== sortedChain1) {
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
    return null;
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

async function makeRequest(url) {
  try {
    const response = await axios.get(url);
    return response.data;
  } catch (error) {
    logger.error(`Error fetching data from ${url}:`, { error: error.message });
    throw error;
  }
}

async function validateIBCData(ibcData, primaryChainInfo, secondaryChainInfo) {
  logger.info('Starting IBC data validation');
  const primaryRestEndpoint = primaryChainInfo.apis.rest[0].address;
  const channelId = ibcData.chain_1.channel_id;
  const portId = 'transfer'; // Default port ID

  try {
    // Fetch chain ID
    const nodeInfo = await makeRequest(`${primaryRestEndpoint}/cosmos/base/tendermint/v1beta1/node_info`);
    const chainId = nodeInfo.default_node_info.network;

    // Fetch channel data
    const channelData = await makeRequest(`${primaryRestEndpoint}/ibc/core/channel/v1/channels/${channelId}/ports/${portId}`);
    const counterpartyChannelId = channelData.channel.counterparty.channel_id;
    const connectionId = channelData.channel.connection_hops[0];

    // Fetch connection data
    const connectionData = await makeRequest(`${primaryRestEndpoint}/ibc/core/connection/v1/connections/${connectionId}`);
    const clientId = connectionData.connection.client_id;
    const counterpartyClientId = connectionData.connection.counterparty.client_id;
    const counterpartyConnectionId = connectionData.connection.counterparty.connection_id;

    // Fetch counterparty chain ID
    const clientState = await makeRequest(`${primaryRestEndpoint}/ibc/core/channel/v1/channels/${channelId}/ports/${portId}/client_state`);
    const counterpartyChainId = clientState.identified_client_state.client_state.chain_id;

    // Validate fetched data against IBC data
    if (chainId !== primaryChainInfo.chain_id) {
      logger.error('Chain ID mismatch');
      return false;
    }

    if (counterpartyChainId !== secondaryChainInfo.chain_id) {
      logger.error('Counterparty Chain ID mismatch');
      return false;
    }

    if (clientId !== ibcData.chain_1.client_id) {
      logger.error('Client ID mismatch');
      return false;
    }

    if (connectionId !== ibcData.chain_1.connection_id) {
      logger.error('Connection ID mismatch');
      return false;
    }

    if (counterpartyChannelId !== ibcData.chain_2.channel_id) {
      logger.error('Counterparty Channel ID mismatch');
      return false;
    }

    // Check client ID format
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

module.exports = {
  loadIBCData,
  hashIBCDenom,
  validateId,
  validateIBCData
};