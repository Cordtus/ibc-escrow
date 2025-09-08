import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import logger from './logger.js';
import { makeRequest, loadChainInfo } from './chainUtils.js';
import type { ChainInfo, IBCData } from '../types/common.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(process.cwd(), 'data');
const IBC_DATA_DIR = path.join(DATA_DIR, 'ibc');

interface DenomTrace {
  denom_trace: {
    path: string;
    base_denom: string;
  };
}

interface TokenOrigin {
  originalDenom: string;
  originChain: string;
  hops: Array<{
    fromChain: string;
    toChain: string;
    channelId: string;
    portId: string;
  }>;
  fullPath: string;
}

interface RecursiveUnwrapResult {
  baseDenom: string;
  originChain: string;
  path: Array<{
    chain: string;
    channelId: string;
    portId: string;
  }>;
  isComplete: boolean;
}

export async function loadIBCData(chain1: string, chain2: string): Promise<IBCData | null> {
  logger.info(`Loading IBC data for ${chain1} and ${chain2}`);

  try {
    const files = await fs.readdir(IBC_DATA_DIR);
    const matchingFile = files.find(
      (file) =>
        (file.toLowerCase().includes(chain1.toLowerCase()) &&
         file.toLowerCase().includes(chain2.toLowerCase())) ||
        (file.toLowerCase().includes(chain2.toLowerCase()) &&
         file.toLowerCase().includes(chain1.toLowerCase()))
    );

    if (!matchingFile) {
      logger.error(`No matching IBC data file found for ${chain1} and ${chain2}`);
      logger.info('Available IBC data files:', files);
      return null;
    }

    const ibcFilePath = path.join(IBC_DATA_DIR, matchingFile);
    const ibcData = await fs.readFile(ibcFilePath, 'utf8');
    const parsedData: IBCData = JSON.parse(ibcData);

    // Validate the IBC data structure
    if (!validateIBCData(parsedData)) {
      throw new Error(`Invalid IBC data structure in ${matchingFile}`);
    }

    logger.info(`Successfully loaded IBC data from ${matchingFile}`);
    return parsedData;

  } catch (error) {
    logger.error(`Error loading IBC data for ${chain1}-${chain2}:`, error);
    throw error;
  }
}

export function validateIBCData(data: unknown): data is IBCData {
  if (!data || typeof data !== 'object') {
    return false;
  }

  const ibcData = data as Partial<IBCData>;

  return !!(
    ibcData.chain_1 &&
    ibcData.chain_2 &&
    ibcData.channels &&
    Array.isArray(ibcData.channels) &&
    ibcData.channels.length > 0 &&
    ibcData.channels.every(channel =>
      channel.chain_1?.channel_id &&
      channel.chain_2?.channel_id &&
      channel.ordering &&
      channel.version
    )
  );
}

export function validateId(id: string, type: 'channel' | 'connection' | 'client'): void {
  const patterns = {
    channel: /^channel-\d+$/,
    connection: /^connection-\d+$/,
    client: /^07-tendermint-\d+$/
  };

  if (!patterns[type].test(id)) {
    throw new Error(`Invalid ${type} ID format: ${id}`);
  }
}

export function hashIBCDenom(portId: string, channelId: string, baseDenom: string): string {
  const fullPath = `${portId}/${channelId}/${baseDenom}`;
  const hash = crypto.createHash('sha256').update(fullPath).digest('hex');
  return `ibc/${hash.toUpperCase()}`;
}

export async function fetchIBCData(
  chainInfo: ChainInfo,
  type: 'channels' | 'connections' | 'clients',
  id?: string
): Promise<unknown> {
  const restEndpoints = chainInfo.apis.rest.map(api => api.address);
  let path = `/ibc/core/${type === 'channels' ? 'channel' : type.slice(0, -1)}/v1/${type}`;

  if (id) {
    path += `/${id}`;
  }

  try {
    const response = await makeRequest(restEndpoints, path);
    logger.debug(`Successfully fetched IBC ${type} data${id ? ` for ${id}` : ''}`);
    return response;
  } catch (error) {
    logger.error(`Failed to fetch IBC ${type} data: ${error}`);
    throw error;
  }
}

// Enhanced recursive unwrapping that handles multi-hop IBC tokens
export async function recursiveUnwrapToken(
  chainInfo: ChainInfo,
  denom: string,
  visitedChains: Set<string> = new Set(),
  currentPath: Array<{ chain: string; channelId: string; portId: string }> = []
): Promise<RecursiveUnwrapResult> {
  const chainName = chainInfo.chain_name;

  // Prevent infinite loops
  if (visitedChains.has(chainName)) {
    logger.warn(`Circular reference detected for chain ${chainName}, stopping recursion`);
    return {
      baseDenom: denom,
      originChain: chainName,
      path: currentPath,
      isComplete: false
    };
  }

  visitedChains.add(chainName);

  // If not an IBC token, this is the origin
  if (!denom.startsWith('ibc/')) {
    logger.debug(`Found origin token: ${denom} on ${chainName}`);
    return {
      baseDenom: denom,
      originChain: chainName,
      path: currentPath,
      isComplete: true
    };
  }

  const hash = denom.split('/')[1];
  const tracePath = `/ibc/apps/transfer/v1/denom_traces/${hash}`;

  try {
    const traceData = await makeRequest<DenomTrace>(
      chainInfo.apis.rest.map(api => api.address),
      tracePath
    );

    if (!traceData?.denom_trace) {
      logger.warn(`No denom trace found for ${denom} on ${chainName}`);
      return {
        baseDenom: denom,
        originChain: chainName,
        path: currentPath,
        isComplete: false
      };
    }

    const trace = traceData.denom_trace;
    const pathParts = trace.path.split('/');

    if (pathParts.length < 2) {
      logger.warn(`Invalid trace path: ${trace.path}`);
      return {
        baseDenom: trace.base_denom,
        originChain: chainName,
        path: currentPath,
        isComplete: false
      };
    }

    const portId = pathParts[0];
    const channelId = pathParts[1];

    logger.debug(`Tracing ${denom} on ${chainName}: ${portId}/${channelId}/${trace.base_denom}`);

    // Add current hop to path
    const newPath = [...currentPath, { chain: chainName, channelId, portId }];

    // Find the counterparty chain for this channel
    const counterpartyChain = await findCounterpartyChain(chainName, channelId);

    if (!counterpartyChain) {
      logger.warn(`Could not find counterparty chain for ${chainName}/${channelId}`);
      return {
        baseDenom: trace.base_denom,
        originChain: chainName,
        path: newPath,
        isComplete: false
      };
    }

    // Load counterparty chain info and continue recursion
    try {
      const counterpartyChainInfo = await loadChainInfo(counterpartyChain);
      if (!counterpartyChainInfo) {
        throw new Error(`Failed to load chain info for ${counterpartyChain}`);
      }

      // Continue unwrapping on the counterparty chain
      return await recursiveUnwrapToken(
        counterpartyChainInfo,
        trace.base_denom,
        visitedChains,
        newPath
      );

    } catch (error) {
      logger.error(`Failed to continue tracing on ${counterpartyChain}: ${error}`);
      return {
        baseDenom: trace.base_denom,
        originChain: counterpartyChain,
        path: newPath,
        isComplete: false
      };
    }

  } catch (error) {
    logger.error(`Error fetching denom trace for ${denom} on ${chainName}: ${error}`);
    return {
      baseDenom: denom,
      originChain: chainName,
      path: currentPath,
      isComplete: false
    };
  }
}

// Enhanced function to find counterparty chain
async function findCounterpartyChain(chainName: string, channelId: string): Promise<string | null> {
  try {
    // Search through all IBC files to find the counterparty
    const files = await fs.readdir(IBC_DATA_DIR);

    for (const file of files) {
      if (!file.endsWith('.json')) continue;

      try {
        const ibcFilePath = path.join(IBC_DATA_DIR, file);
        const ibcData: IBCData = JSON.parse(await fs.readFile(ibcFilePath, 'utf8'));

        // Check if this file contains our chain and channel
        for (const channel of ibcData.channels) {
          if (ibcData.chain_1.chain_name === chainName && channel.chain_1.channel_id === channelId) {
            return ibcData.chain_2.chain_name;
          }
          if (ibcData.chain_2.chain_name === chainName && channel.chain_2.channel_id === channelId) {
            return ibcData.chain_1.chain_name;
          }
        }
      } catch (error) {
        logger.debug(`Error parsing IBC file ${file}: ${error}`);
        continue;
      }
    }

    return null;
  } catch (error) {
    logger.error(`Error finding counterparty chain: ${error}`);
    return null;
  }
}

// Function to get complete token origin information
export async function getTokenOrigin(
  chainInfo: ChainInfo,
  denom: string
): Promise<TokenOrigin | null> {
  try {
    const result = await recursiveUnwrapToken(chainInfo, denom);

    if (!result.isComplete) {
      logger.warn(`Incomplete token trace for ${denom}`);
    }

    // Convert path to hops format
    const hops = result.path.map((hop, index) => {
      const nextHop = result.path[index + 1];
      return {
        fromChain: hop.chain,
        toChain: nextHop?.chain || result.originChain,
        channelId: hop.channelId,
        portId: hop.portId
      };
    });

    const fullPath = result.path
      .map(hop => `${hop.portId}/${hop.channelId}`)
      .join('/') + (result.path.length > 0 ? `/${result.baseDenom}` : '');

    return {
      originalDenom: result.baseDenom,
      originChain: result.originChain,
      hops,
      fullPath
    };

  } catch (error) {
    logger.error(`Failed to get token origin for ${denom}: ${error}`);
    return null;
  }
}

// Function to get all IBC tokens in escrow for comprehensive auditing
export async function getAllEscrowTokens(
  chainInfo: ChainInfo,
  escrowAddress: string
): Promise<Array<{
  denom: string;
  amount: string;
  origin?: TokenOrigin;
  isNative: boolean;
}>> {
  try {
    const balances = await makeRequest<{
      balances: Array<{ denom: string; amount: string }>;
    }>(chainInfo.apis.rest.map(api => api.address), `/cosmos/bank/v1beta1/balances/${escrowAddress}`);

    const tokens = [];

    for (const balance of balances.balances) {
      const isNative = !balance.denom.startsWith('ibc/');
      let origin: TokenOrigin | undefined;

      if (!isNative) {
        origin = await getTokenOrigin(chainInfo, balance.denom) || undefined;
      }

      tokens.push({
        denom: balance.denom,
        amount: balance.amount,
        origin,
        isNative
      });
    }

    logger.info(`Found ${tokens.length} tokens in escrow address ${escrowAddress}`);
    return tokens;

  } catch (error) {
    logger.error(`Failed to get escrow tokens: ${error}`);
    throw error;
  }
}

export function createIBCDenom(trace: { path: string; base_denom: string }): string {
  const fullPath = `${trace.path}/${trace.base_denom}`;
  return hashIBCDenom('transfer', '', fullPath);
}