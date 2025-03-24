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

import { recursiveUnwrap, fetchTotalSupply, auditToken } from './recursiveAudit.js';
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
  const MAX_PRIMARY_ATTEMPTS = 3;

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

  return "0";
}

async function comprehensiveAudit(primaryChain, secondaryChain, channelId) {
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

      const result = await auditToken(primaryChainInfo, secondaryChainInfo, balance.denom, balance.amount);

      if (result) {
        if (result.error) {
          stats.tokensWithErrors++;
          stats.errors.push(result);
        } else {
          stats.tokensWithDiscrepancies++;
          stats.discrepancies.push(result);
        }
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
          `  Difference:     ${d.difference.toString()}`
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
        if (e.unwrapPath) {
          console.log('  Unwrap path:');
          e.unwrapPath.forEach((step, index) => {
            console.log(
              `    ${index + 1}. ${step.chain} (${step.port}-${step.channel})`
            );
          });
        }
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

// Start the application if this file is being run directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

export {
  loadIBCData,
  hashIBCDenom,
  fetchIBCData,
  quickAudit,
  comprehensiveAudit,
  getAvailableChains,
  promptForAudit,
  runAudit,
};
