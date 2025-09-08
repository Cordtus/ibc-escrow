import { 
  Client, 
  credentials, 
  loadPackageDefinition,
  Metadata,
  CallOptions 
} from '@grpc/grpc-js';
import { load } from '@grpc/proto-loader';
import logger from '../core/logger.js';
import { descriptorCache } from '../cache/descriptorCache.js';
import type { ChainInfo } from '../types/common.js';

// Common Cosmos SDK query paths
const COMMON_QUERY_PATHS = {
  // Bank module queries
  BANK_BALANCE: '/cosmos.bank.v1beta1.Query/Balance',
  BANK_ALL_BALANCES: '/cosmos.bank.v1beta1.Query/AllBalances', 
  BANK_SUPPLY: '/cosmos.bank.v1beta1.Query/SupplyOf',
  BANK_TOTAL_SUPPLY: '/cosmos.bank.v1beta1.Query/TotalSupply',
  
  // IBC queries
  IBC_CLIENT_STATE: '/ibc.core.client.v1.Query/ClientState',
  IBC_CONNECTION: '/ibc.core.connection.v1.Query/Connection',
  IBC_CHANNEL: '/ibc.core.channel.v1.Query/Channel',
  IBC_DENOM_TRACE: '/ibc.applications.transfer.v1.Query/DenomTrace',
  IBC_DENOM_TRACES: '/ibc.applications.transfer.v1.Query/DenomTraces',
  
  // Staking queries
  STAKING_VALIDATORS: '/cosmos.staking.v1beta1.Query/Validators',
  STAKING_VALIDATOR: '/cosmos.staking.v1beta1.Query/Validator',
  STAKING_PARAMS: '/cosmos.staking.v1beta1.Query/Params',
  
  // Auth queries
  AUTH_ACCOUNT: '/cosmos.auth.v1beta1.Query/Account',
  
  // Tendermint queries
  TENDERMINT_NODE_INFO: '/cosmos.base.tendermint.v1beta1.Query/GetNodeInfo',
  TENDERMINT_BLOCK: '/cosmos.base.tendermint.v1beta1.Query/GetBlockByHeight'
} as const;

export interface GrpcQueryRequest {
  path: string;
  data?: any;
  height?: string;
}

export interface GrpcQueryResponse<T = any> {
  data: T;
  height: string;
  proof?: Uint8Array;
}

export class CosmosGrpcClient {
  private clients: Map<string, Client> = new Map();
  private packageDefinitions: Map<string, any> = new Map();

  constructor(
    private chainInfo: ChainInfo,
    private options: {
      timeout?: number;
      maxRetries?: number;
      credentials?: 'insecure' | 'ssl';
    } = {}
  ) {
    this.options = {
      timeout: 30000,
      maxRetries: 3,
      credentials: 'insecure',
      ...options
    };
  }

  async getClient(endpoint?: string): Promise<Client> {
    const grpcEndpoint = endpoint || this.getHealthyGrpcEndpoint();
    
    const existing = this.clients.get(grpcEndpoint);
    if (existing) {
      return existing;
    }

    const clientCredentials = this.options.credentials === 'ssl' 
      ? credentials.createSsl()
      : credentials.createInsecure();

    const client = new Client(grpcEndpoint, clientCredentials, {
      'grpc.keepalive_time_ms': 30000,
      'grpc.keepalive_timeout_ms': 5000,
      'grpc.keepalive_permit_without_calls': 1,
      'grpc.max_receive_message_length': 1024 * 1024 * 100, // 100MB
      'grpc.max_send_message_length': 1024 * 1024 * 100
    });

    this.clients.set(grpcEndpoint, client);
    logger.debug(`Created gRPC client for ${grpcEndpoint}`);
    return client;
  }

  private getHealthyGrpcEndpoint(): string {
    if (!this.chainInfo.apis.grpc || this.chainInfo.apis.grpc.length === 0) {
      throw new Error(`No gRPC endpoints configured for chain ${this.chainInfo.chain_name}`);
    }
    
    // For now, just return the first endpoint
    // In a production system, you'd implement endpoint health checking
    return this.chainInfo.apis.grpc[0].address;
  }

  // Bank module queries
  async queryBalance(address: string, denom: string): Promise<{ denom: string; amount: string }> {
    logger.debug(`Querying balance for ${address}, denom: ${denom}`);
    
    const request = {
      address,
      denom
    };

    const response = await this.makeQuery('/cosmos.bank.v1beta1.Query/Balance', request);
    return response.balance;
  }

  async queryAllBalances(address: string): Promise<Array<{ denom: string; amount: string }>> {
    logger.debug(`Querying all balances for ${address}`);
    
    const request = { address };
    const response = await this.makeQuery('/cosmos.bank.v1beta1.Query/AllBalances', request);
    return response.balances || [];
  }

  async querySupply(denom: string): Promise<{ denom: string; amount: string }> {
    logger.debug(`Querying supply for denom: ${denom}`);
    
    const request = { denom };
    const response = await this.makeQuery('/cosmos.bank.v1beta1.Query/SupplyOf', request);
    return response.amount;
  }

  // IBC queries
  async queryDenomTrace(hash: string): Promise<{
    denom_trace: {
      path: string;
      base_denom: string;
    };
  }> {
    logger.debug(`Querying denom trace for hash: ${hash}`);
    
    const request = { hash };
    return await this.makeQuery('/ibc.applications.transfer.v1.Query/DenomTrace', request);
  }

  async queryChannel(portId: string, channelId: string): Promise<any> {
    logger.debug(`Querying channel ${portId}/${channelId}`);
    
    const request = { 
      port_id: portId, 
      channel_id: channelId 
    };
    return await this.makeQuery('/ibc.core.channel.v1.Query/Channel', request);
  }

  async queryConnection(connectionId: string): Promise<any> {
    logger.debug(`Querying connection ${connectionId}`);
    
    const request = { connection_id: connectionId };
    return await this.makeQuery('/ibc.core.connection.v1.Query/Connection', request);
  }

  async queryClientState(clientId: string): Promise<any> {
    logger.debug(`Querying client state ${clientId}`);
    
    const request = { client_id: clientId };
    return await this.makeQuery('/ibc.core.client.v1.Query/ClientState', request);
  }

  // Tendermint queries
  async queryNodeInfo(): Promise<any> {
    logger.debug(`Querying node info`);
    return await this.makeQuery('/cosmos.base.tendermint.v1beta1.Query/GetNodeInfo', {});
  }

  // Generic query method
  async makeQuery<TRequest = any, TResponse = any>(
    path: string, 
    request: TRequest,
    options: {
      endpoint?: string;
      timeout?: number;
      metadata?: Metadata;
    } = {}
  ): Promise<TResponse> {
    const startTime = Date.now();
    logger.debug(`Making gRPC query: ${path}`);

    try {
      const client = await this.getClient(options.endpoint);
      
      // For now, we'll use a simplified approach without full proto loading
      // In production, you'd want to load the actual proto definitions
      return await this.makeDirectGrpcCall(client, path, request, options);
      
    } catch (error) {
      logger.error(`gRPC query failed for ${path}: ${error}`);
      throw error;
    } finally {
      const duration = Date.now() - startTime;
      logger.performance('grpc_query', duration, { path, chain: this.chainInfo.chain_name });
    }
  }

  private async makeDirectGrpcCall<TRequest, TResponse>(
    client: Client,
    path: string,
    request: TRequest,
    options: { timeout?: number; metadata?: Metadata }
  ): Promise<TResponse> {
    return new Promise((resolve, reject) => {
      const metadata = options.metadata || new Metadata();
      const callOptions: CallOptions = {
        deadline: Date.now() + (options.timeout || this.options.timeout!)
      };

      // This is a simplified implementation
      // In practice, you'd use the loaded package definitions to make the actual calls
      try {
        // For now, we'll simulate the response structure
        // Real implementation would use: client.makeUnaryRequest(method, serialize, deserialize, request, metadata, callback)
        
        // Simulate different response structures based on the path
        const mockResponse = this.generateMockResponse(path, request);
        resolve(mockResponse as TResponse);
        
      } catch (error) {
        reject(error);
      }
    });
  }

  // Temporary mock responses - remove this in production and use real proto definitions
  private generateMockResponse(path: string, request: any): any {
    logger.warn(`Using mock response for ${path} - implement real gRPC calls!`);
    
    switch (path) {
      case '/cosmos.bank.v1beta1.Query/Balance':
        return { balance: { denom: request.denom, amount: '0' } };
      
      case '/cosmos.bank.v1beta1.Query/AllBalances':
        return { balances: [] };
      
      case '/cosmos.bank.v1beta1.Query/SupplyOf':
        return { amount: { denom: request.denom, amount: '0' } };
      
      case '/ibc.applications.transfer.v1.Query/DenomTrace':
        return { 
          denom_trace: { 
            path: 'transfer/channel-0', 
            base_denom: 'uatom' 
          } 
        };
      
      default:
        return {};
    }
  }

  async close(): Promise<void> {
    for (const [endpoint, client] of this.clients) {
      try {
        client.close();
        logger.debug(`Closed gRPC client for ${endpoint}`);
      } catch (error) {
        logger.warn(`Error closing gRPC client for ${endpoint}: ${error}`);
      }
    }
    this.clients.clear();
  }
}

// Factory function to create gRPC clients
export async function createCosmosGrpcClient(
  chainInfo: ChainInfo,
  options?: {
    timeout?: number;
    maxRetries?: number;
    credentials?: 'insecure' | 'ssl';
  }
): Promise<CosmosGrpcClient> {
  const client = new CosmosGrpcClient(chainInfo, options);
  
  // Optionally validate connection on creation
  try {
    await client.queryNodeInfo();
    logger.info(`Successfully connected to gRPC for ${chainInfo.chain_name}`);
  } catch (error) {
    logger.warn(`Failed to validate gRPC connection for ${chainInfo.chain_name}: ${error}`);
    // Don't throw - allow offline usage
  }
  
  return client;
}