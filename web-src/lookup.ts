export type EndpointMode = 'auto' | 'lazy-lb' | 'direct-rest';
export type RequestSource = 'lazy-lb' | 'direct-rest';

export interface LookupUrlOptions {
  chainName: string;
  endpointMode: EndpointMode;
  lazyLbBaseUrl?: string;
  directRestBaseUrl?: string;
}

export interface ResolvedLookupUrl {
  url: string;
  source: RequestSource;
}

export interface ChannelDetails {
  counterpartyChannelId: string;
  counterpartyPortId: string;
  connectionId: string;
  clientId: string;
  counterpartyClientId: string;
  counterpartyConnectionId: string;
  counterpartyChainId: string;
  ordering: string;
  version: string;
}

export interface BalanceRow {
  denom: string;
  amount: string;
}

export interface BalancesResponse {
  balances?: Array<{
    denom?: string;
    amount?: string;
  }>;
  pagination?: {
    next_key?: string | null;
    total?: string;
  };
}

export interface ChannelResponse {
  channel?: {
    counterparty?: {
      channel_id?: string;
      port_id?: string;
    };
    connection_hops?: string[];
    ordering?: string;
    version?: string;
  };
}

export interface ConnectionResponse {
  connection?: {
    client_id?: string;
    counterparty?: {
      client_id?: string;
      connection_id?: string;
    };
  };
}

export interface ClientStateResponse {
  client_state?: {
    chain_id?: string;
  };
  identified_client_state?: {
    client_state?: {
      chain_id?: string;
    };
  };
}

const DEFAULT_DIRECT_REST_BASE_URL = 'https://rest.cosmos.directory';

export function validateChannelId(channelId: string): void {
  if (!/^channel-\d+$/.test(channelId.trim())) {
    throw new Error(`Invalid channel ID: ${channelId}`);
  }
}

export function validatePortId(portId: string): void {
  if (!/^[a-zA-Z0-9._/-]+$/.test(portId.trim())) {
    throw new Error(`Invalid port ID: ${portId}`);
  }
}

export function buildEscrowAddressPath(channelId: string, portId: string = 'transfer'): string {
  validateChannelId(channelId);
  validatePortId(portId);
  return `/ibc/apps/transfer/v1/channels/${encodeURIComponent(
    channelId.trim()
  )}/ports/${encodeURIComponent(portId.trim())}/escrow_address`;
}

export function buildChannelPath(channelId: string, portId: string = 'transfer'): string {
  validateChannelId(channelId);
  validatePortId(portId);
  return `/ibc/core/channel/v1/channels/${encodeURIComponent(
    channelId.trim()
  )}/ports/${encodeURIComponent(portId.trim())}`;
}

export function buildConnectionPath(connectionId: string): string {
  if (!/^connection-\d+$/.test(connectionId.trim())) {
    throw new Error(`Invalid connection ID: ${connectionId}`);
  }

  return `/ibc/core/connection/v1/connections/${encodeURIComponent(connectionId.trim())}`;
}

export function buildClientStatePath(clientId: string): string {
  if (!/^[a-zA-Z0-9._-]+-\d+$/.test(clientId.trim())) {
    throw new Error(`Invalid client ID: ${clientId}`);
  }

  return `/ibc/core/client/v1/client_states/${encodeURIComponent(clientId.trim())}`;
}

export function buildBalancesPath(address: string, paginationKey?: string): string {
  const cleanAddress = address.trim();
  if (!/^[a-z0-9]+1[ac-hj-np-z02-9]+$/i.test(cleanAddress)) {
    throw new Error(`Invalid account address: ${address}`);
  }

  const path = `/cosmos/bank/v1beta1/balances/${encodeURIComponent(cleanAddress)}`;
  if (!paginationKey) {
    return path;
  }

  const query = new URLSearchParams({ 'pagination.key': paginationKey });
  return `${path}?${query.toString()}`;
}

export function normalizeBalances(response: BalancesResponse): BalanceRow[] {
  return (response.balances || [])
    .filter((balance) => balance.denom && balance.amount)
    .map((balance) => ({
      denom: balance.denom as string,
      amount: balance.amount as string,
    }));
}

export function getNextBalancePageKey(response: BalancesResponse): string | undefined {
  return response.pagination?.next_key || undefined;
}

export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export function resolveRequestSource(options: LookupUrlOptions): RequestSource {
  if (options.endpointMode === 'direct-rest') {
    return 'direct-rest';
  }

  if (options.endpointMode === 'lazy-lb') {
    return 'lazy-lb';
  }

  return options.lazyLbBaseUrl?.trim() ? 'lazy-lb' : 'direct-rest';
}

export function buildLookupUrl(options: LookupUrlOptions, requestPath: string): ResolvedLookupUrl {
  const chainName = options.chainName.trim();
  if (!chainName) {
    throw new Error('Chain name is required');
  }

  const normalizedPath = requestPath.replace(/^\/+/, '');
  const source = resolveRequestSource(options);

  if (source === 'lazy-lb') {
    const baseUrl = normalizeBaseUrl(options.lazyLbBaseUrl || '');
    if (!baseUrl) {
      throw new Error('Lazy-LB base URL is required for Lazy-LB mode');
    }

    return {
      source,
      url: `${baseUrl}/lb/${encodeURIComponent(chainName)}/${normalizedPath}`,
    };
  }

  const directBaseUrl = normalizeBaseUrl(options.directRestBaseUrl || DEFAULT_DIRECT_REST_BASE_URL);
  return {
    source,
    url: `${directBaseUrl}/${encodeURIComponent(chainName)}/${normalizedPath}`,
  };
}

export function extractConnectionId(channelData: ChannelResponse): string {
  const connectionId = channelData.channel?.connection_hops?.[0];
  if (!connectionId) {
    throw new Error('Channel response did not include a connection hop');
  }

  return connectionId;
}

export function extractClientId(connectionData: ConnectionResponse): string {
  const clientId = connectionData.connection?.client_id;
  if (!clientId) {
    throw new Error('Connection response did not include a client ID');
  }

  return clientId;
}

export function extractCounterpartyChainId(clientStateData: ClientStateResponse): string {
  return (
    clientStateData.client_state?.chain_id ||
    clientStateData.identified_client_state?.client_state?.chain_id ||
    ''
  );
}

export function buildChannelDetails(
  channelData: ChannelResponse,
  connectionData: ConnectionResponse,
  clientStateData: ClientStateResponse
): ChannelDetails {
  const channel = channelData.channel;
  const connection = connectionData.connection;

  if (!channel || !connection) {
    throw new Error('Channel detail responses were incomplete');
  }

  return {
    counterpartyChannelId: channel.counterparty?.channel_id || '',
    counterpartyPortId: channel.counterparty?.port_id || '',
    connectionId: extractConnectionId(channelData),
    clientId: extractClientId(connectionData),
    counterpartyClientId: connection.counterparty?.client_id || '',
    counterpartyConnectionId: connection.counterparty?.connection_id || '',
    counterpartyChainId: extractCounterpartyChainId(clientStateData),
    ordering: channel.ordering || '',
    version: channel.version || '',
  };
}
