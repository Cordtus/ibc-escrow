import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildBalancesPath,
  buildChannelDetails,
  buildChannelPath,
  buildClientStatePath,
  buildConnectionPath,
  buildEscrowAddressPath,
  buildLookupUrl,
  getNextBalancePageKey,
  normalizeBalances,
  normalizeChainSummaries,
  resolveRequestSource,
} from './lookup.ts';

describe('web lookup helpers', () => {
  it('builds transfer escrow and channel paths', () => {
    assert.equal(
      buildEscrowAddressPath('channel-141', 'transfer'),
      '/ibc/apps/transfer/v1/channels/channel-141/ports/transfer/escrow_address'
    );
    assert.equal(
      buildChannelPath('channel-141', 'transfer'),
      '/ibc/core/channel/v1/channels/channel-141/ports/transfer'
    );
  });

  it('builds bank balance paths for escrow addresses', () => {
    assert.equal(
      buildBalancesPath('cosmos1x54ltnyg88k0ejmk8ytwrhd3ltm84xehrnlslf'),
      '/cosmos/bank/v1beta1/balances/cosmos1x54ltnyg88k0ejmk8ytwrhd3ltm84xehrnlslf'
    );
    assert.equal(
      buildBalancesPath('cosmos1x54ltnyg88k0ejmk8ytwrhd3ltm84xehrnlslf', 'a/b='),
      '/cosmos/bank/v1beta1/balances/cosmos1x54ltnyg88k0ejmk8ytwrhd3ltm84xehrnlslf?pagination.key=a%2Fb%3D'
    );
  });

  it('normalizes bank balance responses and pagination', () => {
    assert.deepEqual(
      normalizeBalances({
        balances: [
          { denom: 'uatom', amount: '12345' },
          { denom: 'ibc/ABC', amount: '67890' },
          { denom: '', amount: '1' },
        ],
      }),
      [
        { denom: 'uatom', amount: '12345' },
        { denom: 'ibc/ABC', amount: '67890' },
      ]
    );

    assert.deepEqual(normalizeBalances({}), []);
    assert.equal(getNextBalancePageKey({ pagination: { next_key: 'next-page' } }), 'next-page');
    assert.equal(getNextBalancePageKey({ pagination: { next_key: null } }), undefined);
  });

  it('builds direct REST and Lazy-LB URLs', () => {
    const path = buildEscrowAddressPath('channel-141');

    assert.deepEqual(
      buildLookupUrl({ chainName: 'cosmoshub', endpointMode: 'direct-rest' }, path),
      {
        source: 'direct-rest',
        url: 'https://rest.cosmos.directory/cosmoshub/ibc/apps/transfer/v1/channels/channel-141/ports/transfer/escrow_address',
      }
    );

    assert.deepEqual(
      buildLookupUrl(
        {
          chainName: 'cosmoshub',
          endpointMode: 'direct-rest',
          directRestBaseUrl: 'https://lcd.example.com/cosmoshub/',
        },
        path
      ),
      {
        source: 'direct-rest',
        url: 'https://lcd.example.com/cosmoshub/ibc/apps/transfer/v1/channels/channel-141/ports/transfer/escrow_address',
      }
    );

    assert.deepEqual(
      buildLookupUrl(
        {
          chainName: 'cosmoshub',
          endpointMode: 'lazy-lb',
          lazyLbBaseUrl: 'https://lb.example.com/',
        },
        path
      ),
      {
        source: 'lazy-lb',
        url: 'https://lb.example.com/lb/cosmoshub/ibc/apps/transfer/v1/channels/channel-141/ports/transfer/escrow_address',
      }
    );
  });

  it('uses Lazy-LB automatically only when a base URL is configured', () => {
    assert.equal(
      resolveRequestSource({ chainName: 'osmosis', endpointMode: 'auto' }),
      'direct-rest'
    );
    assert.equal(
      resolveRequestSource({
        chainName: 'osmosis',
        endpointMode: 'auto',
        lazyLbBaseUrl: 'https://lb.example.com',
      }),
      'lazy-lb'
    );
  });

  it('normalizes chain-registry summaries for selection', () => {
    assert.deepEqual(
      normalizeChainSummaries([
        {
          name: 'osmosis',
          chainId: 'osmosis-1',
          bech32Prefix: 'osmo',
          endpointCount: 12,
          rpcCount: 6,
          restCount: 6,
          source: 'chain-registry',
        },
        {
          name: 'cosmoshub',
          chainId: 'cosmoshub-4',
          bech32Prefix: 'cosmos',
          endpointCount: 63,
          rpcCount: 34,
          restCount: 29,
          source: 'chain-registry',
        },
        { name: '', chainId: 'bad' },
      ]),
      [
        {
          name: 'cosmoshub',
          chainId: 'cosmoshub-4',
          bech32Prefix: 'cosmos',
          endpointCount: 63,
          rpcCount: 34,
          restCount: 29,
        },
        {
          name: 'osmosis',
          chainId: 'osmosis-1',
          bech32Prefix: 'osmo',
          endpointCount: 12,
          rpcCount: 6,
          restCount: 6,
        },
      ]
    );

    assert.deepEqual(normalizeChainSummaries({}), []);
  });

  it('builds dependent channel detail requests and summary data', () => {
    assert.equal(
      buildConnectionPath('connection-257'),
      '/ibc/core/connection/v1/connections/connection-257'
    );
    assert.equal(
      buildClientStatePath('07-tendermint-259'),
      '/ibc/core/client/v1/client_states/07-tendermint-259'
    );

    assert.deepEqual(
      buildChannelDetails(
        {
          channel: {
            counterparty: { channel_id: 'channel-0', port_id: 'transfer' },
            connection_hops: ['connection-257'],
            ordering: 'ORDER_UNORDERED',
            version: 'ics20-1',
          },
        },
        {
          connection: {
            client_id: '07-tendermint-259',
            counterparty: {
              client_id: '07-tendermint-1',
              connection_id: 'connection-1',
            },
          },
        },
        { client_state: { chain_id: 'osmosis-1' } }
      ),
      {
        counterpartyChannelId: 'channel-0',
        counterpartyPortId: 'transfer',
        connectionId: 'connection-257',
        clientId: '07-tendermint-259',
        counterpartyClientId: '07-tendermint-1',
        counterpartyConnectionId: 'connection-1',
        counterpartyChainId: 'osmosis-1',
        ordering: 'ORDER_UNORDERED',
        version: 'ics20-1',
      }
    );
  });
});
