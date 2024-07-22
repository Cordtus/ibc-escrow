// audit.js
import inquirer from 'inquirer';
import chalk from 'chalk';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

import updateChainData from './updateChains.js';
import {
  loadIBCData,
  hashIBCDenom,
  fetchIBCData,
  validateIBCData,
} from './ibcUtils.js';

import logger from './logger.js';
import getChannelPairs from './pairChannels.js';
import { makeRequest, loadChainInfo } from './chainUtils.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const configPath = path.join(__dirname, 'config.json');
const config = JSON.parse(await fs.readFile(configPath, 'utf8'));

const DATA_DIR = path.join(__dirname, config.paths.dataDir);

async function getAvailableChains() {
  const files = await fs.readdir(DATA_DIR);
  return files
    .filter((file) => file.endsWith('.json') && file !== 'chain.schema.json')
    .map((file) => file.replace('.json', ''));
}

async function promptForAudit() {
  const chains = await getAvailableChains();

  const questions = [
    {
      type: 'list',
      name: 'primaryChain',
      message: 'Select the primary chain:',
      choices: chains,
    },
    {
      type: 'list',
      name: 'secondaryChain',
      message: 'Select the secondary chain:',
      choices: chains,
    },
    {
      type: 'list',
      name: 'auditType',
      message: 'Select the type of audit:',
      choices: [
        { name: 'Quick (native token only)', value: 'quick' },
        { name: 'Comprehensive (all tokens)', value: 'comprehensive' },
        { name: 'Manual Channel ID', value: 'manual' },
      ],
    },
  ];

  return inquirer.prompt(questions);
}

async function getNativeToken(chainInfo) {
  if (
    chainInfo.staking &&
    chainInfo.staking.staking_tokens &&
    chainInfo.staking.staking_tokens.length > 0
  ) {
    return chainInfo.staking.staking_tokens[0].denom;
  } else if (
    chainInfo.fees &&
    chainInfo.fees.fee_tokens &&
    chainInfo.fees.fee_tokens.length > 0
  ) {
    return chainInfo.fees.fee_tokens[0].denom;
  }
  throw new Error(
    `Unable to determine native token for ${chainInfo.chain_name}`
  );
}

async function fetchTotalSupply(restEndpoints, denom) {
  const supplyPath = '/cosmos/bank/v1beta1/supply';
  let nextKey = null;
  let pageNumber = 1;
  let totalPages = null;

  do {
    const params = nextKey ? `?pagination.key=${encodeURIComponent(nextKey)}` : '';
    const supplyData = await makeRequest(restEndpoints, `${supplyPath}${params}`);

    if (totalPages === null) {
      totalPages = Math.ceil(parseInt(supplyData.pagination.total) / 100); // Assuming 100 items per page
    }

    const supply = supplyData.supply.find(s => s.denom === denom);
    if (supply) {
      return supply.amount;
    }

    nextKey = supplyData.pagination.next_key;
    pageNumber++;

    // If the denom starts with 'ibc/', start from the first page and work forwards
    if (denom.startsWith('ibc/') && pageNumber === totalPages) {
      break; // We've reached the end without finding it, so stop here
    }
  } while (nextKey);

  throw new Error(`Denom ${denom} not found in total supply`);
}

async function fetchTotalSupplyFallback(endpoints, denom) {
  const supplyPath = '/cosmos/bank/v1beta1/supply';
  let nextKey = null;
  let pageNumber = 1;
  let totalPages = null;

  do {
    const params = nextKey 
      ? `?pagination.key=${encodeURIComponent(nextKey)}` 
      : '?pagination.limit=1000';
    const supplyData = await makeRequest(endpoints, `${supplyPath}${params}`);

    if (totalPages === null) {
      totalPages = Math.ceil(parseInt(supplyData.pagination.total) / 1000);
    }

    const supply = supplyData.supply.find(s => s.denom === denom);
    if (supply) {
      return supply.amount;
    }

    nextKey = supplyData.pagination.next_key;
    pageNumber++;

    if (!nextKey) break;

    logger.info(`Checked page ${pageNumber} of ${totalPages}, denom not found yet.`);

  } while (nextKey);

  logger.warn(`Denom ${denom} not found in total supply after checking all pages.`);
  return "0";
}

async function quickAudit(primaryChain, secondaryChain, channelId) {
  logger.info(`Starting quick IBC escrow audit for ${primaryChain} <-> ${secondaryChain} on channel ${channelId}`);
  
  const primaryChainInfo = await loadChainInfo(primaryChain);
  const secondaryChainInfo = await loadChainInfo(secondaryChain);

  const primaryNativeToken = await getNativeToken(primaryChainInfo);
  const secondaryNativeToken = await getNativeToken(secondaryChainInfo);
  
  logger.info(`Native token for ${primaryChain}: ${primaryNativeToken}`);
  logger.info(`Native token for ${secondaryChain}: ${secondaryNativeToken}`);

  // Fetch channel data to get counterparty channel ID
  const channelData = await getChannelData(primaryChainInfo, channelId);
  const counterpartyChannelId = channelData.channel.counterparty.channel_id;

  logger.info(`Primary channel ID: ${channelId}`);
  logger.info(`Secondary (counterparty) channel ID: ${counterpartyChannelId}`);

  // Perform audit for both chains simultaneously
  const [primaryAudit, secondaryAudit] = await Promise.all([
    auditChain(primaryChainInfo, secondaryChainInfo, channelId, counterpartyChannelId, primaryNativeToken),
    auditChain(secondaryChainInfo, primaryChainInfo, counterpartyChannelId, channelId, secondaryNativeToken)
  ]);

  // Print combined results
  console.log('\n========== Quick IBC Escrow Audit Summary ==========');
  printAuditResult(primaryChain, primaryNativeToken, primaryAudit);
  console.log('------------------------------------------------------');
  printAuditResult(secondaryChain, secondaryNativeToken, secondaryAudit);
  console.log('======================================================\n');
}

async function auditChain(sourceChainInfo, targetChainInfo, sourceChannelId, targetChannelId, nativeToken) {
  const sourceEndpoints = sourceChainInfo.apis.rest.map(api => api.address);
  const targetEndpoints = targetChainInfo.apis.rest.map(api => api.address);

  logger.info(`Auditing ${sourceChainInfo.chain_name} -> ${targetChainInfo.chain_name}`);

  // Get escrow address
  const escrowAddress = await getEscrowAddress(sourceEndpoints, sourceChannelId);

  // Get native token balance in escrow
  const escrowBalance = await getNativeTokenBalance(sourceEndpoints, escrowAddress, nativeToken);

  // Generate IBC denom for the native token on the target chain
  const ibcDenom = hashIBCDenom(config.audit.escrowPort, targetChannelId, nativeToken);
  logger.info(`Generated IBC denom on ${targetChainInfo.chain_name}: ${ibcDenom}`);

  // Get IBC token supply on target chain
  const ibcSupply = await getIBCSupply(targetEndpoints, ibcDenom);

  return { escrowBalance, ibcSupply };
}

function printAuditResult(chainName, nativeToken, auditResult) {
  console.log(`${chainName} Native Token (${nativeToken}):`);
  console.log(`  Escrow Balance on ${chainName}: ${auditResult.escrowBalance}`);
  console.log(`  IBC Supply on counterparty: ${auditResult.ibcSupply}`);
  console.log(`  Difference: ${BigInt(auditResult.escrowBalance) - BigInt(auditResult.ibcSupply)}`);
}

async function getChannelData(chainInfo, channelId) {
    const endpoints = chainInfo.apis.rest.map(api => api.address);
    const channelPath = `/ibc/core/channel/v1/channels/${channelId}/ports/${config.audit.escrowPort}`;
    return await makeRequest(endpoints, channelPath);
}

async function getEscrowAddress(endpoints, channelId) {
    const escrowPath = `/ibc/apps/transfer/v1/channels/${channelId}/ports/${config.audit.escrowPort}/escrow_address`;
    const escrowData = await makeRequest(endpoints, escrowPath);
    return escrowData.escrow_address;
}

async function getNativeTokenBalance(endpoints, address, denom) {
    const balancePath = `/cosmos/bank/v1beta1/balances/${address}`;
    const balanceData = await makeRequest(endpoints, balancePath);
    const nativeBalance = balanceData.balances.find(b => b.denom === denom);
    return nativeBalance ? nativeBalance.amount : '0';
}

async function getIBCSupply(endpoints, ibcDenom) {
  const MAX_PRIMARY_ATTEMPTS = 3; // Limit the number of attempts for the primary method
  
  // Try the primary method first
  for (let i = 0; i < MAX_PRIMARY_ATTEMPTS; i++) {
    try {
      const supplyPath = `/cosmos/bank/v1beta1/supply/by_denom?denom=${ibcDenom}`;
      const supplyData = await makeRequest([endpoints[i]], supplyPath);
      return supplyData.amount.amount;
    } catch (error) {
      logger.warn(`Failed to fetch supply directly from endpoint ${i + 1}. Error: ${error.message}`);
      if (i === MAX_PRIMARY_ATTEMPTS - 1) {
        logger.warn(`All ${MAX_PRIMARY_ATTEMPTS} primary method attempts failed. Falling back to total supply method.`);
      }
    }
  }

  // If primary method fails, use the fallback method
  return await fetchTotalSupplyFallback(endpoints, ibcDenom);
}

async function comprehensiveAudit(primaryChain, secondaryChain, channelId) {
  async function recursiveUnwrap(chainInfo, denom, path = []) {
    if (!denom.startsWith('ibc/')) {
      return { baseDenom: denom, path };
    }

    const hash = denom.split('/')[1];
    const tracePath = `/ibc/apps/transfer/v1/denom_traces/${hash}`;
    const traceData = await makeRequest(
      chainInfo.apis.rest.map((api) => api.address),
      tracePath
    );

    if (!traceData || !traceData.denom_trace) {
      return { baseDenom: denom, path };
    }

    const trace = traceData.denom_trace;
    path.push({
      chain: chainInfo.chain_name,
      channel: trace.path.split('/')[1],
      port: trace.path.split('/')[0],
    });

    // Load the info for the next chain in the path
    const nextChainName = trace.path.split('/')[2];
    const nextChainInfo = await loadChainInfo(nextChainName);
    return recursiveUnwrap(nextChainInfo, trace.base_denom, path);
  }

  async function fetchTotalSupply(chainInfo, denom) {
    const restEndpoints = chainInfo.apis.rest.map((api) => api.address);
    
    // Try the original method first
    try {
      const totalSupplyPath = `/cosmos/bank/v1beta1/supply/by_denom?denom=${encodeURIComponent(denom)}`;
      const totalSupplyData = await makeRequest(restEndpoints, totalSupplyPath);
      if (totalSupplyData && totalSupplyData.amount) {
        return totalSupplyData.amount.amount;
      }
    } catch (error) {
      logger.warn(`Failed to fetch total supply using the original method for ${denom}:`, error.message);
    }
    
    // If the original method fails, use the alternative method
    try {
      const supplyPath = '/cosmos/bank/v1beta1/supply';
      let nextKey = null;
      let pageNumber = 1;
      let totalPages = 1;
      
      do {
        const params = nextKey ? `?pagination.key=${encodeURIComponent(nextKey)}` : '';
        const supplyData = await makeRequest(restEndpoints, `${supplyPath}${params}`);
        
        if (pageNumber === 1) {
          totalPages = Math.ceil(parseInt(supplyData.pagination.total) / 100); // Assuming 100 items per page
        }
        
        const supply = supplyData.supply.find(s => s.denom === denom);
        if (supply) {
          return supply.amount;
        }
        
        nextKey = supplyData.pagination.next_key;
        pageNumber++;
        
        // If the denom starts with 'a', continue to the next page
        // Otherwise, break if we've reached the last page
        if (!denom.startsWith('a') && pageNumber > totalPages) {
          break;
        }
      } while (nextKey);
      
      throw new Error(`Denom ${denom} not found in total supply`);
    } catch (error) {
      logger.error(`Failed to fetch total supply for ${denom}:`, error.message);
      throw error;
    }
  }

  logger.info(
    `Starting comprehensive IBC escrow audit for ${primaryChain} -> ${secondaryChain} on channel ${channelId}`
  );

  const primaryChainInfo = await loadChainInfo(primaryChain);
  const secondaryChainInfo = await loadChainInfo(secondaryChain);

  if (!primaryChainInfo || !secondaryChainInfo) {
    throw new Error('Unable to load chain information');
  }

  const primaryRestEndpoints = primaryChainInfo.apis.rest.map(
    (api) => api.address
  );
  const secondaryRestEndpoints = secondaryChainInfo.apis.rest.map(
    (api) => api.address
  );

  const ibcData = await loadIBCData(primaryChain, secondaryChain);
  const isPrimaryChain1 = ibcData.chain_1.chain_name === primaryChain;
  const secondaryChannel = isPrimaryChain1
    ? ibcData.channels[0].chain_2
    : ibcData.channels[0].chain_1;

  const stats = {
    totalTokensChecked: 0,
    tokensWithDiscrepancies: 0,
    tokensWithErrors: 0,
    discrepancies: [],
    errors: [],
  };

  try {
    const escrowPath = `/ibc/apps/transfer/v1/channels/${channelId}/ports/${config.audit.escrowPort}/escrow_address`;
    logger.info(`Fetching escrow address. Path: ${escrowPath}`);
    const escrowData = await makeRequest(primaryRestEndpoints, escrowPath);
    const escrowAddress = escrowData.escrow_address;
    logger.info(`Escrow address: ${escrowAddress}`);

    const balancesPath = `/cosmos/bank/v1beta1/balances/${escrowAddress}`;
    logger.info(`Fetching escrow balances. Path: ${balancesPath}`);
    const balancesData = await makeRequest(primaryRestEndpoints, balancesPath);

    for (const balance of balancesData.balances) {
      stats.totalTokensChecked++;

      const unwrapResult = await recursiveUnwrap(
        primaryChainInfo,
        balance.denom
      );
      const baseDenom = unwrapResult.baseDenom;

      const counterpartyChannelId = secondaryChannel.channel_id;
      const counterpartyIbcDenom = hashIBCDenom(
        config.audit.escrowPort,
        counterpartyChannelId,
        baseDenom
      );

      logger.info(
        `Fetching total supply for ${counterpartyIbcDenom} on secondary chain`
      );
      
      try {
        const totalSupply = await fetchTotalSupply(secondaryChainInfo, counterpartyIbcDenom);

        logger.info(
          `Token: ${baseDenom}, Escrow balance: ${balance.amount}, Counterparty total supply: ${totalSupply}`
        );

        if (balance.amount !== totalSupply) {
          logger.warn(`Discrepancy found for ${baseDenom}`);
          stats.tokensWithDiscrepancies++;
          stats.discrepancies.push({
            token: baseDenom,
            escrowBalance: balance.amount,
            totalSupply: totalSupply,
            unwrapPath: unwrapResult.path,
          });
        } else {
          logger.info(`Balances match for ${baseDenom}`);
        }
      } catch (error) {
        logger.error(`Error fetching total supply for ${counterpartyIbcDenom}:`, error.message);
        stats.tokensWithErrors++;
        stats.errors.push({
          token: baseDenom,
          error: error.message,
        });
      }
    }

    // Print summary
    console.log('\n========== IBC Escrow Audit Summary ==========');
    console.log(`Total tokens checked: ${stats.totalTokensChecked}`);
    console.log(`Tokens with discrepancies: ${stats.tokensWithDiscrepancies}`);
    console.log(`Tokens with errors: ${stats.tokensWithErrors}`);
    console.log('\nDiscrepancies:');
    if (stats.discrepancies.length === 0) {
      console.log('No discrepancies found.');
    } else {
      stats.discrepancies.forEach((d) => {
        console.log(`\nToken: ${d.token}`);
        console.log(`  Escrow Balance: ${d.escrowBalance}`);
        console.log(`  Total Supply:   ${d.totalSupply}`);
        console.log(
          `  Difference:     ${BigInt(d.escrowBalance) - BigInt(d.totalSupply)}`
        );
        console.log('  Unwrap path:');
        d.unwrapPath.forEach((step, index) => {
          console.log(
            `    ${index + 1}. ${step.chain} (${step.port}-${step.channel})`
          );
        });
      });
    }
    console.log('\nErrors:');
    if (stats.errors.length === 0) {
      console.log('No errors encountered.');
    } else {
      stats.errors.forEach((e) => {
        console.log(`\nToken: ${e.token}`);
        console.log(`  Error: ${e.error}`);
      });
    }
    console.log('=============================================\n');
  } catch (error) {
    logger.error('Error during escrow audit:', error);
    throw error;
  }
}

async function manualChannelAudit(primaryChain, secondaryChain) {
  const { channelId } = await inquirer.prompt([
    {
      type: 'input',
      name: 'channelId',
      message: 'Enter the channel ID for the primary chain:',
      validate: (input) =>
        /^channel-\d+$/.test(input) ||
        'Please enter a valid channel ID (e.g., channel-0)',
    },
  ]);

  const primaryChainInfo = await loadChainInfo(primaryChain);
  const primaryRestEndpoint = primaryChainInfo.apis.rest[0].address;

  const channelPath = `/ibc/core/channel/v1/channels/${channelId}`;
  const channelData = await makeRequest([primaryRestEndpoint], channelPath);

  const counterpartyChannelId = channelData.channel.counterparty.channel_id;
  const counterpartyPortId = channelData.channel.counterparty.port_id;
  const connectionId = channelData.channel.connection_hops[0];

  const connectionPath = `/ibc/core/connection/v1/connections/${connectionId}`;
  const connectionData = await makeRequest(
    [primaryRestEndpoint],
    connectionPath
  );

  const clientId = connectionData.connection.client_id;
  const counterpartyClientId = connectionData.connection.counterparty.client_id;
  const counterpartyConnectionId =
    connectionData.connection.counterparty.connection_id;

  const clientPath = `/ibc/core/client/v1/client_states/${clientId}`;
  const clientData = await makeRequest([primaryRestEndpoint], clientPath);

  const counterpartyChainId = clientData.client_state.chain_id;

  console.log('\n========== IBC Channel Information ==========');
  console.log(`Primary Chain: ${primaryChain}`);
  console.log(`Secondary Chain: ${secondaryChain}`);
  console.log(`Channel ID: ${channelId}`);
  console.log(`Counterparty Channel ID: ${counterpartyChannelId}`);
  console.log(`Counterparty Port ID: ${counterpartyPortId}`);
  console.log(`Connection ID: ${connectionId}`);
  console.log(`Client ID: ${clientId}`);
  console.log(`Counterparty Client ID: ${counterpartyClientId}`);
  console.log(`Counterparty Connection ID: ${counterpartyConnectionId}`);
  console.log(`Counterparty Chain ID: ${counterpartyChainId}`);
  console.log('==============================================\n');

  await quickAudit(primaryChain, secondaryChain, channelId);
}

async function runAudit(primaryChain, secondaryChain, auditType) {
  console.log(chalk.green(`\nStarting ${auditType} audit for ${primaryChain} -> ${secondaryChain}`));
  logger.info(`Fetching IBC data for ${primaryChain} and ${secondaryChain}`);

  let ibcData;
  if (auditType !== 'manual') {
    ibcData = await fetchIBCData(primaryChain, secondaryChain);
    const primaryChainInfo = await loadChainInfo(primaryChain);
    const secondaryChainInfo = await loadChainInfo(secondaryChain);
    const isValid = await validateIBCData(ibcData, primaryChainInfo, secondaryChainInfo, primaryChain);
    if (!isValid) {
      logger.warn('IBC data validation failed. Continuing with audit.');
    }
  }

  if (auditType === 'quick') {
    await quickAudit(primaryChain, secondaryChain, ibcData.channel_id);
  } else if (auditType === 'comprehensive') {
    await comprehensiveAudit(primaryChain, secondaryChain, ibcData.channel_id);
  } else if (auditType === 'manual') {
    await manualChannelAudit(primaryChain, secondaryChain);
  }
}

async function main() {
  try {
    console.log(chalk.blue('Welcome to the IBC Escrow Audit Tool!'));
    logger.info('Starting IBC Escrow Audit Tool');

    try {
      await fs.access(path.join(DATA_DIR, 'update_complete'));
    } catch (error) {
      if (error.code === 'ENOENT') {
        console.log(
          chalk.yellow(
            'Initializing chain data. This may take a few minutes...'
          )
        );
        logger.info('Initializing chain data. This may take a few minutes...');
        await updateChainData();
      } else {
        throw error;
      }
    }

    const { primaryChain, secondaryChain, auditType } = await promptForAudit();
    await runAudit(primaryChain, secondaryChain, auditType);

    console.log(chalk.green('\nAudit completed successfully.'));
    logger.info('Audit completed successfully.');
  } catch (error) {
    logger.error('Error:', { error: error.message });
    console.error(chalk.red('Error:', error.message));
    process.exit(1);
  }
}

main();

export {
  loadIBCData,
  hashIBCDenom,
  fetchIBCData,
  quickAudit,
  comprehensiveAudit,
};