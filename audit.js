import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';
import axios from 'axios';
import dotenv from 'dotenv';
import chalk from 'chalk';

import updateChainData from './updateChains.js';
import { loadIBCData, hashIBCDenom, validateId } from './ibcUtils.js';
import logger from './logger.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, 'data');

// Load config file
const configPath = path.join(__dirname, 'config.json');
const config = JSON.parse(await fs.readFile(configPath, 'utf8'));

async function promptUser(question) {
  logger.info(`Prompting user: ${question}`);
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise(resolve => rl.question(chalk.yellow(question), ans => {
    rl.close();
    logger.info(`User input received for: ${question}`);
    resolve(ans);
  }));
}

async function loadChainInfo(chainName) {
  logger.info(`Loading chain info for: ${chainName}`);
  const filePath = path.join(DATA_DIR, `${chainName}.json`);
  try {
    const data = await fs.readFile(filePath, 'utf8');
    logger.info(`Chain info loaded successfully for: ${chainName}`);
    return JSON.parse(data);
  } catch (error) {
    logger.error(`Error loading chain info for ${chainName}:`, { error: error.message });
    return null;
  }
}

async function makeRequest(endpoints, path) {
  logger.info(`Making API request to path: ${path}`);
  const maxRetries = config.api.retries || 3;
  const delay = config.api.delay || 250;

  for (const endpoint of endpoints) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await axios.get(`${endpoint}${path}`);
        logger.info(`API request successful: ${endpoint}${path}`);
        return response.data;
      } catch (error) {
        const status = error.response ? error.response.status : 'Unknown';
        logger.warn(`Failed to fetch from ${endpoint} with status ${status}, attempt ${attempt}/${maxRetries}.`);

        if (status === 501 || status === 502) {
          logger.info(`Skipping to next endpoint due to status ${status}`);
          break;
        } else if (attempt < maxRetries) {
          const retryDelay = status === 503 ? delay * 2 : delay;
          logger.info(`Retrying after delay for status ${status}`);
          await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
      }
    }
  }
  logger.error('All endpoints failed');
  throw new Error('All endpoints failed');
}

async function fetchIBCData(primaryChain, secondaryChain) {
  logger.info(`Fetching IBC data for ${primaryChain} and ${secondaryChain}`);
  const ibcData = await loadIBCData(primaryChain, secondaryChain);
  if (!ibcData) {
    throw new Error(`Unable to load IBC data for ${primaryChain}-${secondaryChain}`);
  }

  logger.info('Loaded IBC data:', JSON.stringify(ibcData, null, 2));

  const isPrimaryChain1 = ibcData.chain_1.chain_name === primaryChain;
  const primaryChainData = isPrimaryChain1 ? ibcData.chain_1 : ibcData.chain_2;
  const secondaryChainData = isPrimaryChain1 ? ibcData.chain_2 : ibcData.chain_1;
  
  logger.info('Primary chain data:', JSON.stringify(primaryChainData, null, 2));
  logger.info('Secondary chain data:', JSON.stringify(secondaryChainData, null, 2));

  if (!ibcData.channels || ibcData.channels.length === 0) {
    throw new Error('No channels found in IBC data');
  }

  const primaryChannelData = isPrimaryChain1 ? ibcData.channels[0].chain_1 : ibcData.channels[0].chain_2;
  const secondaryChannelData = isPrimaryChain1 ? ibcData.channels[0].chain_2 : ibcData.channels[0].chain_1;

  logger.info('Primary channel data:', JSON.stringify(primaryChannelData, null, 2));
  logger.info('Secondary channel data:', JSON.stringify(secondaryChannelData, null, 2));

  if (!primaryChannelData || !primaryChannelData.channel_id) {
    throw new Error('Primary channel data or channel_id is missing');
  }

  const channelId = primaryChannelData.channel_id;
  const counterpartyChannelId = secondaryChannelData.channel_id;

  logger.info(`Primary channel ID: ${channelId}`);
  logger.info(`Secondary (counterparty) channel ID: ${counterpartyChannelId}`);

  validateId(channelId, 'channel ID');
  validateId(counterpartyChannelId, 'counterparty channel ID');

  return {
    client_id: primaryChainData.client_id,
    connection_id: primaryChainData.connection_id,
    counterparty_client_id: secondaryChainData.client_id,
    counterparty_connection_id: secondaryChainData.connection_id,
    channel_id: channelId,
    counterparty_channel_id: counterpartyChannelId
  };
}

async function auditEscrow(primaryChain, secondaryChain, channelId) {
  logger.info(`Starting IBC escrow audit for ${primaryChain} -> ${secondaryChain} on channel ${channelId}`);
  const primaryChainInfo = await loadChainInfo(primaryChain);
  const secondaryChainInfo = await loadChainInfo(secondaryChain);

  if (!primaryChainInfo || !secondaryChainInfo) {
    throw new Error('Unable to load chain information');
  }

  const primaryRestEndpoints = primaryChainInfo.apis.rest.map(api => api.address);
  const secondaryRestEndpoints = secondaryChainInfo.apis.rest.map(api => api.address);

  const ibcData = await loadIBCData(primaryChain, secondaryChain);
  const isPrimaryChain1 = ibcData.chain_1.chain_name === primaryChain;
  const secondaryChannel = isPrimaryChain1 ? ibcData.channels[0].chain_2 : ibcData.channels[0].chain_1;

  try {
    const escrowData = await makeRequest(primaryRestEndpoints, `/ibc/apps/transfer/v1/channels/${channelId}/ports/transfer/escrow_address`);
    const escrowAddress = escrowData.escrow_address;
    logger.info(`Escrow address: ${escrowAddress}`);

    const balancesData = await makeRequest(primaryRestEndpoints, `/cosmos/bank/v1beta1/balances/${escrowAddress}`);

    for (const balance of balancesData.balances) {
      let baseDenom = balance.denom;
      if (balance.denom.startsWith('ibc/')) {
        const hash = balance.denom.split('/')[1];
        const trace = await makeRequest(primaryRestEndpoints, `/ibc/apps/transfer/v1/denom_traces/${hash}`);
        baseDenom = trace.denom_trace.base_denom;
      }
      
      const counterpartyChannelId = secondaryChannel.channel_id;
      const counterpartyIbcDenom = hashIBCDenom('transfer', counterpartyChannelId, baseDenom);

      try {
        const totalSupplyResponse = await makeRequest(secondaryRestEndpoints, `/cosmos/bank/v1beta1/supply/${counterpartyIbcDenom}`);
        
        if (!totalSupplyResponse || !totalSupplyResponse.amount || !totalSupplyResponse.amount.amount) {
          logger.error(`Unexpected response format for total supply of ${counterpartyIbcDenom}:`, totalSupplyResponse);
          continue;
        }

        const totalSupply = totalSupplyResponse.amount.amount;

        logger.info(`Token: ${baseDenom}, Escrow balance: ${balance.amount}, Counterparty total supply: ${totalSupply}`);

        if (balance.amount !== totalSupply) {
          logger.warn(`Discrepancy found for ${baseDenom}`);
        } else {
          logger.info(`Balances match for ${baseDenom}`);
        }
      } catch (error) {
        logger.error(`Failed to fetch or process total supply for ${counterpartyIbcDenom}:`, error);
      }
    }
  } catch (error) {
    logger.error('Error during escrow audit:', error);
    throw error;
  }
}

async function main() {
  try {
    logger.info('Starting IBC Escrow Audit Tool');
    
    try {
      await fs.access(path.join(DATA_DIR, 'update_complete'));
    } catch (error) {
      if (error.code === 'ENOENT') {
        logger.info("Initializing chain data. This may take a few minutes...");
        await updateChainData();
      } else {
        throw error;
      }
    }

    let primaryChain = process.argv[2];
    let secondaryChain = process.argv[3];

    if (!primaryChain || !secondaryChain) {
      logger.info('Entering interactive mode');
      primaryChain = await promptUser('Primary Chain Name: ');
      secondaryChain = await promptUser('Secondary Chain Name: ');
    }

    logger.info(`Fetching IBC data for ${primaryChain} and ${secondaryChain}`);
    const ibcData = await fetchIBCData(primaryChain, secondaryChain);

    logger.info(`Performing IBC escrow audit for ${primaryChain} -> ${secondaryChain} on channel ${ibcData.channel_id}`);
    await auditEscrow(primaryChain, secondaryChain, ibcData.channel_id);
    logger.info("Audit completed successfully.");

  } catch (error) {
    logger.error('Error:', { error: error.message });
    console.error(chalk.red('Error:', error.message));
    process.exit(1);
  }
}

(async () => {
  try {
    await main();
  } catch (error) {
    logger.error('An unexpected error occurred:', { error: error.message });
    console.error(chalk.red('An unexpected error occurred:', error.message));
    process.exit(1);
  }
})();

export { main, fetchIBCData, auditEscrow };