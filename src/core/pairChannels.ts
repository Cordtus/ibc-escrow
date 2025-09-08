import { loadIBCData, validateId } from './ibcUtils.js';
import type { IBCData } from '../types/common.js';

export interface ChannelPair {
  [chainName: string]: any;
  ordering: string;
  version: string;
  tags?: {
    status?: string;
    preferred?: boolean;
    dex?: string;
    properties?: string;
  };
}

export default async function getChannelPairs(
  chain1Name: string,
  chain2Name: string
): Promise<ChannelPair[]> {
  const ibcData = await loadIBCData(chain1Name, chain2Name);

  if (!ibcData) {
    throw new Error(`Unable to load IBC data for ${chain1Name}-${chain2Name}`);
  }

  return ibcData.channels.map((channel) => {
    validateId(channel.chain_1.channel_id, 'channel');
    validateId(channel.chain_2.channel_id, 'channel');

    const pair: ChannelPair = {
      [chain1Name]: channel.chain_1.channel_id,
      [chain2Name]: channel.chain_2.channel_id,
      ordering: channel.ordering,
      version: channel.version
    };

    if (channel.tags) {
      pair.tags = channel.tags;
    }

    return pair;
  });
}