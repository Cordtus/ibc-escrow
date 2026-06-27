import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hashIBCDenom, validateIBCData, validateId } from '../../core/ibcUtils.js';

describe('ibcUtils', () => {
  it('validates channel, connection, and client identifiers', () => {
    assert.doesNotThrow(() => validateId('channel-0', 'channel'));
    assert.doesNotThrow(() => validateId('connection-456', 'connection'));
    assert.doesNotThrow(() => validateId('07-tendermint-789', 'client'));

    assert.throws(() => validateId('channel-abc', 'channel'), /Invalid channel ID format/);
    assert.throws(() => validateId('connection-abc', 'connection'), /Invalid connection ID format/);
    assert.throws(() => validateId('invalid-client', 'client'), /Invalid client ID format/);
  });

  it('generates stable ICS-20 denom hashes', () => {
    const hash = hashIBCDenom('transfer', 'channel-0', 'uatom');

    assert.match(hash, /^ibc\/[A-F0-9]{64}$/);
    assert.equal(hash, hashIBCDenom('transfer', 'channel-0', 'uatom'));
    assert.notEqual(hash, hashIBCDenom('transfer', 'channel-1', 'uatom'));
  });

  it('validates IBC registry data shape', () => {
    const validData = {
      chain_1: {
        chain_name: 'osmosis',
        client_id: '07-tendermint-0',
        connection_id: 'connection-0',
      },
      chain_2: {
        chain_name: 'cosmoshub',
        client_id: '07-tendermint-1',
        connection_id: 'connection-1',
      },
      channels: [
        {
          chain_1: { channel_id: 'channel-0', port_id: 'transfer' },
          chain_2: { channel_id: 'channel-141', port_id: 'transfer' },
          ordering: 'unordered',
          version: 'ics20-1',
        },
      ],
    };

    assert.equal(validateIBCData(validData), true);
    assert.equal(validateIBCData(null), false);
    assert.equal(validateIBCData('not-data'), false);
    assert.equal(validateIBCData({ ...validData, channels: [] }), false);
    assert.equal(
      validateIBCData({
        ...validData,
        channels: [
          {
            chain_1: { port_id: 'transfer' },
            chain_2: { channel_id: 'channel-141', port_id: 'transfer' },
            ordering: 'unordered',
            version: 'ics20-1',
          },
        ],
      }),
      false
    );
  });
});
