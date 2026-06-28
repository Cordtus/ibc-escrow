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

export interface ChainSummary {
  name: string;
  chainId: string;
  bech32Prefix: string;
  endpointCount: number;
  rpcCount: number;
  restCount: number;
}

export interface IbcLink {
  sourceChainName: string;
  sourceChainId: string;
  destinationChainName: string;
  destinationChainId: string;
  channelId: string;
  portId: string;
  counterpartyChannelId: string;
  counterpartyPortId: string;
  clientId: string;
  counterpartyClientId: string;
  connectionId: string;
  counterpartyConnectionId: string;
  ordering: string;
  version: string;
  tags: {
    status?: string;
    preferred?: boolean;
    dex?: string;
    properties?: string;
  };
  sourceFile: string;
}

export interface IbcLinksResponse {
  source: {
    name: string;
    chainId: string;
  };
  destination: {
    name: string;
    chainId: string;
  };
  links: IbcLink[];
}

export interface LookupRouteInput {
  sourceChainName: string;
  destinationChainName: string;
  channelId?: string;
  portId?: string;
}

export interface ResolvedLookupRoute {
  sourceChainName: string;
  destinationChainName: string;
  channelId: string;
  portId: string;
  counterpartyChannelId: string;
  counterpartyPortId: string;
  source: 'registry' | 'manual';
}

interface ChainSummaryResponseItem {
  name?: string;
  chainId?: string;
  bech32Prefix?: string;
  endpointCount?: number;
  rpcCount?: number;
  restCount?: number;
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

export interface SupplyResponse {
  amount?: {
    denom?: string;
    amount?: string;
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

export function buildSupplyByDenomPath(denom: string): string {
  const cleanDenom = denom.trim();
  if (!cleanDenom) {
    throw new Error('Denom is required');
  }

  const query = new URLSearchParams({ denom: cleanDenom });
  return `/cosmos/bank/v1beta1/supply/by_denom?${query.toString()}`;
}

export function normalizeBalances(response: BalancesResponse): BalanceRow[] {
  return (response.balances || [])
    .filter((balance) => balance.denom && balance.amount)
    .map((balance) => ({
      denom: balance.denom as string,
      amount: balance.amount as string,
    }));
}

export function normalizeSupplyAmount(response: SupplyResponse): string {
  return response.amount?.amount || '0';
}

export function getNextBalancePageKey(response: BalancesResponse): string | undefined {
  return response.pagination?.next_key || undefined;
}

export function normalizeChainSummaries(response: unknown): ChainSummary[] {
  if (!Array.isArray(response)) {
    return [];
  }

  return response
    .filter((item): item is ChainSummaryResponseItem => {
      const candidate = item as ChainSummaryResponseItem;
      return Boolean(candidate.name?.trim() && candidate.chainId?.trim());
    })
    .map((item) => ({
      name: item.name?.trim() as string,
      chainId: item.chainId?.trim() as string,
      bech32Prefix: item.bech32Prefix?.trim() || '',
      endpointCount: item.endpointCount || 0,
      rpcCount: item.rpcCount || 0,
      restCount: item.restCount || 0,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function normalizeChainSelection(input: string, chains: ChainSummary[]): string {
  const normalizedInput = input.trim().toLowerCase();
  const chain = chains.find(
    (candidate) =>
      candidate.name.toLowerCase() === normalizedInput ||
      candidate.chainId.toLowerCase() === normalizedInput
  );

  if (!chain) {
    throw new Error(`Unknown chain: ${input}`);
  }

  return chain.name;
}

export function resolveLookupRoute(
  input: LookupRouteInput,
  linksResponse?: IbcLinksResponse
): ResolvedLookupRoute {
  const manualChannelId = input.channelId?.trim() || '';
  const portId = input.portId?.trim() || 'transfer';

  if (manualChannelId) {
    validateChannelId(manualChannelId);
    validatePortId(portId);
    return {
      sourceChainName: input.sourceChainName,
      destinationChainName: input.destinationChainName,
      channelId: manualChannelId,
      portId,
      counterpartyChannelId: '',
      counterpartyPortId: '',
      source: 'manual',
    };
  }

  const link = linksResponse?.links.find(
    (candidate) => candidate.portId === 'transfer' && candidate.counterpartyPortId === 'transfer'
  );
  if (!link) {
    throw new Error(
      `No transfer IBC channel link found for ${input.sourceChainName} to ${input.destinationChainName}`
    );
  }

  return {
    sourceChainName: link.sourceChainName,
    destinationChainName: link.destinationChainName,
    channelId: link.channelId,
    portId: link.portId || 'transfer',
    counterpartyChannelId: link.counterpartyChannelId,
    counterpartyPortId: link.counterpartyPortId,
    source: 'registry',
  };
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

export async function buildIbcDenom(
  portId: string,
  channelId: string,
  baseDenom: string
): Promise<string> {
  validatePortId(portId);
  validateChannelId(channelId);
  const cleanBaseDenom = baseDenom.trim();
  if (!cleanBaseDenom) {
    throw new Error('Base denom is required');
  }

  const cryptoApi = globalThis.crypto?.subtle;
  if (!cryptoApi) {
    throw new Error('Web Crypto API is required to hash IBC denoms');
  }

  const payload = new TextEncoder().encode(
    `${portId.trim()}/${channelId.trim()}/${cleanBaseDenom}`
  );
  const digest = await cryptoApi.digest('SHA-256', payload);
  return `ibc/${bytesToHex(new Uint8Array(digest))}`;
}

export async function buildDestinationIbcDenom(
  route: ResolvedLookupRoute,
  baseDenom: string
): Promise<string> {
  if (!route.counterpartyPortId || !route.counterpartyChannelId) {
    throw new Error('Counterparty channel is required to compare destination supply');
  }

  return buildIbcDenom(route.counterpartyPortId, route.counterpartyChannelId, baseDenom);
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

  const explicitDirectBaseUrl = normalizeBaseUrl(options.directRestBaseUrl || '');
  if (explicitDirectBaseUrl) {
    return {
      source,
      url: `${explicitDirectBaseUrl}/${normalizedPath}`,
    };
  }

  const directBaseUrl = normalizeBaseUrl(DEFAULT_DIRECT_REST_BASE_URL);
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
