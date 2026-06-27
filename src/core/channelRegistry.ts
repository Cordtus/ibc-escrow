import { promises as fs } from 'fs';
import path from 'path';
import type { IBCData } from '../types/common.js';

export interface IbcChannelLink {
  chainName: string;
  counterpartyChainName: string;
  channelId: string;
  counterpartyChannelId: string;
  portId: string;
  counterpartyPortId: string;
  clientId: string;
  counterpartyClientId: string;
  connectionId: string;
  counterpartyConnectionId: string;
  ordering: string;
  version: string;
  tags: NonNullable<IBCData['channels'][number]['tags']>;
  sourceFile: string;
}

const DEFAULT_DATA_DIR = path.join(process.cwd(), 'data');

function normalizeChainName(chainName: string): string {
  return chainName.trim().toLowerCase();
}

export async function listAvailableChainsFromDir(
  dataDir: string = DEFAULT_DATA_DIR
): Promise<string[]> {
  const entries = await fs.readdir(dataDir, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name.endsWith('.json'))
    .filter((name) => name !== 'chain.schema.json')
    .map((name) => name.replace(/\.json$/, ''))
    .sort((a, b) => a.localeCompare(b));
}

function compareLinks(a: IbcChannelLink, b: IbcChannelLink): number {
  const preferredDelta = Number(b.tags.preferred === true) - Number(a.tags.preferred === true);
  if (preferredDelta !== 0) {
    return preferredDelta;
  }

  const liveDelta = Number(b.tags.status === 'live') - Number(a.tags.status === 'live');
  if (liveDelta !== 0) {
    return liveDelta;
  }

  return `${a.counterpartyChainName}:${a.channelId}`.localeCompare(
    `${b.counterpartyChainName}:${b.channelId}`
  );
}

function mapChannelLink(
  ibcData: IBCData,
  channel: IBCData['channels'][number],
  sourceSide: 'chain_1' | 'chain_2',
  sourceFile: string
): IbcChannelLink {
  const counterpartySide = sourceSide === 'chain_1' ? 'chain_2' : 'chain_1';
  const sourceChain = ibcData[sourceSide];
  const counterpartyChain = ibcData[counterpartySide];
  const sourceChannel = channel[sourceSide];
  const counterpartyChannel = channel[counterpartySide];

  return {
    chainName: sourceChain.chain_name,
    counterpartyChainName: counterpartyChain.chain_name,
    channelId: sourceChannel.channel_id,
    counterpartyChannelId: counterpartyChannel.channel_id,
    portId: sourceChannel.port_id || 'transfer',
    counterpartyPortId: counterpartyChannel.port_id || 'transfer',
    clientId: sourceChain.client_id,
    counterpartyClientId: counterpartyChain.client_id,
    connectionId: sourceChain.connection_id,
    counterpartyConnectionId: counterpartyChain.connection_id,
    ordering: channel.ordering,
    version: channel.version,
    tags: channel.tags || {},
    sourceFile,
  };
}

export async function listIbcLinksForChain(
  chainName: string,
  dataDir: string = DEFAULT_DATA_DIR
): Promise<IbcChannelLink[]> {
  const ibcDir = path.join(dataDir, 'ibc');
  const files = await fs.readdir(ibcDir);
  const normalizedChainName = normalizeChainName(chainName);
  const links: IbcChannelLink[] = [];

  for (const file of files.filter((name) => name.endsWith('.json')).sort()) {
    const rawFile = await fs.readFile(path.join(ibcDir, file), 'utf8');
    const ibcData = JSON.parse(rawFile) as IBCData;

    let sourceSide: 'chain_1' | 'chain_2' | null = null;
    if (normalizeChainName(ibcData.chain_1.chain_name) === normalizedChainName) {
      sourceSide = 'chain_1';
    } else if (normalizeChainName(ibcData.chain_2.chain_name) === normalizedChainName) {
      sourceSide = 'chain_2';
    }

    if (!sourceSide) {
      continue;
    }

    for (const channel of ibcData.channels) {
      links.push(mapChannelLink(ibcData, channel, sourceSide, file));
    }
  }

  return links.sort(compareLinks);
}

export async function listIbcLinksBetweenChains(
  primaryChain: string,
  secondaryChain: string,
  dataDir: string = DEFAULT_DATA_DIR
): Promise<IbcChannelLink[]> {
  const normalizedSecondaryChain = normalizeChainName(secondaryChain);
  const links = await listIbcLinksForChain(primaryChain, dataDir);

  return links.filter(
    (link) => normalizeChainName(link.counterpartyChainName) === normalizedSecondaryChain
  );
}
