import chalk from 'chalk';
import dotenv from 'dotenv';
import { promises as fs } from 'fs';
import inquirer from 'inquirer';
import path from 'path';
import { fetchBalance, getAvailableChains, loadChainInfo, makeRequest } from './core/chainUtils.js';
import {
  type IbcChannelLink,
  listIbcLinksBetweenChains,
  listIbcLinksForChain,
} from './core/channelRegistry.js';
import {
  type ChannelInfoLookupResult,
  type EscrowLookupResult,
  lookupChannelInfo,
  lookupEscrowAddress,
} from './core/escrowLookup.js';
import { performGrpcComprehensiveAudit, performGrpcQuickAudit } from './core/grpcAudit.js';
import { hashIBCDenom } from './core/ibcUtils.js';
import logger from './core/logger.js';
import getChannelPairs from './core/pairChannels.js';
import { performComprehensiveAudit } from './core/recursiveAudit.js';
import type { AuditOptions, AuditResult, ChainInfo } from './types/common.js';
import { ChainDataUpdater } from './utils/updateChains.js';

dotenv.config();

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
      audit: { defaultType: 'quick', escrowPort: 'transfer', useGrpc: true },
    };
  }
};

const config = await loadConfig();

type MainMenuAction =
  | 'quick'
  | 'comprehensive'
  | 'lookup'
  | 'channel-info'
  | 'update-chains'
  | 'status'
  | 'exit';

interface ChannelSelection {
  channelId: string;
  portId: string;
  counterpartyChainName?: string;
  counterpartyChannelId?: string;
  counterpartyPortId?: string;
  registryLink?: IbcChannelLink;
}

type PromptQuestion = Record<string, unknown>;

async function promptAnswers<T>(questions: PromptQuestion[]): Promise<T> {
  return (await inquirer.prompt(
    questions as unknown as Parameters<typeof inquirer.prompt>[0]
  )) as T;
}

function clearScreen(): void {
  if (process.stdout.isTTY) {
    console.clear();
  }
}

function printHeader(title: string = 'IBC Escrow Audit'): void {
  clearScreen();
  console.log(chalk.bold.cyan(title));
  console.log(chalk.gray('='.repeat(72)));
  console.log(chalk.gray('gRPC audits, registry channel discovery, and escrow lookup'));
  console.log(chalk.gray('='.repeat(72)));
}

function printSection(title: string): void {
  console.log();
  console.log(chalk.bold.blue(title));
  console.log(chalk.gray('-'.repeat(72)));
}

function printKeyValue(label: string, value: string | number | null | undefined): void {
  console.log(`${chalk.gray(label.padEnd(24))}${value ?? chalk.dim('n/a')}`);
}

async function ensureChainsAvailable(): Promise<string[]> {
  let chains = await getAvailableChains().catch(() => []);

  if (chains.length === 0) {
    console.log(chalk.yellow('No local chain registry data found. Updating chain data first.'));
    const updater = new ChainDataUpdater();
    await updater.updateChains();
    chains = await getAvailableChains();
  }

  if (chains.length === 0) {
    throw new Error('No chain data found after registry update.');
  }

  return chains.sort((a, b) => a.localeCompare(b));
}

async function pauseForMenu(): Promise<void> {
  if (!process.stdin.isTTY) {
    return;
  }

  await promptAnswers<{ continue: string }>([
    {
      type: 'input',
      name: 'continue',
      message: chalk.gray('Press Enter to return to the menu'),
    },
  ]);
}

async function promptForChain(
  chains: string[],
  message: string,
  excludeChain?: string
): Promise<string> {
  const choices = chains
    .filter((chain) => chain !== excludeChain)
    .map((chain) => ({ name: chain, value: chain }));

  const answer = await promptAnswers<{ chain: string }>([
    {
      type: 'list',
      name: 'chain',
      message,
      choices,
      pageSize: 20,
    },
  ]);

  return answer.chain;
}

function formatLinkTags(link: IbcChannelLink): string {
  const tags = [
    link.tags.preferred ? 'preferred' : null,
    link.tags.status || null,
    link.tags.dex || null,
  ].filter((tag): tag is string => Boolean(tag));

  return tags.length > 0 ? chalk.green(` [${tags.join(', ')}]`) : '';
}

function formatLinkChoice(link: IbcChannelLink): string {
  return [
    chalk.cyan(link.chainName),
    chalk.white(link.channelId),
    chalk.gray('->'),
    chalk.cyan(link.counterpartyChainName),
    chalk.white(link.counterpartyChannelId),
    chalk.gray(`(${link.portId}/${link.counterpartyPortId})`),
    formatLinkTags(link),
  ].join(' ');
}

async function promptForManualChannel(defaultPort: string): Promise<ChannelSelection> {
  const answer = await promptAnswers<{ channelId: string; portId: string }>([
    {
      type: 'input',
      name: 'channelId',
      message: 'Channel ID:',
      validate: (input: string) =>
        /^channel-\d+$/.test(input) || 'Enter a valid channel ID, for example channel-0',
    },
    {
      type: 'input',
      name: 'portId',
      message: 'Port ID:',
      default: defaultPort,
      validate: (input: string) => Boolean(input.trim()) || 'Port ID is required',
    },
  ]);

  return {
    channelId: answer.channelId.trim(),
    portId: answer.portId.trim(),
  };
}

async function promptForChannelSelection(
  chainName: string,
  counterpartyChainName?: string,
  forceManual: boolean = false
): Promise<ChannelSelection> {
  const defaultPort = config.audit.escrowPort || 'transfer';

  if (forceManual) {
    return promptForManualChannel(defaultPort);
  }

  const links = counterpartyChainName
    ? await listIbcLinksBetweenChains(chainName, counterpartyChainName)
    : await listIbcLinksForChain(chainName);

  if (links.length === 0) {
    console.log(chalk.yellow('No registry channel match found. Enter a channel manually.'));
    return promptForManualChannel(defaultPort);
  }

  const answer = await promptAnswers<{ selection: IbcChannelLink | 'manual' }>([
    {
      type: 'list',
      name: 'selection',
      message: 'Select channel:',
      choices: [
        ...links.map((link) => ({
          name: formatLinkChoice(link),
          value: link,
        })),
        {
          name: chalk.yellow('Enter channel manually'),
          value: 'manual',
        },
      ],
      pageSize: 15,
    },
  ]);

  if (answer.selection === 'manual') {
    return promptForManualChannel(defaultPort);
  }

  const link = answer.selection;
  return {
    channelId: link.channelId,
    portId: link.portId,
    counterpartyChainName: link.counterpartyChainName,
    counterpartyChannelId: link.counterpartyChannelId,
    counterpartyPortId: link.counterpartyPortId,
    registryLink: link,
  };
}

export async function promptForAudit(forcedType?: AuditOptions['type']): Promise<AuditOptions> {
  logger.info('Starting interactive audit prompt');

  const chains = await ensureChainsAvailable();
  const primaryChain = await promptForChain(chains, 'Primary chain:');
  const secondaryChain = await promptForChain(chains, 'Counterparty chain:', primaryChain);

  const type =
    forcedType ||
    (
      await promptAnswers<{ type: AuditOptions['type'] }>([
        {
          type: 'list',
          name: 'type',
          message: 'Audit mode:',
          choices: [
            {
              name: `${chalk.green('Quick')} native token escrow check`,
              value: 'quick',
            },
            {
              name: `${chalk.blue('Comprehensive')} recursive token audit`,
              value: 'comprehensive',
            },
            {
              name: `${chalk.yellow('Manual')} quick audit with custom channel`,
              value: 'manual',
            },
          ],
          default: config.audit.defaultType,
        },
      ])
    ).type;

  const channelSelection = await promptForChannelSelection(
    primaryChain,
    secondaryChain,
    type === 'manual'
  );

  const preferences = await promptAnswers<{
    reverse: boolean;
    protocol: 'grpc' | 'rest';
  }>([
    {
      type: 'confirm',
      name: 'reverse',
      message: 'Also perform reverse audit?',
      default: Boolean(channelSelection.counterpartyChannelId),
    },
    {
      type: 'list',
      name: 'protocol',
      message: 'Protocol:',
      choices: [
        {
          name: `${chalk.green('gRPC')} faster balance and supply queries`,
          value: 'grpc',
        },
        {
          name: `${chalk.yellow('REST')} fallback HTTP API`,
          value: 'rest',
        },
      ],
      default: config.audit.useGrpc ? 'grpc' : 'rest',
    },
  ]);

  return {
    type,
    primaryChain,
    secondaryChain,
    channelId: channelSelection.channelId,
    portId: channelSelection.portId,
    counterpartyChannelId: channelSelection.counterpartyChannelId,
    counterpartyPortId: channelSelection.counterpartyPortId,
    reverse: preferences.reverse,
    protocol: preferences.protocol,
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
      loadChainInfo(secondaryChain),
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

    if (!channelId) {
      throw new Error(`No channel ID resolved for ${primaryChain} -> ${secondaryChain}`);
    }

    // Perform primary audit
    const primaryResult = await performSingleChainAudit(
      primaryChainInfo,
      secondaryChainInfo,
      channelId,
      'primary'
    );
    results.push(primaryResult);

    // Perform reverse audit if requested
    if (reverse) {
      // Find the counterparty channel ID
      const channelPairs = await getChannelPairs(primaryChain, secondaryChain);
      const counterpartyChannelId = channelPairs.find((pair) => pair[primaryChain] === channelId)?.[
        secondaryChain
      ];

      if (counterpartyChannelId) {
        const reverseResult = await performSingleChainAudit(
          secondaryChainInfo,
          primaryChainInfo,
          counterpartyChannelId,
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
      resultsCount: results.length,
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
    const escrowBalance = escrowBalances.find((b) => b.denom === nativeToken)?.amount || '0';

    // Calculate what the IBC denom would be on the counterparty chain
    const ibcDenom = hashIBCDenom(config.audit.escrowPort, channelId, nativeToken);

    // Get total supply of the IBC token on counterparty chain
    let expectedBalance = '0';
    try {
      const counterpartySupply = await makeRequest<{
        amount: { denom: string; amount: string };
      }>(
        counterpartyChainInfo.apis.rest.map((api) => api.address),
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

    logger.info(
      `Audit complete - Escrow: ${escrowBalance}, Expected: ${expectedBalance}, Discrepancy: ${discrepancy}`
    );

    return {
      chainName,
      escrowAddress,
      nativeToken,
      escrowBalance,
      expectedBalance,
      discrepancy,
      timestamp: Date.now(),
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
  console.log(`\n${'='.repeat(80)}`);
  console.log(chalk.bold.cyan(' IBC Escrow Audit Results'));
  console.log('='.repeat(80));

  for (const [index, result] of results.entries()) {
    console.log(`\n${chalk.bold.yellow(`Chain ${index + 1}: ${result.chainName}`)}`);
    console.log(chalk.gray('-'.repeat(40)));
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

  console.log(`\n${'='.repeat(80)}`);
}

function displayEscrowLookupResult(result: EscrowLookupResult, selection: ChannelSelection): void {
  printSection('Escrow Address');
  printKeyValue('Chain', `${result.chainName} (${result.chainId})`);
  printKeyValue('Port / channel', `${result.portId}/${result.channelId}`);

  if (selection.counterpartyChainName) {
    printKeyValue(
      'Counterparty',
      `${selection.counterpartyChainName} ${selection.counterpartyChannelId ?? ''}`.trim()
    );
  }

  printKeyValue('Escrow address', chalk.green(result.escrowAddress));
  printKeyValue('REST endpoints', result.restEndpoints.length);

  for (const endpoint of result.restEndpoints.slice(0, 3)) {
    console.log(`${chalk.gray('  - '.padEnd(24))}${endpoint}`);
  }
}

function displayChannelInfoResult(result: ChannelInfoLookupResult): void {
  printSection('Channel Details');
  printKeyValue('Chain', `${result.chainName} (${result.chainId})`);
  printKeyValue('Port / channel', `${result.portId}/${result.channelId}`);
  printKeyValue(
    'Counterparty channel',
    `${result.counterpartyPortId}/${result.counterpartyChannelId}`
  );
  printKeyValue('Connection', result.connectionId);
  printKeyValue('Client', result.clientId);
  printKeyValue('Counterparty client', result.counterpartyClientId);
  printKeyValue('Counterparty conn', result.counterpartyConnectionId);
  printKeyValue('Counterparty chain ID', result.counterpartyChainId);
  printKeyValue('Ordering', result.ordering);
  printKeyValue('Version', result.version);
}

async function runAuditFromOptions(auditOptions: AuditOptions): Promise<void> {
  const useGrpc = auditOptions.protocol ? auditOptions.protocol === 'grpc' : config.audit.useGrpc;
  let results: AuditResult[] = [];

  printSection('Audit');
  printKeyValue('Path', `${auditOptions.primaryChain} -> ${auditOptions.secondaryChain}`);
  printKeyValue('Mode', auditOptions.type);
  printKeyValue('Protocol', useGrpc ? 'gRPC' : 'REST');
  printKeyValue('Channel', auditOptions.channelId || 'registry default');

  switch (auditOptions.type) {
    case 'quick':
    case 'manual':
      if (useGrpc) {
        if (!auditOptions.channelId) {
          throw new Error('gRPC quick audit requires a channel ID.');
        }

        results = await performGrpcQuickAudit(
          auditOptions.primaryChain,
          auditOptions.secondaryChain,
          auditOptions.channelId,
          false
        );

        if (auditOptions.reverse) {
          const reverseChannelId = auditOptions.counterpartyChannelId || auditOptions.channelId;
          results.push(
            ...(await performGrpcQuickAudit(
              auditOptions.secondaryChain,
              auditOptions.primaryChain,
              reverseChannelId,
              false
            ))
          );
        }
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
      console.log(chalk.yellow('Comprehensive audit can take several minutes on busy chains.'));
      if (useGrpc) {
        results = [
          await performGrpcComprehensiveAudit(
            auditOptions.primaryChain,
            auditOptions.secondaryChain,
            auditOptions.channelId
          ),
        ];

        if (auditOptions.reverse) {
          results.push(
            await performGrpcComprehensiveAudit(
              auditOptions.secondaryChain,
              auditOptions.primaryChain,
              auditOptions.counterpartyChannelId || auditOptions.channelId
            )
          );
        }
      } else {
        results = [
          await performComprehensiveAudit(
            auditOptions.primaryChain,
            auditOptions.secondaryChain,
            auditOptions.channelId
          ),
        ];

        if (auditOptions.reverse) {
          results.push(
            await performComprehensiveAudit(
              auditOptions.secondaryChain,
              auditOptions.primaryChain,
              auditOptions.counterpartyChannelId || auditOptions.channelId
            )
          );
        }
      }
      break;

    default:
      throw new Error(`Unknown audit type: ${auditOptions.type}`);
  }

  await displayResults(results);

  logger.audit('audit_completed', {
    type: auditOptions.type,
    primaryChain: auditOptions.primaryChain,
    secondaryChain: auditOptions.secondaryChain,
    channelId: auditOptions.channelId,
    reverse: auditOptions.reverse,
    protocol: auditOptions.protocol,
    resultsCount: results.length,
  });
}

async function runEscrowLookupAction(): Promise<void> {
  printHeader('IBC Escrow Address Lookup');
  const chains = await ensureChainsAvailable();
  const chainName = await promptForChain(chains, 'Chain:');
  const selection = await promptForChannelSelection(chainName);
  const chainInfo = await loadChainInfo(chainName);

  console.log(chalk.gray('\nQuerying transfer module escrow address endpoint...'));
  const result = await lookupEscrowAddress({
    chainInfo,
    channelId: selection.channelId,
    portId: selection.portId,
  });

  displayEscrowLookupResult(result, selection);

  const answer = await promptAnswers<{ inspect: boolean }>([
    {
      type: 'confirm',
      name: 'inspect',
      message: 'Fetch channel and connection details too?',
      default: true,
    },
  ]);

  if (answer.inspect) {
    const channelInfo = await lookupChannelInfo({
      chainInfo,
      channelId: selection.channelId,
      portId: selection.portId,
    });
    displayChannelInfoResult(channelInfo);
  }
}

async function runChannelInfoAction(): Promise<void> {
  printHeader('IBC Channel Lookup');
  const chains = await ensureChainsAvailable();
  const chainName = await promptForChain(chains, 'Chain:');
  const selection = await promptForChannelSelection(chainName);
  const chainInfo = await loadChainInfo(chainName);

  console.log(chalk.gray('\nQuerying channel, connection, and client endpoints...'));
  const result = await lookupChannelInfo({
    chainInfo,
    channelId: selection.channelId,
    portId: selection.portId,
  });

  displayChannelInfoResult(result);
}

async function runStatusAction(): Promise<void> {
  printHeader('Chain Registry Status');
  const updater = new ChainDataUpdater();
  const status = await updater.getUpdateStatus();

  printSection('Local Data');
  printKeyValue('Last update', status.lastUpdate?.trim() || 'Never');
  printKeyValue('Chain files', status.chainCount);
  printKeyValue('IBC files', status.ibcCount);
  printKeyValue('gRPC cache size', `${(status.cacheSize / 1024 / 1024).toFixed(2)} MB`);
}

async function runUpdateChainsAction(forceUpdate: boolean = false): Promise<void> {
  printHeader('Update Chain Data');
  const updater = new ChainDataUpdater();
  await updater.updateChains(forceUpdate);
  console.log(chalk.green('\nChain data update completed.'));
}

async function runInteractiveTui(): Promise<void> {
  while (true) {
    printHeader();

    const answer = await promptAnswers<{ action: MainMenuAction }>([
      {
        type: 'list',
        name: 'action',
        message: 'Select action:',
        choices: [
          {
            name: `${chalk.green('Quick audit')} ${chalk.gray('native token escrow balance')}`,
            value: 'quick',
          },
          {
            name: `${chalk.blue('Comprehensive audit')} ${chalk.gray('recursive token tracing')}`,
            value: 'comprehensive',
          },
          {
            name: `${chalk.cyan('Escrow lookup')} ${chalk.gray('chain/channel escrow address')}`,
            value: 'lookup',
          },
          {
            name: `${chalk.cyan('Channel lookup')} ${chalk.gray('counterparty, connection, client')}`,
            value: 'channel-info',
          },
          {
            name: `${chalk.yellow('Update chain data')} ${chalk.gray('sync registry files')}`,
            value: 'update-chains',
          },
          {
            name: `${chalk.white('Status')} ${chalk.gray('local registry and cache summary')}`,
            value: 'status',
          },
          {
            name: chalk.gray('Exit'),
            value: 'exit',
          },
        ],
        pageSize: 10,
      },
    ]);

    if (answer.action === 'exit') {
      return;
    }

    try {
      switch (answer.action) {
        case 'quick':
          printHeader('Quick Audit');
          await runAuditFromOptions(await promptForAudit('quick'));
          break;
        case 'comprehensive':
          printHeader('Comprehensive Audit');
          await runAuditFromOptions(await promptForAudit('comprehensive'));
          break;
        case 'lookup':
          await runEscrowLookupAction();
          break;
        case 'channel-info':
          await runChannelInfoAction();
          break;
        case 'update-chains':
          await runUpdateChainsAction();
          break;
        case 'status':
          await runStatusAction();
          break;
      }
    } catch (error) {
      logger.error(`TUI action failed: ${error}`);
      console.error(chalk.red(`\nError: ${error}`));
    }

    await pauseForMenu();
  }
}

function setRoutineConsoleLogging(enabled: boolean): void {
  const transports = logger.transports as Array<{
    constructor: { name: string };
    silent?: boolean;
  }>;

  for (const transport of transports) {
    if (transport.constructor.name === 'Console') {
      transport.silent = !enabled;
    }
  }
}

function printHelp(): void {
  console.log(`
${chalk.bold.cyan('IBC Escrow Audit Tool')}

Usage:
  yarn start
  node dist/audit.js [command] [options]

Commands:
  quick             Prompt for a quick native-token audit
  comprehensive     Prompt for a recursive comprehensive audit
  lookup            Look up an IBC escrow address by chain/channel
  channel-info      Inspect channel, connection, and client state
  status            Show local chain registry status
  update-chains     Sync chain registry data

Options:
  --update-chains    Sync chain data before running the command
  --force, -f        Force chain data refresh
  --verbose          Keep routine console logs enabled
  --help, -h         Show this help
`);
}

export async function main(): Promise<void> {
  try {
    const args = process.argv.slice(2);
    const verbose = args.includes('--verbose');
    setRoutineConsoleLogging(verbose);

    if (args.includes('--help') || args.includes('-h')) {
      printHelp();
      return;
    }

    const forceUpdate = args.includes('--force') || args.includes('-f');
    const command = args.find((arg) =>
      ['quick', 'comprehensive', 'lookup', 'channel-info', 'status', 'update-chains'].includes(arg)
    ) as MainMenuAction | undefined;

    if (args.includes('--update-chains') || command === 'update-chains') {
      await runUpdateChainsAction(forceUpdate);
      if (!command || command === 'update-chains') {
        return;
      }
    }

    switch (command) {
      case 'quick':
        printHeader('Quick Audit');
        await runAuditFromOptions(await promptForAudit('quick'));
        return;
      case 'comprehensive':
        printHeader('Comprehensive Audit');
        await runAuditFromOptions(await promptForAudit('comprehensive'));
        return;
      case 'lookup':
        await runEscrowLookupAction();
        return;
      case 'channel-info':
        await runChannelInfoAction();
        return;
      case 'status':
        await runStatusAction();
        return;
      default:
        await runInteractiveTui();
    }
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
