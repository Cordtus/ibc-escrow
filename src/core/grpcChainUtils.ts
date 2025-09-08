import { promises as fs } from 'fs';
import path from 'path';
import logger from './logger.js';
import { CosmosGrpcClient, createCosmosGrpcClient } from '../grpc/cosmosGrpcClient.js';
import { loadChainInfo } from './chainUtils.js';
import type { ChainInfo } from '../types/common.js';

interface GrpcRequestConfig {
  retries: number;
  delay: number;
  timeout: number;
}

interface AppConfig {
  api: GrpcRequestConfig;
  paths: {
    dataDir: string;
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
      api: { retries: 3, delay: 250, timeout: 30000 },
      paths: { dataDir: 'data' }
    };
  }
};

const config = await loadConfig();

// Cache for gRPC clients
const grpcClientCache = new Map<string, CosmosGrpcClient>();

export async function getGrpcClient(chainName: string): Promise<CosmosGrpcClient> {
  const existing = grpcClientCache.get(chainName);
  if (existing) {
    return existing;
  }

  const chainInfo = await loadChainInfo(chainName);
  const client = await createCosmosGrpcClient(chainInfo, {
    timeout: config.api.timeout,
    maxRetries: config.api.retries,
    credentials: 'insecure'
  });

  grpcClientCache.set(chainName, client);
  return client;
}

// Enhanced balance fetching with gRPC
export async function fetchBalanceGrpc(
  chainName: string,
  address: string,
  denom?: string
): Promise<{ denom: string; amount: string }[]> {
  const startTime = Date.now();
  logger.info(`Fetching balance via gRPC for ${address} on ${chainName}`);

  try {
    const client = await getGrpcClient(chainName);
    
    let balances: Array<{ denom: string; amount: string }>;
    
    if (denom) {
      // Query specific denom
      const balance = await client.queryBalance(address, denom);
      balances = balance ? [balance] : [];
    } else {
      // Query all balances
      balances = await client.queryAllBalances(address);
    }

    const duration = Date.now() - startTime;
    logger.performance('grpc_balance_query', duration, { 
      chainName, 
      address, 
      denom, 
      balanceCount: balances.length 
    });

    logger.debug(`Fetched ${balances.length} balance(s) for address ${address}`);
    return balances;

  } catch (error) {
    logger.error(`Failed to fetch balance via gRPC for ${address} on ${chainName}: ${error}`);
    throw error;
  }
}

// Enhanced supply fetching with gRPC
export async function fetchSupplyGrpc(
  chainName: string,
  denom: string
): Promise<{ denom: string; amount: string }> {
  const startTime = Date.now();
  logger.info(`Fetching supply via gRPC for ${denom} on ${chainName}`);

  try {
    const client = await getGrpcClient(chainName);
    const supply = await client.querySupply(denom);

    if (!supply) {
      throw new Error(`No supply data returned for denom ${denom}`);
    }

    const duration = Date.now() - startTime;
    logger.performance('grpc_supply_query', duration, { chainName, denom });

    logger.debug(`Fetched supply for denom ${denom}: ${supply.amount}`);
    return supply;

  } catch (error) {
    logger.error(`Failed to fetch supply via gRPC for ${denom} on ${chainName}: ${error}`);
    throw error;
  }
}

// Enhanced IBC denom trace fetching with gRPC
export async function fetchDenomTraceGrpc(
  chainName: string,
  ibcDenom: string
): Promise<{
  denom_trace: {
    path: string;
    base_denom: string;
  };
}> {
  const startTime = Date.now();
  logger.info(`Fetching denom trace via gRPC for ${ibcDenom} on ${chainName}`);

  try {
    const client = await getGrpcClient(chainName);
    
    // Extract hash from IBC denom (ibc/HASH)
    if (!ibcDenom.startsWith('ibc/')) {
      throw new Error(`Invalid IBC denom format: ${ibcDenom}`);
    }
    
    const hash = ibcDenom.split('/')[1];
    const trace = await client.queryDenomTrace(hash);

    const duration = Date.now() - startTime;
    logger.performance('grpc_denom_trace_query', duration, { chainName, ibcDenom });

    logger.debug(`Fetched denom trace for ${ibcDenom}: ${trace.denom_trace.path}/${trace.denom_trace.base_denom}`);
    return trace;

  } catch (error) {
    logger.error(`Failed to fetch denom trace via gRPC for ${ibcDenom} on ${chainName}: ${error}`);
    throw error;
  }
}

// Enhanced IBC channel info fetching with gRPC
export async function fetchChannelInfoGrpc(
  chainName: string,
  portId: string,
  channelId: string
): Promise<any> {
  const startTime = Date.now();
  logger.info(`Fetching channel info via gRPC for ${portId}/${channelId} on ${chainName}`);

  try {
    const client = await getGrpcClient(chainName);
    const channelInfo = await client.queryChannel(portId, channelId);

    const duration = Date.now() - startTime;
    logger.performance('grpc_channel_query', duration, { chainName, portId, channelId });

    logger.debug(`Fetched channel info for ${portId}/${channelId}`);
    return channelInfo;

  } catch (error) {
    logger.error(`Failed to fetch channel info via gRPC for ${portId}/${channelId} on ${chainName}: ${error}`);
    throw error;
  }
}

// Enhanced connection info fetching with gRPC
export async function fetchConnectionInfoGrpc(
  chainName: string,
  connectionId: string
): Promise<any> {
  const startTime = Date.now();
  logger.info(`Fetching connection info via gRPC for ${connectionId} on ${chainName}`);

  try {
    const client = await getGrpcClient(chainName);
    const connectionInfo = await client.queryConnection(connectionId);

    const duration = Date.now() - startTime;
    logger.performance('grpc_connection_query', duration, { chainName, connectionId });

    logger.debug(`Fetched connection info for ${connectionId}`);
    return connectionInfo;

  } catch (error) {
    logger.error(`Failed to fetch connection info via gRPC for ${connectionId} on ${chainName}: ${error}`);
    throw error;
  }
}

// Enhanced node info fetching with gRPC
export async function fetchNodeInfoGrpc(chainName: string): Promise<any> {
  const startTime = Date.now();
  logger.info(`Fetching node info via gRPC for ${chainName}`);

  try {
    const client = await getGrpcClient(chainName);
    const nodeInfo = await client.queryNodeInfo();

    const duration = Date.now() - startTime;
    logger.performance('grpc_node_info_query', duration, { chainName });

    logger.debug(`Fetched node info for ${chainName}`);
    return nodeInfo;

  } catch (error) {
    logger.error(`Failed to fetch node info via gRPC for ${chainName}: ${error}`);
    throw error;
  }
}

// Validate gRPC endpoints for a chain
export async function validateGrpcEndpoints(chainName: string): Promise<{
  healthyEndpoints: string[];
  unhealthyEndpoints: string[];
}> {
  logger.info(`Validating gRPC endpoints for ${chainName}`);
  
  try {
    const chainInfo = await loadChainInfo(chainName);
    const grpcEndpoints = chainInfo.apis.grpc?.map(api => api.address) || [];
    
    const healthyEndpoints: string[] = [];
    const unhealthyEndpoints: string[] = [];
    
    for (const endpoint of grpcEndpoints) {
      try {
        const client = await createCosmosGrpcClient(chainInfo, {
          timeout: 5000 // Short timeout for health checks
        });
        
        await client.queryNodeInfo();
        healthyEndpoints.push(endpoint);
        logger.debug(`gRPC endpoint ${endpoint} is healthy`);
        
        await client.close();
        
      } catch (error) {
        unhealthyEndpoints.push(endpoint);
        logger.warn(`gRPC endpoint ${endpoint} is unhealthy: ${error}`);
      }
    }
    
    return { healthyEndpoints, unhealthyEndpoints };
    
  } catch (error) {
    logger.error(`Failed to validate gRPC endpoints for ${chainName}: ${error}`);
    throw error;
  }
}

// Enhanced recursive unwrapping using gRPC
export async function recursiveUnwrapTokenGrpc(
  chainName: string,
  denom: string,
  visitedChains: Set<string> = new Set(),
  currentPath: Array<{ chain: string; channelId: string; portId: string }> = []
): Promise<{
  baseDenom: string;
  originChain: string;
  path: Array<{ chain: string; channelId: string; portId: string }>;
  isComplete: boolean;
}> {
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

  try {
    // Fetch denom trace using gRPC
    const trace = await fetchDenomTraceGrpc(chainName, denom);
    
    if (!trace?.denom_trace) {
      logger.warn(`No denom trace found for ${denom} on ${chainName}`);
      return {
        baseDenom: denom,
        originChain: chainName,
        path: currentPath,
        isComplete: false
      };
    }

    const pathParts = trace.denom_trace.path.split('/');
    
    if (pathParts.length < 2) {
      logger.warn(`Invalid trace path: ${trace.denom_trace.path}`);
      return {
        baseDenom: trace.denom_trace.base_denom,
        originChain: chainName,
        path: currentPath,
        isComplete: false
      };
    }

    const portId = pathParts[0];
    const channelId = pathParts[1];
    
    logger.debug(`Tracing ${denom} on ${chainName}: ${portId}/${channelId}/${trace.denom_trace.base_denom}`);

    // Add current hop to path
    const newPath = [...currentPath, { chain: chainName, channelId, portId }];
    
    // Find the counterparty chain for this channel using gRPC
    const counterpartyChain = await findCounterpartyChainGrpc(chainName, channelId);
    
    if (!counterpartyChain) {
      logger.warn(`Could not find counterparty chain for ${chainName}/${channelId}`);
      return {
        baseDenom: trace.denom_trace.base_denom,
        originChain: chainName,
        path: newPath,
        isComplete: false
      };
    }

    // Continue unwrapping on the counterparty chain
    return await recursiveUnwrapTokenGrpc(
      counterpartyChain,
      trace.denom_trace.base_denom,
      visitedChains,
      newPath
    );

  } catch (error) {
    logger.error(`Error fetching denom trace via gRPC for ${denom} on ${chainName}: ${error}`);
    return {
      baseDenom: denom,
      originChain: chainName,
      path: currentPath,
      isComplete: false
    };
  }
}

// Enhanced counterparty chain finding using gRPC
async function findCounterpartyChainGrpc(chainName: string, channelId: string): Promise<string | null> {
  try {
    // Query channel information to get connection ID
    const channelInfo = await fetchChannelInfoGrpc(chainName, 'transfer', channelId);
    
    if (!channelInfo?.channel?.connection_hops?.length) {
      logger.warn(`No connection hops found for channel ${channelId} on ${chainName}`);
      return null;
    }
    
    const connectionId = channelInfo.channel.connection_hops[0];
    
    // Query connection information to get counterparty client ID
    const connectionInfo = await fetchConnectionInfoGrpc(chainName, connectionId);
    
    if (!connectionInfo?.connection?.counterparty?.client_id) {
      logger.warn(`No counterparty client ID found for connection ${connectionId} on ${chainName}`);
      return null;
    }
    
    const counterpartyClientId = connectionInfo.connection.counterparty.client_id;
    
    // Query client state to get counterparty chain ID
    const clientInfo = await fetchClientStateGrpc(chainName, counterpartyClientId);
    
    if (!clientInfo?.client_state?.chain_id) {
      logger.warn(`No chain ID found for client ${counterpartyClientId} on ${chainName}`);
      return null;
    }
    
    return clientInfo.client_state.chain_id;
    
  } catch (error) {
    logger.error(`Error finding counterparty chain via gRPC for ${chainName}/${channelId}: ${error}`);
    return null;
  }
}

async function fetchClientStateGrpc(chainName: string, clientId: string): Promise<any> {
  const client = await getGrpcClient(chainName);
  return await client.queryClientState(clientId);
}

// Cleanup function to close all gRPC clients
export async function closeAllGrpcClients(): Promise<void> {
  logger.info('Closing all gRPC clients');
  
  for (const [chainName, client] of grpcClientCache.entries()) {
    try {
      await client.close();
      logger.debug(`Closed gRPC client for ${chainName}`);
    } catch (error) {
      logger.warn(`Error closing gRPC client for ${chainName}: ${error}`);
    }
  }
  
  grpcClientCache.clear();
}