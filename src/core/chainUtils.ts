import axios, { AxiosResponse } from 'axios';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from './logger.js';
import type { ChainInfo } from '../types/common.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface RequestConfig {
  retries: number;
  delay: number;
}

interface AppConfig {
  api: RequestConfig;
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
      api: { retries: 3, delay: 250 },
      paths: { dataDir: 'data' }
    };
  }
};

const config = await loadConfig();

export async function makeRequest<T = unknown>(
  endpoints: string[],
  requestPath: string,
  method: 'get' | 'post' = 'get',
  payload: unknown = null
): Promise<T> {
  logger.info(`Making API request to path: ${requestPath}`);
  const maxRetries = config.api.retries;
  const delay = config.api.delay;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    for (const endpoint of endpoints) {
      const url = `${endpoint}${requestPath}`;
      logger.info(`Attempting request to: ${url} (attempt ${attempt + 1}/${maxRetries})`);

      try {
        const startTime = Date.now();
        const response: AxiosResponse<T> = await axios({
          method,
          url,
          data: payload,
          timeout: 30000, // 30 second timeout
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'ibc-escrow-audit/1.0.0'
          }
        });

        const duration = Date.now() - startTime;
        logger.performance('api_request', duration, { url, method, status: response.status });
        logger.info(`Successful response from ${url} (${response.status})`);

        // Enhanced response handling for different chain types
        if (endpoint.includes('sei')) {
          return response.data;
        }

        // For other chains, check for '.result' property (Cosmos REST API pattern)
        const data = response.data as any;
        return data.result !== undefined ? data.result : response.data;

      } catch (error) {
        const axiosError = error as any;
        const status = axiosError.response?.status;
        const errorMessage = axiosError.response?.data?.message || axiosError.message;

        logger.warn(`Request failed for ${url}: ${status} - ${errorMessage}`);

        // Don't retry on client errors (4xx), except 429 (rate limit)
        if (status >= 400 && status < 500 && status !== 429) {
          throw new Error(`Client error ${status}: ${errorMessage}`);
        }

        // Add exponential backoff delay between attempts
        if (attempt < maxRetries - 1) {
          const backoffDelay = delay * Math.pow(2, attempt);
          logger.debug(`Waiting ${backoffDelay}ms before next attempt`);
          await new Promise(resolve => setTimeout(resolve, backoffDelay));
        }
      }
    }
  }

  throw new Error(`All requests failed after ${maxRetries} attempts for path: ${requestPath}`);
}

export async function loadChainInfo(chainName: string): Promise<ChainInfo> {
  const dataDir = path.join(process.cwd(), config.paths.dataDir);
  const chainFile = path.join(dataDir, `${chainName}.json`);

  try {
    logger.debug(`Loading chain info for ${chainName} from ${chainFile}`);
    const chainData = await fs.readFile(chainFile, 'utf8');
    const chainInfo: ChainInfo = JSON.parse(chainData);

    // Validate required fields
    if (!chainInfo.chain_name || !chainInfo.apis) {
      throw new Error(`Invalid chain info structure for ${chainName}`);
    }

    // Ensure we have at least one API endpoint
    if (!chainInfo.apis.rest?.length && !chainInfo.apis.grpc?.length) {
      throw new Error(`No REST or gRPC endpoints found for ${chainName}`);
    }

    logger.debug(`Successfully loaded chain info for ${chainName}`);
    return chainInfo;

  } catch (error) {
    logger.error(`Failed to load chain info for ${chainName}: ${error}`);
    throw new Error(`Chain info not found for ${chainName}: ${error}`);
  }
}

export async function getAvailableChains(): Promise<string[]> {
  const dataDir = path.join(process.cwd(), config.paths.dataDir);

  try {
    const files = await fs.readdir(dataDir);
    const chainFiles = files
      .filter(file => file.endsWith('.json') && file !== 'chain.schema.json')
      .map(file => file.replace('.json', ''))
      .sort();

    logger.debug(`Found ${chainFiles.length} available chains`);
    return chainFiles;

  } catch (error) {
    logger.error(`Failed to get available chains: ${error}`);
    throw new Error(`Failed to read chain directory: ${error}`);
  }
}

export async function validateChainEndpoints(chainInfo: ChainInfo): Promise<{
  restEndpoints: string[];
  grpcEndpoints: string[];
  rpcEndpoints: string[];
  healthyEndpoints: {
    rest: string[];
    grpc: string[];
    rpc: string[];
  };
}> {
  const restEndpoints = chainInfo.apis.rest?.map(api => api.address) || [];
  const grpcEndpoints = chainInfo.apis.grpc?.map(api => api.address) || [];
  const rpcEndpoints = chainInfo.apis.rpc?.map(api => api.address) || [];

  const healthyEndpoints = {
    rest: [],
    grpc: [],
    rpc: []
  } as { rest: string[]; grpc: string[]; rpc: string[] };

  // Test REST endpoints
  for (const endpoint of restEndpoints) {
    try {
      await makeRequest([endpoint], '/cosmos/base/tendermint/v1beta1/node_info');
      healthyEndpoints.rest.push(endpoint);
      logger.debug(`REST endpoint ${endpoint} is healthy`);
    } catch (error) {
      logger.warn(`REST endpoint ${endpoint} is unhealthy: ${error}`);
    }
  }

  // Test RPC endpoints
  for (const endpoint of rpcEndpoints) {
    try {
      await axios.get(`${endpoint}/status`, { timeout: 5000 });
      healthyEndpoints.rpc.push(endpoint);
      logger.debug(`RPC endpoint ${endpoint} is healthy`);
    } catch (error) {
      logger.warn(`RPC endpoint ${endpoint} is unhealthy: ${error}`);
    }
  }

  // Note: gRPC endpoint validation would require actual gRPC client
  // For now, we'll assume they're healthy if they're configured
  healthyEndpoints.grpc = grpcEndpoints;

  return {
    restEndpoints,
    grpcEndpoints,
    rpcEndpoints,
    healthyEndpoints
  };
}

export function getEscrowAddress(
  portId: string,
  channelId: string,
  bech32Prefix: string = 'cosmos'
): string {
  // This is a simplified implementation
  // In practice, you'd use the actual IBC escrow address derivation logic
  const escrowIdentifier = `${portId}/${channelId}`;
  // This should use the actual address derivation from the IBC module
  // For now, returning a placeholder that follows the expected pattern
  return `${bech32Prefix}1escrow${channelId}placeholder`;
}

// Enhanced balance fetching with retry logic and error handling
export async function fetchBalance(
  chainInfo: ChainInfo,
  address: string,
  denom?: string
): Promise<{ denom: string; amount: string }[]> {
  const restEndpoints = chainInfo.apis.rest.map(api => api.address);
  const path = `/cosmos/bank/v1beta1/balances/${address}`;

  try {
    const response = await makeRequest<{
      balances: Array<{ denom: string; amount: string }>;
      pagination?: unknown;
    }>(restEndpoints, path);

    let balances = response.balances || [];

    // Filter by specific denom if requested
    if (denom) {
      balances = balances.filter(balance => balance.denom === denom);
    }

    logger.debug(`Fetched ${balances.length} balance(s) for address ${address}`);
    return balances;

  } catch (error) {
    logger.error(`Failed to fetch balance for ${address}: ${error}`);
    throw error;
  }
}

// Enhanced supply fetching with error handling
export async function fetchSupply(
  chainInfo: ChainInfo,
  denom: string
): Promise<{ denom: string; amount: string }> {
  const restEndpoints = chainInfo.apis.rest.map(api => api.address);
  const path = `/cosmos/bank/v1beta1/supply/by_denom?denom=${encodeURIComponent(denom)}`;

  try {
    const response = await makeRequest<{
      amount: { denom: string; amount: string };
    }>(restEndpoints, path);

    if (!response.amount) {
      throw new Error(`No supply data returned for denom ${denom}`);
    }

    logger.debug(`Fetched supply for denom ${denom}: ${response.amount.amount}`);
    return response.amount;

  } catch (error) {
    logger.error(`Failed to fetch supply for ${denom}: ${error}`);
    throw error;
  }
}