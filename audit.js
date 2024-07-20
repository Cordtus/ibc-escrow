const fs = require('fs').promises;
const path = require('path');
const readline = require('readline');
const axios = require('axios');
const dotenv = require('dotenv');
const crypto = require('crypto');
const chalk = require('chalk');

const updateChainData = require('./updateChains');
const config = require('./config.json');
const { loadIBCData, hashIBCDenom, validateId } = require('./ibcUtils');

dotenv.config();

const DATA_DIR = path.join(__dirname, 'data');

async function promptUser(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise(resolve => rl.question(question, ans => {
    rl.close();
    resolve(ans);
  }));
}

async function loadChainInfo(chainName) {
  const filePath = path.join(DATA_DIR, `${chainName}.json`);
  try {
    const data = await fs.readFile(filePath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error(`Error loading chain info for ${chainName}:`, error);
    return null;
  }
}

async function makeRequest(endpoints, path) {
  const maxRetries = config.api.retries || 3;
  const delay = config.api.delay || 250;

  for (const endpoint of endpoints) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await axios.get(`${endpoint}${path}`);
        return response.data;
      } catch (error) {
        const status = error.response ? error.response.status : 'Unknown';
        console.log(`Failed to fetch from ${endpoint} with status ${status}, attempt ${attempt}/${maxRetries}.`);

        if (status === 501 || status === 502) {
          // Skip to the next endpoint for 501 and 502 errors
          break;
        } else if (status === 503) {
          // Retry for 503 errors with a longer delay
          if (attempt < maxRetries) {
            await new Promise(resolve => setTimeout(resolve, delay * 2));
          }
        } else if (error.code === 'ENOTFOUND') {
          // Retry for ENOTFOUND errors
          if (attempt < maxRetries) {
            await new Promise(resolve => setTimeout(resolve, delay));
          }
        } else {
          // For other errors, retry
          if (attempt < maxRetries) {
            await new Promise(resolve => setTimeout(resolve, delay));
          }
        }
      }
    }
  }
  throw new Error('All endpoints failed');
}

async function fetchIBCData(primaryChain, secondaryChain) {
  // Load IBC data
  const ibcData = await loadIBCData(primaryChain, secondaryChain);
  if (!ibcData) {
    throw new Error(`Unable to load IBC data for ${primaryChain}-${secondaryChain}`);
  }

  // Determine which chain is chain_1 in the IBC data
  const isChain1Primary = ibcData.chain_1.chain_name === primaryChain;
  const primaryChainData = isChain1Primary ? ibcData.chain_1 : ibcData.chain_2;

  // Load primary chain info
  const primaryChainInfo = await loadChainInfo(primaryChain);
  if (!primaryChainInfo) {
    throw new Error(`Unable to load chain info for ${primaryChain}`);
  }

  // Get REST endpoint for primary chain
  const restEndpoint = primaryChainInfo.apis.rest[0].address;

  // Get channel ID for primary chain
  const channelId = primaryChainData.channel_id;
  validateId(channelId, 'channel ID');

  const portId = 'transfer'; // Default port ID

  // Fetch chain ID
  const nodeInfo = await makeRequest([restEndpoint], '/cosmos/base/tendermint/v1beta1/node_info');
  const chainId = nodeInfo.default_node_info.network;

  // Fetch channel data
  const channelData = await makeRequest([restEndpoint], `/ibc/core/channel/v1/channels/${channelId}/ports/${portId}`);
  const counterpartyChannelId = channelData.channel.counterparty.channel_id;
  const connectionId = channelData.channel.connection_hops[0];

  // Fetch connection data
  const connectionData = await makeRequest([restEndpoint], `/ibc/core/connection/v1/connections/${connectionId}`);
  const clientId = connectionData.connection.client_id;
  const counterpartyClientId = connectionData.connection.counterparty.client_id;
  const counterpartyConnectionId = connectionData.connection.counterparty.connection_id;

  // Fetch counterparty chain ID
  const clientState = await makeRequest([restEndpoint], `/ibc/core/channel/v1/channels/${channelId}/ports/${portId}/client_state`);
  const counterpartyChainId = clientState.identified_client_state.client_state.chain_id;

  // Check for errors in outputs
  if (!/^07-tendermint-[0-9]{1,5}$/.test(clientId)) {
    console.error(chalk.red(`Unexpected format in fetched client ID. Received: ${clientId}`));
  }

  // Print chain IDs
  console.log(chalk.green(`Chain ID: ${chainId}`));
  console.log(chalk.green(`Counterparty Chain ID: ${counterpartyChainId}`));

  // Prepare JSON output
  const output = {
    client_id: clientId,
    connection_id: connectionId,
    counterparty_client_id: counterpartyClientId,
    counterparty_connection_id: counterpartyConnectionId,
    channel_id: channelId,
    counterparty_channel_id: counterpartyChannelId
  };

  // Print JSON output
  console.log(chalk.green(JSON.stringify(output, null, 2)));

  return output;
}

async function performIBCEscrowAudit(primaryChain, secondaryChain, channelId) {
  const primaryChainInfo = await loadChainInfo(primaryChain);
  const secondaryChainInfo = await loadChainInfo(secondaryChain);

  if (!primaryChainInfo || !secondaryChainInfo) {
    throw new Error('Unable to load chain information');
  }

  const primaryRestEndpoints = primaryChainInfo.apis.rest.map(api => api.address);
  const secondaryRestEndpoints = secondaryChainInfo.apis.rest.map(api => api.address);

  // Get escrow address
  const escrowData = await makeRequest(primaryRestEndpoints, `/ibc/apps/transfer/v1/channels/${channelId}/ports/transfer/escrow_address`);
  const escrowAddress = escrowData.escrow_address;

  // Get escrow account balances
  const balancesData = await makeRequest(primaryRestEndpoints, `/cosmos/bank/v1beta1/balances/${escrowAddress}`);

  console.log(chalk.yellow(`Escrow address: ${escrowAddress}`));

  for (const balance of balancesData.balances) {
    let baseDenom = balance.denom;
    if (balance.denom.startsWith('ibc/')) {
      const hash = balance.denom.split('/')[1];
      const trace = await makeRequest(primaryRestEndpoints, `/ibc/apps/transfer/v1/denom_traces/${hash}`);
      baseDenom = trace.denom_trace.base_denom;
    }
    
    const ibcData = await loadIBCData(primaryChain, secondaryChain);
    const counterpartyChannelId = ibcData.channels[0].chain_2.channel_id;
    const counterpartyIbcDenom = hashIBCDenom('transfer', counterpartyChannelId, baseDenom);

    const totalSupply = await makeRequest(secondaryRestEndpoints, `/cosmos/bank/v1beta1/supply/${counterpartyIbcDenom}`);

    console.log(chalk.yellow(`\nToken: ${baseDenom}`));
    console.log(chalk.yellow(`Escrow balance: ${balance.amount}`));
    console.log(chalk.yellow(`Counterparty total supply: ${totalSupply.amount.amount}`));

    if (balance.amount !== totalSupply.amount.amount) {
      console.log(chalk.red('Discrepancy found!'));
    } else {
      console.log(chalk.green('Balances match.'));
    }
  }
}

async function main() {
  try {
    // Check if chain data exists and update if necessary
    try {
      await fs.access(path.join(DATA_DIR, 'update_complete'));
    } catch (error) {
      if (error.code === 'ENOENT') {
        console.log(chalk.yellow("Initializing chain data. This may take a few minutes..."));
        await updateChainData();
      } else {
        throw error;
      }
    }

    let primaryChain = process.argv[2];
    let secondaryChain = process.argv[3];

    // If no arguments provided, enter interactive mode
    if (!primaryChain || !secondaryChain) {
      console.log('Enter the following information:');
      primaryChain = await promptUser(chalk.yellow('Primary Chain Name: '));
      secondaryChain = await promptUser(chalk.yellow('Secondary Chain Name: '));
    }

    console.log(chalk.yellow(`Fetching IBC data for ${primaryChain} and ${secondaryChain}...`));
    const ibcData = await fetchIBCData(primaryChain, secondaryChain);

    console.log(chalk.yellow(`Performing IBC escrow audit for ${primaryChain} -> ${secondaryChain} on channel ${ibcData.channel_id}`));
    await performIBCEscrowAudit(primaryChain, secondaryChain, ibcData.channel_id);
    console.log(chalk.green("Audit completed successfully."));

  } catch (error) {
    console.error(chalk.red('Error:', error.message));
    process.exit(1);
  }
}

// Wrap the main function in a self-executing async function
(async () => {
  try {
    await main();
  } catch (error) {
    console.error(chalk.red('An unexpected error occurred:', error));
    process.exit(1);
  }
})();