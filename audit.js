const fs = require('fs').promises;
const path = require('path');
const readline = require('readline');

const axios = require('axios');
const dotenv = require('dotenv');

const updateChainData = require('./updateChains');
const config = require('./config.json');

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
  for (const endpoint of endpoints) {
    try {
      const response = await axios.get(`${endpoint}${path}`);
      return response.data;
    } catch (error) {
      console.log(`Failed to fetch from ${endpoint}, trying next...`);
    }
  }
  throw new Error('All endpoints failed');
}

async function performIBCEscrowAudit(sourceChainInfo, targetChainInfo, channelId) {
  const sourceRestEndpoints = sourceChainInfo.apis.rest.map(api => api.address);
  const targetRestEndpoints = targetChainInfo.apis.rest.map(api => api.address);

  // Get channel and client information
  const channelInfo = await makeRequest(sourceRestEndpoints, `/ibc/core/channel/v1/channels/${channelId}/ports/transfer`);
  const clientState = await makeRequest(sourceRestEndpoints, `/ibc/core/channel/v1/channels/${channelId}/ports/transfer/client_state`);

  // Get escrow address
  const escrowData = await makeRequest(sourceRestEndpoints, `/ibc/apps/transfer/v1/channels/${channelId}/ports/transfer/escrow_address`);
  const escrowAddress = escrowData.escrow_address;

  // Get escrow account balances
  const balancesData = await makeRequest(sourceRestEndpoints, `/cosmos/bank/v1beta1/balances/${escrowAddress}`);

  console.log(`Escrow address: ${escrowAddress}`);
  console.log(`Counterparty chain ID: ${clientState.identified_client_state.client_state.chain_id}`);

  for (const balance of balancesData.balances) {
    if (balance.denom.startsWith('ibc/')) {
      const hash = balance.denom.split('/')[1];
      const trace = await makeRequest(sourceRestEndpoints, `/ibc/apps/transfer/v1/denom_traces/${hash}`);
      
      const counterpartyDenom = `ibc/${channelInfo.channel.counterparty.port_id}/${channelInfo.channel.counterparty.channel_id}/${trace.denom_trace.base_denom}`;
      const counterpartyHash = require('crypto').createHash('sha256').update(counterpartyDenom).digest('hex').toUpperCase();
      const counterpartyIbcDenom = `ibc/${counterpartyHash}`;

      const totalSupply = await makeRequest(targetRestEndpoints, `/cosmos/bank/v1beta1/supply/${counterpartyIbcDenom}`);

      console.log(`\nToken: ${trace.denom_trace.base_denom}`);
      console.log(`Escrow balance: ${balance.amount}`);
      console.log(`Counterparty total supply: ${totalSupply.amount.amount}`);

      if (balance.amount !== totalSupply.amount.amount) {
        console.log('Discrepancy found!');
      } else {
        console.log('Balances match.');
      }
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
        console.log("Initializing chain data. This may take a few minutes...");
        await updateChainData();
      } else {
        throw error;
      }
    }

    let sourceChainName = process.argv[2];
    let targetChainName = process.argv[3];
    let channelId = process.argv[4];

    // If no arguments provided, enter interactive mode
    if (!sourceChainName || !targetChainName || !channelId) {
      console.log('Enter the following information:');
      sourceChainName = await promptUser('Source Chain Name: ');
      targetChainName = await promptUser('Target Chain Name: ');
      channelId = await promptUser('Channel ID: ');
    }

    let sourceChainInfo = await loadChainInfo(sourceChainName);
    let targetChainInfo = await loadChainInfo(targetChainName);

    if (!sourceChainInfo || !targetChainInfo) {
      const missingChain = !sourceChainInfo ? sourceChainName : targetChainName;
      console.log(`Chain information for ${missingChain} not found.`);
      const answer = await promptUser('Would you like to update the chain data? (Y/n) ');

      if (answer.toLowerCase() !== 'n') {
        console.log("Updating chain data. This may take a few minutes...");
        await updateChainData();
        // Try loading the chain info again
        if (!sourceChainInfo) sourceChainInfo = await loadChainInfo(sourceChainName);
        if (!targetChainInfo) targetChainInfo = await loadChainInfo(targetChainName);
      }

      if (!sourceChainInfo || !targetChainInfo) {
        throw new Error(`Failed to load information for ${!sourceChainInfo ? sourceChainName : targetChainName}`);
      }
    }

    console.log(`Performing IBC escrow audit for ${sourceChainName} -> ${targetChainName} on channel ${channelId}`);
    await performIBCEscrowAudit(sourceChainInfo, targetChainInfo, channelId);
    console.log("Audit completed successfully.");

  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

// Wrap the main function in a self-executing async function
(async () => {
  try {
    await main();
  } catch (error) {
    console.error('An unexpected error occurred:', error);
    process.exit(1);
  }
})();