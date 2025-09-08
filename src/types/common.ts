export interface ChainInfo {
  chain_name: string;
  chain_id: string;
  pretty_name?: string;
  status?: string;
  network_type?: string;
  website?: string;
  bech32_prefix: string;
  daemon_name?: string;
  node_home?: string;
  key_algos?: string[];
  slip44: number;
  fees: {
    fee_tokens: Array<{
      denom: string;
      fixed_min_gas_price?: number;
      low_gas_price?: number;
      average_gas_price?: number;
      high_gas_price?: number;
    }>;
  };
  staking: {
    staking_tokens: Array<{
      denom: string;
    }>;
  };
  codebase?: {
    git_repo?: string;
    recommended_version?: string;
    compatible_versions?: string[];
    cosmos_sdk_version?: string;
    tendermint_version?: string;
  };
  apis: {
    rpc: Array<{
      address: string;
      provider?: string;
    }>;
    rest: Array<{
      address: string;
      provider?: string;
    }>;
    grpc?: Array<{
      address: string;
      provider?: string;
    }>;
  };
}

export interface IBCData {
  $schema: string;
  chain_1: {
    chain_name: string;
    client_id: string;
    connection_id: string;
  };
  chain_2: {
    chain_name: string;
    client_id: string;
    connection_id: string;
  };
  channels: Array<{
    chain_1: {
      channel_id: string;
      port_id: string;
    };
    chain_2: {
      channel_id: string;
      port_id: string;
    };
    ordering: string;
    version: string;
    description?: string;
    tags?: {
      status?: string;
      preferred?: boolean;
      dex?: string;
      properties?: string;
    };
  }>;
}

export interface AuditResult {
  chainName: string;
  escrowAddress: string;
  nativeToken: string;
  escrowBalance: string;
  expectedBalance?: string;
  discrepancy?: string;
  timestamp: number;
}

export interface AuditOptions {
  type: 'quick' | 'comprehensive' | 'manual';
  primaryChain: string;
  secondaryChain: string;
  channelId?: string;
  reverse?: boolean;
  protocol?: 'grpc' | 'rest';
}

export interface CacheEntry<T = unknown> {
  key: string;
  data: T;
  timestamp: number;
}

export interface ChainVersionInfo {
  chainId: string;
  appVersion: string;
  lastChecked: number;
  descriptorsUpdated: number;
}