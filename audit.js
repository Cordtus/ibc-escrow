const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');

const CACHE_DIR = path.join(__dirname, 'chain_cache');
const REPO_OWNER = 'cosmos';
const REPO_NAME = 'chain-registry';
const GITHUB_API_URL = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents`;

async function ensureCacheDirectory() {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
  } catch (error) {
    console.error('Error creating cache directory:', error);
  }
}

async function fetchDirectories() {
  try {
    const response = await axios.get(GITHUB_API_URL);
    return response.data
      .filter(item => item.type === 'dir' && /^[0-9a-f]/.test(item.name) && item.name !== 'testnets')
      .map(item => item.name);
  } catch (error) {
    console.error('Error fetching directories:', error);
    return [];
  }
}

async function fetchChainJson(chainName) {
  const url = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/master/${chainName}/chain.json`;
  try {
    const response = await axios.get(url);
    return response.data;
  } catch (error) {
    console.error(`Error fetching chain.json for ${chainName}:`, error);
    return null;
  }
}

async function cacheChainData() {
  await ensureCacheDirectory();
  const directories = await fetchDirectories();

  for (const chainName of directories) {
    const chainData = await fetchChainJson(chainName);
    if (chainData) {
      const filePath = path.join(CACHE_DIR, `${chainName}.json`);
      try {
        await fs.writeFile(filePath, JSON.stringify(chainData, null, 2));
        console.log(`Cached ${chainName}.json`);
      } catch (error) {
        console.error(`Error writing ${chainName}.json:`, error);
      }
    }
  }
}

async function loadChainInfo(chainName) {
  const filePath = path.join(CACHE_DIR, `${chainName}.json`);
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

async function performIBCEscrowAudit(sourceChainName, targetChainName, channelId) {
  const sourceChainInfo = await loadChainInfo(sourceChainName);
  const targetChainInfo = await loadChainInfo(targetChainName);

  if (!sourceChainInfo || !targetChainInfo) {
    console.error('Failed to load chain information');
    return;
  }

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

// Main execution
async function main() {
  await cacheChainData();

  const sourceChainName = process.argv[2];
  const targetChainName = process.argv[3];
  const channelId = process.argv[4];

  if (!sourceChainName || !targetChainName || !channelId) {
    console.log('Usage: node script.js <sourceChainName> <targetChainName> <channelId>');
    process.exit(1);
  }

  await performIBCEscrowAudit(sourceChainName, targetChainName, channelId);
}

main().catch(error => console.error('An error occurred:', error));