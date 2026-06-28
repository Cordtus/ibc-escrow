import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildBalancesPath,
  buildChannelDetails,
  buildChannelPath,
  buildClientStatePath,
  buildConnectionPath,
  buildDestinationIbcDenom,
  buildEscrowAddressPath,
  buildIbcDenom,
  buildLookupUrl,
  buildSupplyByDenomPath,
  getNextBalancePageKey,
  normalizeBalances,
  normalizeChainSelection,
  normalizeChainSummaries,
  normalizeSupplyAmount,
  resolveLookupRoute,
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

  it('resolves chain selections by name or chain ID', () => {
    const chains = normalizeChainSummaries([
      {
        name: 'genesisl1',
        chainId: 'genesis_29-2',
        bech32Prefix: 'genesis',
      },
      {
        name: 'osmosis',
        chainId: 'osmosis-1',
        bech32Prefix: 'osmo',
      },
    ]);

    assert.equal(normalizeChainSelection('genesisl1', chains), 'genesisl1');
    assert.equal(normalizeChainSelection('GENESIS_29-2', chains), 'genesisl1');
    assert.equal(normalizeChainSelection('osmosis-1', chains), 'osmosis');
    assert.throws(() => normalizeChainSelection('missing-1', chains), /Unknown chain/);
  });

  it('resolves lookup routes from transfer registry links unless a manual channel override is supplied', () => {
    assert.deepEqual(
      resolveLookupRoute(
        {
          sourceChainName: 'genesisl1',
          destinationChainName: 'osmosis',
          channelId: '',
          portId: '',
        },
        {
          source: { name: 'genesisl1', chainId: 'genesis_29-2' },
          destination: { name: 'osmosis', chainId: 'osmosis-1' },
          links: [
            {
              sourceChainName: 'genesisl1',
              sourceChainId: 'genesis_29-2',
              destinationChainName: 'osmosis',
              destinationChainId: 'osmosis-1',
              channelId: 'channel-8',
              portId: 'provider',
              counterpartyChannelId: 'channel-508',
              counterpartyPortId: 'consumer',
              clientId: '07-tendermint-2',
              counterpartyClientId: '07-tendermint-1984',
              connectionId: 'connection-2',
              counterpartyConnectionId: 'connection-1540',
              ordering: 'ordered',
              version: 'ics20-1',
              tags: { preferred: true, status: 'live' },
              sourceFile: 'genesisl1-osmosis.json',
            },
            {
              sourceChainName: 'genesisl1',
              sourceChainId: 'genesis_29-2',
              destinationChainName: 'osmosis',
              destinationChainId: 'osmosis-1',
              channelId: 'channel-1',
              portId: 'transfer',
              counterpartyChannelId: 'channel-253',
              counterpartyPortId: 'transfer',
              clientId: '07-tendermint-1',
              counterpartyClientId: '07-tendermint-1983',
              connectionId: 'connection-1',
              counterpartyConnectionId: 'connection-1539',
              ordering: 'unordered',
              version: 'ics20-1',
              tags: { preferred: true, status: 'live' },
              sourceFile: 'genesisl1-osmosis.json',
            },
          ],
        }
      ),
      {
        sourceChainName: 'genesisl1',
        destinationChainName: 'osmosis',
        channelId: 'channel-1',
        portId: 'transfer',
        counterpartyChannelId: 'channel-253',
        counterpartyPortId: 'transfer',
        source: 'registry',
      }
    );

    assert.deepEqual(
      resolveLookupRoute({
        sourceChainName: 'genesisl1',
        destinationChainName: 'osmosis',
        channelId: 'channel-99',
        portId: 'custom',
      }),
      {
        sourceChainName: 'genesisl1',
        destinationChainName: 'osmosis',
        channelId: 'channel-99',
        portId: 'custom',
        counterpartyChannelId: '',
        counterpartyPortId: '',
        source: 'manual',
      }
    );
  });

  it('builds destination supply paths and hashes denoms with destination-side IBC paths', async () => {
    assert.equal(
      buildSupplyByDenomPath('ibc/ABC'),
      '/cosmos/bank/v1beta1/supply/by_denom?denom=ibc%2FABC'
    );
    assert.equal(
      await buildIbcDenom('transfer', 'channel-1', 'el1'),
      'ibc/776644F2A446095B20E741B2CD25F3E50E4672CD3CC01230D987AA23A95F4B87'
    );
    assert.equal(
      await buildDestinationIbcDenom(
        {
          sourceChainName: 'cosmoshub',
          destinationChainName: 'osmosis',
          channelId: 'channel-141',
          portId: 'transfer',
          counterpartyChannelId: 'channel-0',
          counterpartyPortId: 'transfer',
          source: 'registry',
        },
        'uatom'
      ),
      'ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2'
    );
    await assert.rejects(
      () =>
        buildDestinationIbcDenom(
          {
            sourceChainName: 'cosmoshub',
            destinationChainName: 'osmosis',
            channelId: 'channel-141',
            portId: 'transfer',
            counterpartyChannelId: '',
            counterpartyPortId: '',
            source: 'manual',
          },
          'uatom'
        ),
      /Counterparty channel is required/
    );
    assert.equal(
      normalizeSupplyAmount({
        amount: {
          denom: 'ibc/ABC',
          amount: '123',
        },
      }),
      '123'
    );
    assert.equal(normalizeSupplyAmount({}), '0');
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
