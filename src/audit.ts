import inquirer from 'inquirer';
import chalk from 'chalk';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

import { ChainDataUpdater } from './utils/updateChains.js';
import { loadIBCData, hashIBCDenom, getAllEscrowTokens, getTokenOrigin } from './core/ibcUtils.js';
import { performComprehensiveAudit } from './core/recursiveAudit.js';
import { performGrpcQuickAudit, performGrpcComprehensiveAudit } from './core/grpcAudit.js';
import logger from './core/logger.js';
import getChannelPairs from './core/pairChannels.js';
import { makeRequest, loadChainInfo, getAvailableChains, fetchBalance } from './core/chainUtils.js';
import type { ChainInfo, AuditOptions, AuditResult } from './types/common.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface AppConfig {
  paths: {
    dataDir: string;
  };
  audit: {
    defaultType: 'quick' | 'comprehensive' | 'manual';
    escrowPort: string;
    useGrpc: boolean;
  };
}

// Load configuration
const loadConfig = async (): Promise<AppConfig> => {
  const configPath = path.join(process.cwd(), 'config.json');
  try {
    const configFile = await fs.readFile(configPath, 'utf8');
    return JSON.parse(configFile) as AppConfig;
  } catch (error) {
    logger.warn(`Failed to load config, using defaults: ${error}`);
    return {
      paths: { dataDir: 'data' },
      audit: { defaultType: 'quick', escrowPort: 'transfer', useGrpc: true }
    };
  }
};

const config = await loadConfig();

export async function promptForAudit(): Promise<AuditOptions> {
  logger.info('Starting interactive audit prompt');
  
  const chains = await getAvailableChains();
  if (chains.length === 0) {
    throw new Error('No chain data found. Please run chain update first.');
  }

  const questions = [
    {
      type: 'list',
      name: 'primaryChain',
      message: 'Select the primary chain:',
      choices: chains.sort(),
      pageSize: 20
    },
    {
      type: 'list',
      name: 'secondaryChain',
      message: 'Select the secondary chain:',
      choices: (answers: any) => 
        chains.filter(chain => chain !== answers.primaryChain).sort(),
      pageSize: 20
    },
    {
      type: 'list',
      name: 'type',
      message: 'Select audit type:',
      choices: [
        {
          name: 'Quick Audit - Native token only (fastest)',
          value: 'quick'
        },
        {
          name: 'Comprehensive Audit - All tokens with recursive unwrapping',
          value: 'comprehensive'
        },
        {
          name: 'Manual Channel ID - Specify custom channel',
          value: 'manual'
        }
      ],
      default: config.audit.defaultType
    },
    {
      type: 'input',
      name: 'channelId',
      message: 'Enter channel ID (e.g., channel-0):',
      when: (answers: any) => answers.type === 'manual',
      validate: (input: string) => {
        if (!input || !input.match(/^channel-\d+$/)) {
          return 'Please enter a valid channel ID (e.g., channel-0)';
        }
        return true;
      }
    },
    {
      type: 'confirm',
      name: 'reverse',
      message: 'Also perform reverse audit?',
      default: true
    },
    {
      type: 'list',
      name: 'protocol',
      message: 'Select communication protocol:',
      choices: [
        {
          name: 'gRPC - Faster, more efficient (recommended)',
          value: 'grpc'
        },
        {
          name: 'REST - Traditional HTTP API (fallback)',
          value: 'rest'
        }
      ],
      default: config.audit.useGrpc ? 'grpc' : 'rest'
    }
  ];

  const answers = await inquirer.prompt(questions as any) as {
    primaryChain: string;
    secondaryChain: string;
    type: 'quick' | 'comprehensive' | 'manual';
    channelId?: string;
    reverse: boolean;
    protocol: 'grpc' | 'rest';
  };

  return {
    type: answers.type,
    primaryChain: answers.primaryChain,
    secondaryChain: answers.secondaryChain,
    channelId: answers.channelId,
    reverse: answers.reverse,
    protocol: answers.protocol
  };
}

export async function performQuickAudit(
  primaryChain: string,
  secondaryChain: string,
  channelId?: string,
  reverse: boolean = false
): Promise<AuditResult[]> {
  logger.info(`Starting quick audit: ${primaryChain} <-> ${secondaryChain}`);
  const startTime = Date.now();

  try {
    const results: AuditResult[] = [];
    
    // Load chain information
    const [primaryChainInfo, secondaryChainInfo] = await Promise.all([
      loadChainInfo(primaryChain),
      loadChainInfo(secondaryChain)
    ]);

    if (!primaryChainInfo || !secondaryChainInfo) {
      throw new Error(`Failed to load chain information for ${primaryChain} or ${secondaryChain}`);
    }

    // Get channel information if not provided
    if (!channelId) {
      const channelPairs = await getChannelPairs(primaryChain, secondaryChain);
      if (channelPairs.length === 0) {
        throw new Error(`No IBC channels found between ${primaryChain} and ${secondaryChain}`);
      }
      channelId = channelPairs[0][primaryChain];
      logger.info(`Using channel ID: ${channelId}`);
    }

    // Perform primary audit
    const primaryResult = await performSingleChainAudit(
      primaryChainInfo,
      secondaryChainInfo,
      channelId!,
      'primary'
    );
    results.push(primaryResult);

    // Perform reverse audit if requested
    if (reverse) {
      // Find the counterparty channel ID
      const channelPairs = await getChannelPairs(primaryChain, secondaryChain);
      const counterpartyChannelId = channelPairs.find(pair => 
        pair[primaryChain] === channelId
      )?.[secondaryChain];

      if (counterpartyChannelId) {
        const reverseResult = await performSingleChainAudit(
          secondaryChainInfo,
          primaryChainInfo,
          counterpartyChannelId!,
          'reverse'
        );
        results.push(reverseResult);
      } else {
        logger.warn(`Could not find counterparty channel for reverse audit`);
      }
    }

    const duration = Date.now() - startTime;
    logger.performance('quick_audit', duration, {
      primaryChain,
      secondaryChain,
      reverse,
      resultsCount: results.length
    });

    return results;

  } catch (error) {
    logger.error(`Quick audit failed: ${error}`);
    throw error;
  }
}

async function performSingleChainAudit(
  chainInfo: ChainInfo,
  counterpartyChainInfo: ChainInfo,
  channelId: string,
  direction: 'primary' | 'reverse'
): Promise<AuditResult> {
  const chainName = chainInfo.chain_name;
  logger.info(`Performing ${direction} audit on ${chainName} (channel: ${channelId})`);

  try {
    // Get native token info
    const nativeToken = chainInfo.staking?.staking_tokens?.[0]?.denom || '';
    if (!nativeToken) {
      throw new Error(`No native staking token found for ${chainName}`);
    }

    // Calculate escrow address (simplified - should use proper IBC escrow derivation)
    const escrowAddress = `${chainInfo.bech32_prefix}1${generateEscrowSuffix(channelId)}`;
    logger.info(`Using escrow address: ${escrowAddress}`);

    // Get escrow balance
    const escrowBalances = await fetchBalance(chainInfo, escrowAddress, nativeToken);
    const escrowBalance = escrowBalances.find(b => b.denom === nativeToken)?.amount || '0';

    // Calculate what the IBC denom would be on the counterparty chain
    const ibcDenom = hashIBCDenom(config.audit.escrowPort, channelId, nativeToken);
    
    // Get total supply of the IBC token on counterparty chain
    let expectedBalance = '0';
    try {
      const counterpartySupply = await makeRequest<{
        amount: { denom: string; amount: string };
      }>(
        counterpartyChainInfo.apis.rest.map(api => api.address),
        `/cosmos/bank/v1beta1/supply/by_denom?denom=${encodeURIComponent(ibcDenom)}`
      );
      expectedBalance = counterpartySupply.amount.amount;
    } catch (error) {
      logger.warn(`Could not fetch counterparty supply for ${ibcDenom}: ${error}`);
    }

    // Calculate discrepancy
    const escrowBig = BigInt(escrowBalance);
    const expectedBig = BigInt(expectedBalance);
    const discrepancy = (escrowBig - expectedBig).toString();

    logger.info(`Audit complete - Escrow: ${escrowBalance}, Expected: ${expectedBalance}, Discrepancy: ${discrepancy}`);

    return {
      chainName,
      escrowAddress,
      nativeToken,
      escrowBalance,
      expectedBalance,
      discrepancy,
      timestamp: Date.now()
    };

  } catch (error) {
    logger.error(`Single chain audit failed for ${chainName}: ${error}`);
    throw error;
  }
}

function generateEscrowSuffix(channelId: string): string {
  // Simplified escrow address generation
  // In practice, this would use the proper IBC module address derivation
  const channelNumber = channelId.replace('channel-', '');
  return `escrow${channelNumber}`;
}

export async function displayResults(results: AuditResult[]): Promise<void> {
  console.log('\n' + '='.repeat(80));
  console.log(chalk.bold.cyan(' IBC Escrow Audit Results'));
  console.log('='.repeat(80));

  for (const [index, result] of results.entries()) {
    console.log(`\n${chalk.bold.yellow(`Chain ${index + 1}: ${result.chainName}`)}`);
    console.log(chalk.gray('─'.repeat(40)));
    console.log(`${chalk.blue('Escrow Address:')} ${result.escrowAddress}`);
    console.log(`${chalk.blue('Native Token:')} ${result.nativeToken}`);
    console.log(`${chalk.blue('Escrow Balance:')} ${chalk.green(result.escrowBalance)}`);
    
    if (result.expectedBalance) {
      console.log(`${chalk.blue('Expected Balance:')} ${chalk.green(result.expectedBalance)}`);
      
      if (result.discrepancy && result.discrepancy !== '0') {
        const isPositive = !result.discrepancy.startsWith('-');
        const discrepancyColor = isPositive ? chalk.red : chalk.yellow;
        console.log(`${chalk.blue('Discrepancy:')} ${discrepancyColor(result.discrepancy)}`);
      } else {
        console.log(`${chalk.blue('Discrepancy:')} ${chalk.green('0 (balanced)')}`);
      }
    }
    
    console.log(`${chalk.blue('Timestamp:')} ${new Date(result.timestamp).toISOString()}`);
  }

  console.log('\n' + '='.repeat(80));
}

export async function main(): Promise<void> {
  try {
    console.log(chalk.bold.cyan(' IBC Escrow Audit Tool'));
    console.log(chalk.gray('Verifying IBC token escrow balances between Cosmos chains\n'));

    // Check command line arguments for quick execution
    const args = process.argv.slice(2);
    
    if (args.includes('--help') || args.includes('-h')) {
      console.log(`
Usage: npm start [options]

Options:
  quick                 Run quick audit with prompts
  comprehensive         Run comprehensive audit with prompts  
  --help, -h           Show this help message
  --update-chains      Update chain data before running
  --status             Show chain registry status

Examples:
  npm start                    # Interactive mode
  npm run quick               # Quick audit mode
  npm run comprehensive       # Comprehensive audit mode
  npm run update-chains       # Update chain data
`);
      return;
    }

    // Update chains if requested
    if (args.includes('--update-chains')) {
      logger.info('Updating chain data...');
      const updater = new ChainDataUpdater();
      await updater.updateChains();
      console.log(chalk.green(' Chain data updated successfully\n'));
    }

    // Show status if requested
    if (args.includes('--status')) {
      const updater = new ChainDataUpdater();
      const status = await updater.getUpdateStatus();
      console.log(chalk.bold.blue(' Chain Registry Status:'));
      console.log(`  ${chalk.blue('Last Update:')} ${status.lastUpdate || 'Never'}`);
      console.log(`  ${chalk.blue('Chain Files:')} ${status.chainCount}`);
      console.log(`  ${chalk.blue('IBC Files:')} ${status.ibcCount}`);
      console.log(`  ${chalk.blue('Cache Size:')} ${(status.cacheSize / 1024 / 1024).toFixed(2)} MB`);
      return;
    }

    // Ensure we have chain data
    const chains = await getAvailableChains();
    if (chains.length === 0) {
      console.log(chalk.yellow('  No chain data found. Updating chain registry...'));
      const updater = new ChainDataUpdater();
      await updater.updateChains();
    }

    let auditOptions: AuditOptions;

    // Check for direct command arguments
    if (args.includes('quick')) {
      auditOptions = await promptForAudit();
      auditOptions.type = 'quick';
    } else if (args.includes('comprehensive')) {
      auditOptions = await promptForAudit();
      auditOptions.type = 'comprehensive';
    } else {
      // Interactive mode
      auditOptions = await promptForAudit();
    }

    // Perform the audit
    let results: AuditResult[] = [];
    const useGrpc = auditOptions.protocol === 'grpc' || config.audit.useGrpc;
    
    if (useGrpc) {
      console.log(chalk.blue(' Using gRPC for enhanced performance'));
    } else {
      console.log(chalk.yellow(' Using REST API (fallback mode)'));
    }
    
    switch (auditOptions.type) {
      case 'quick':
        if (useGrpc && auditOptions.channelId) {
          results = await performGrpcQuickAudit(
            auditOptions.primaryChain,
            auditOptions.secondaryChain,
            auditOptions.channelId,
            auditOptions.reverse
          );
        } else {
          results = await performQuickAudit(
            auditOptions.primaryChain,
            auditOptions.secondaryChain,
            auditOptions.channelId,
            auditOptions.reverse
          );
        }
        break;
        
      case 'comprehensive':
        console.log(chalk.yellow('\n Performing comprehensive audit (this may take a while)...'));
        if (useGrpc) {
          const comprehensiveResult = await performGrpcComprehensiveAudit(
            auditOptions.primaryChain,
            auditOptions.secondaryChain,
            auditOptions.channelId
          );
          results = [comprehensiveResult];
          
          if (auditOptions.reverse) {
            const reverseResult = await performGrpcComprehensiveAudit(
              auditOptions.secondaryChain,
              auditOptions.primaryChain,
              auditOptions.channelId
            );
            results.push(reverseResult);
          }
        } else {
          const comprehensiveResult = await performComprehensiveAudit(
            auditOptions.primaryChain,
            auditOptions.secondaryChain,
            auditOptions.channelId
          );
          results = [comprehensiveResult];
          
          if (auditOptions.reverse) {
            const reverseResult = await performComprehensiveAudit(
              auditOptions.secondaryChain,
              auditOptions.primaryChain,
              auditOptions.channelId
            );
            results.push(reverseResult);
          }
        }
        break;
        
      case 'manual':
        if (!auditOptions.channelId) {
          throw new Error('Channel ID is required for manual audit');
        }
        if (useGrpc) {
          results = await performGrpcQuickAudit(
            auditOptions.primaryChain,
            auditOptions.secondaryChain,
            auditOptions.channelId,
            auditOptions.reverse
          );
        } else {
          results = await performQuickAudit(
            auditOptions.primaryChain,
            auditOptions.secondaryChain,
            auditOptions.channelId,
            auditOptions.reverse
          );
        }
        break;
        
      default:
        throw new Error(`Unknown audit type: ${auditOptions.type}`);
    }

    // Display results
    await displayResults(results);

    // Log audit completion
    logger.audit('audit_completed', {
      type: auditOptions.type,
      primaryChain: auditOptions.primaryChain,
      secondaryChain: auditOptions.secondaryChain,
      channelId: auditOptions.channelId,
      reverse: auditOptions.reverse,
      resultsCount: results.length
    });

    console.log(chalk.green('\n Audit completed successfully!'));

  } catch (error) {
    logger.error(`Audit failed: ${error}`);
    console.error(chalk.red(`\n Error: ${error}`));
    process.exit(1);
  }
}

// Run the main function if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}