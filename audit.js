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

async function quickAudit(primaryChain, secondaryChain, channelId) {
  logger.info(
    `Starting quick IBC escrow audit for ${primaryChain} -> ${secondaryChain} on channel ${channelId}`
  );
  const primaryChainInfo = await loadChainInfo(primaryChain);
  const secondaryChainInfo = await loadChainInfo(secondaryChain);

  const primaryRestEndpoints = primaryChainInfo.apis.rest.map(
    (api) => api.address
  );
  const secondaryRestEndpoints = secondaryChainInfo.apis.rest.map(
    (api) => api.address
  );

  const nativeToken = await getNativeToken(primaryChainInfo);
  logger.info(`Native token for ${primaryChain} identified as: ${nativeToken}`);

  const escrowPath = `/ibc/apps/transfer/v1/channels/${channelId}/ports/${config.audit.escrowPort}/escrow_address`;
  const escrowData = await makeRequest(primaryRestEndpoints, escrowPath);
  const escrowAddress = escrowData.escrow_address;

  const balancesPath = `/cosmos/bank/v1beta1/balances/${escrowAddress}`;
  const balancesData = await makeRequest(primaryRestEndpoints, balancesPath);

  const nativeBalance = balancesData.balances.find(
    (b) => b.denom === nativeToken
  );

  if (!nativeBalance) {
    console.log(`No native token (${nativeToken}) found in escrow.`);
    return;
  }

  const counterpartyIbcDenom = hashIBCDenom(
    config.audit.escrowPort,
    channelId,
    nativeToken
  );
  const totalSupplyPath = `/cosmos/bank/v1beta1/supply/by_denom?denom=${counterpartyIbcDenom}`;
  const totalSupplyData = await makeRequest(
    secondaryRestEndpoints,
    totalSupplyPath
  );

  console.log('\n========== Quick IBC Escrow Audit Summary ==========');
  console.log(`Native Token: ${nativeToken}`);
  console.log(`Escrow Balance: ${nativeBalance.amount}`);
  console.log(`Counterparty Total Supply: ${totalSupplyData.amount.amount}`);
  console.log(
    `Difference: ${BigInt(nativeBalance.amount) - BigInt(totalSupplyData.amount.amount)}`
  );
  console.log('====================================================\n');
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
    discrepancies: [],
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
      const totalSupplyPath = `/cosmos/bank/v1beta1/supply/by_denom?denom=${counterpartyIbcDenom}`;
      const totalSupplyData = await makeRequest(
        secondaryRestEndpoints,
        totalSupplyPath
      );

      if (!totalSupplyData || !totalSupplyData.amount) {
        logger.error(
          `Unexpected response format for total supply of ${counterpartyIbcDenom}:`,
          totalSupplyData
        );
        continue;
      }

      const totalSupply = totalSupplyData.amount.amount;

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
    }

    // Print summary
    console.log('\n========== IBC Escrow Audit Summary ==========');
    console.log(`Total tokens checked: ${stats.totalTokensChecked}`);
    console.log(`Tokens with discrepancies: ${stats.tokensWithDiscrepancies}`);
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
  console.log(
    chalk.green(
      `\nStarting ${auditType} audit for ${primaryChain} -> ${secondaryChain}`
    )
  );
  logger.info(`Fetching IBC data for ${primaryChain} and ${secondaryChain}`);

  let ibcData;
  if (auditType !== 'manual') {
    ibcData = await fetchIBCData(primaryChain, secondaryChain);
    const primaryChainInfo = await loadChainInfo(primaryChain);
    const secondaryChainInfo = await loadChainInfo(secondaryChain);
    const isValid = await validateIBCData(
      ibcData,
      primaryChainInfo,
      secondaryChainInfo,
      primaryChain
    );
    if (!isValid) {
      throw new Error('IBC data validation failed. Aborting audit.');
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

    const { runReverse } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'runReverse',
        message:
          'Would you like to run the audit in reverse (secondary -> primary)?',
        default: true,
      },
    ]);

    if (runReverse) {
      await runAudit(secondaryChain, primaryChain, auditType);
    }

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
