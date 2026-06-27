import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import {
  buildChannelPath,
  buildEscrowAddressPath,
  lookupChannelInfo,
  lookupEscrowAddress,
} from '../../core/escrowLookup.js';
import type { ChainInfo } from '../../types/common.js';

const chainInfo: ChainInfo = {
  chain_name: 'cosmoshub',
  chain_id: 'cosmoshub-4',
  bech32_prefix: 'cosmos',
  slip44: 118,
  fees: {
    fee_tokens: [{ denom: 'uatom' }],
  },
  staking: {
    staking_tokens: [{ denom: 'uatom' }],
  },
  apis: {
    rpc: [{ address: 'https://rpc.cosmos.directory/cosmoshub' }],
    rest: [{ address: 'https://rest.cosmos.directory/cosmoshub' }],
    grpc: [{ address: 'grpc.cosmos.directory:443' }],
  },
};

describe('escrowLookup', () => {
  it('builds the ICS-20 escrow address endpoint', () => {
    assert.equal(
      buildEscrowAddressPath('channel-141', 'transfer'),
      '/ibc/apps/transfer/v1/channels/channel-141/ports/transfer/escrow_address'
    );
  });

  it('returns escrow address lookup context', async () => {
    const request = mock.fn(async () => ({
      escrow_address: 'cosmos1escrowaddress',
    }));

    assert.deepEqual(
      await lookupEscrowAddress({
        chainInfo,
        channelId: 'channel-141',
        portId: 'transfer',
        request,
      }),
      {
        chainName: 'cosmoshub',
        chainId: 'cosmoshub-4',
        channelId: 'channel-141',
        portId: 'transfer',
        escrowAddress: 'cosmos1escrowaddress',
        restEndpoints: ['https://rest.cosmos.directory/cosmoshub'],
      }
    );

    assert.deepEqual(request.mock.calls[0].arguments, [
      ['https://rest.cosmos.directory/cosmoshub'],
      '/ibc/apps/transfer/v1/channels/channel-141/ports/transfer/escrow_address',
    ]);
  });

  it('returns channel, connection, and client context', async () => {
    const responses = new Map<string, unknown>([
      [
        buildChannelPath('channel-141', 'transfer'),
        {
          channel: {
            counterparty: {
              channel_id: 'channel-0',
              port_id: 'transfer',
            },
            connection_hops: ['connection-257'],
            ordering: 'ORDER_UNORDERED',
            version: 'ics20-1',
          },
        },
      ],
      [
        '/ibc/core/connection/v1/connections/connection-257',
        {
          connection: {
            client_id: '07-tendermint-259',
            counterparty: {
              client_id: '07-tendermint-1',
              connection_id: 'connection-1',
            },
          },
        },
      ],
      [
        '/ibc/core/client/v1/client_states/07-tendermint-259',
        {
          client_state: {
            chain_id: 'osmosis-1',
          },
        },
      ],
    ]);
    const request = mock.fn(async (_endpoints: string[], requestPath: string) =>
      responses.get(requestPath)
    );

    assert.deepEqual(
      await lookupChannelInfo({
        chainInfo,
        channelId: 'channel-141',
        portId: 'transfer',
        request,
      }),
      {
        chainName: 'cosmoshub',
        chainId: 'cosmoshub-4',
        channelId: 'channel-141',
        portId: 'transfer',
        counterpartyChannelId: 'channel-0',
        counterpartyPortId: 'transfer',
        connectionId: 'connection-257',
        clientId: '07-tendermint-259',
        counterpartyClientId: '07-tendermint-1',
        counterpartyConnectionId: 'connection-1',
        counterpartyChainId: 'osmosis-1',
        ordering: 'ORDER_UNORDERED',
        version: 'ics20-1',
        restEndpoints: ['https://rest.cosmos.directory/cosmoshub'],
      }
    );
  });
});
