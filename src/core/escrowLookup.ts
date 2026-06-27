import type { ChainInfo } from '../types/common.js';

export interface EscrowLookupResult {
  chainName: string;
  chainId: string;
  channelId: string;
  portId: string;
  escrowAddress: string;
  restEndpoints: string[];
}

export interface ChannelInfoLookupResult {
  chainName: string;
  chainId: string;
  channelId: string;
  portId: string;
  counterpartyChannelId: string;
  counterpartyPortId: string;
  connectionId: string;
  clientId: string;
  counterpartyClientId: string;
  counterpartyConnectionId: string;
  counterpartyChainId: string | null;
  ordering: string;
  version: string;
  restEndpoints: string[];
}

interface EscrowAddressResponse {
  escrow_address?: string;
}

interface ChannelResponse {
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

interface ConnectionResponse {
  connection?: {
    client_id?: string;
    counterparty?: {
      client_id?: string;
      connection_id?: string;
    };
  };
}

interface ClientStateResponse {
  client_state?: {
    chain_id?: string;
  };
  identified_client_state?: {
    client_state?: {
      chain_id?: string;
    };
  };
}

type RequestFn = (endpoints: string[], requestPath: string) => Promise<unknown>;

const defaultRequest: RequestFn = async (endpoints, requestPath) => {
  const { makeRequest } = await import('./chainUtils.js');
  return makeRequest(endpoints, requestPath);
};

export function validateChannelId(channelId: string): void {
  if (!/^channel-\d+$/.test(channelId)) {
    throw new Error(`Invalid channel ID: ${channelId}`);
  }
}

export function buildEscrowAddressPath(channelId: string, portId: string = 'transfer'): string {
  validateChannelId(channelId);
  return `/ibc/apps/transfer/v1/channels/${encodeURIComponent(
    channelId
  )}/ports/${encodeURIComponent(portId)}/escrow_address`;
}

export function buildChannelPath(channelId: string, portId: string = 'transfer'): string {
  validateChannelId(channelId);
  return `/ibc/core/channel/v1/channels/${encodeURIComponent(
    channelId
  )}/ports/${encodeURIComponent(portId)}`;
}

function getRestEndpoints(chainInfo: ChainInfo): string[] {
  const endpoints = chainInfo.apis.rest.map((api) => api.address).filter(Boolean);

  if (endpoints.length === 0) {
    throw new Error(`No REST endpoints found for ${chainInfo.chain_name}`);
  }

  return endpoints;
}

function getClientStateChainId(clientData: ClientStateResponse): string | null {
  return (
    clientData.client_state?.chain_id ||
    clientData.identified_client_state?.client_state?.chain_id ||
    null
  );
}

export async function lookupEscrowAddress({
  chainInfo,
  channelId,
  portId = 'transfer',
  request = defaultRequest,
}: {
  chainInfo: ChainInfo;
  channelId: string;
  portId?: string;
  request?: RequestFn;
}): Promise<EscrowLookupResult> {
  const restEndpoints = getRestEndpoints(chainInfo);
  const escrowData = (await request(
    restEndpoints,
    buildEscrowAddressPath(channelId, portId)
  )) as EscrowAddressResponse;

  if (!escrowData.escrow_address) {
    throw new Error(`Escrow address not returned for ${chainInfo.chain_name} ${channelId}`);
  }

  return {
    chainName: chainInfo.chain_name,
    chainId: chainInfo.chain_id,
    channelId,
    portId,
    escrowAddress: escrowData.escrow_address,
    restEndpoints,
  };
}

export async function lookupChannelInfo({
  chainInfo,
  channelId,
  portId = 'transfer',
  request = defaultRequest,
}: {
  chainInfo: ChainInfo;
  channelId: string;
  portId?: string;
  request?: RequestFn;
}): Promise<ChannelInfoLookupResult> {
  const restEndpoints = getRestEndpoints(chainInfo);
  const channelData = (await request(
    restEndpoints,
    buildChannelPath(channelId, portId)
  )) as ChannelResponse;
  const channel = channelData.channel;
  const connectionId = channel?.connection_hops?.[0];

  if (!channel || !connectionId) {
    throw new Error(`Incomplete channel data returned for ${chainInfo.chain_name} ${channelId}`);
  }

  const connectionData = (await request(
    restEndpoints,
    `/ibc/core/connection/v1/connections/${connectionId}`
  )) as ConnectionResponse;
  const connection = connectionData.connection;
  const clientId = connection?.client_id;

  if (!connection || !clientId) {
    throw new Error(
      `Incomplete connection data returned for ${chainInfo.chain_name} ${connectionId}`
    );
  }

  const clientData = (await request(
    restEndpoints,
    `/ibc/core/client/v1/client_states/${clientId}`
  )) as ClientStateResponse;

  return {
    chainName: chainInfo.chain_name,
    chainId: chainInfo.chain_id,
    channelId,
    portId,
    counterpartyChannelId: channel.counterparty?.channel_id || '',
    counterpartyPortId: channel.counterparty?.port_id || '',
    connectionId,
    clientId,
    counterpartyClientId: connection.counterparty?.client_id || '',
    counterpartyConnectionId: connection.counterparty?.connection_id || '',
    counterpartyChainId: getClientStateChainId(clientData),
    ordering: channel.ordering || '',
    version: channel.version || '',
    restEndpoints,
  };
}
