import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { listAvailableChainsFromDir, listIbcLinksForChain } from '../../core/channelRegistry.js';

async function withTempDataDir(run: (dataDir: string) => Promise<void>): Promise<void> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'ibc-registry-'));

  try {
    await mkdir(path.join(dataDir, 'ibc'), { recursive: true });
    await run(dataDir);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

describe('channelRegistry', () => {
  it('lists sorted chain names from chain json files only', async () => {
    await withTempDataDir(async (dataDir) => {
      await writeFile(path.join(dataDir, 'osmosis.json'), '{}');
      await writeFile(path.join(dataDir, 'cosmoshub.json'), '{}');
      await writeFile(path.join(dataDir, 'chain.schema.json'), '{}');
      await writeFile(path.join(dataDir, 'update_complete'), 'done');

      assert.deepEqual(await listAvailableChainsFromDir(dataDir), ['cosmoshub', 'osmosis']);
    });
  });

  it('maps IBC registry channels from the selected chain perspective', async () => {
    await withTempDataDir(async (dataDir) => {
      await writeFile(
        path.join(dataDir, 'ibc', 'cosmoshub-osmosis.json'),
        JSON.stringify({
          chain_1: {
            chain_name: 'cosmoshub',
            client_id: '07-tendermint-259',
            connection_id: 'connection-257',
          },
          chain_2: {
            chain_name: 'osmosis',
            client_id: '07-tendermint-1',
            connection_id: 'connection-1',
          },
          channels: [
            {
              chain_1: {
                channel_id: 'channel-141',
                port_id: 'transfer',
              },
              chain_2: {
                channel_id: 'channel-0',
                port_id: 'transfer',
              },
              ordering: 'unordered',
              version: 'ics20-1',
              tags: {
                preferred: true,
                status: 'live',
              },
            },
          ],
        })
      );

      assert.deepEqual(await listIbcLinksForChain('cosmoshub', dataDir), [
        {
          chainName: 'cosmoshub',
          counterpartyChainName: 'osmosis',
          channelId: 'channel-141',
          counterpartyChannelId: 'channel-0',
          portId: 'transfer',
          counterpartyPortId: 'transfer',
          clientId: '07-tendermint-259',
          counterpartyClientId: '07-tendermint-1',
          connectionId: 'connection-257',
          counterpartyConnectionId: 'connection-1',
          ordering: 'unordered',
          version: 'ics20-1',
          tags: {
            preferred: true,
            status: 'live',
          },
          sourceFile: 'cosmoshub-osmosis.json',
        },
      ]);
    });
  });
});
