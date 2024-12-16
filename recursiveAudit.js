// File: recursiveAudit.js

import { makeRequest, loadChainInfo } from './chainUtils.js';
import { fetchIBCData, hashIBCDenom } from './ibcUtils.js';
import logger from './logger.js';

export async function recursiveUnwrap(chainInfo, denom, path = []) {
  if (!denom.startsWith('ibc/')) {
    return { baseDenom: denom, path };
  }

  const hash = denom.split('/')[1];
  const tracePath = `/ibc/apps/transfer/v1/denom_traces/${hash}`;
  
  let traceData;
  try {
    traceData = await makeRequest(chainInfo.apis.rest.map(api => api.address), tracePath);
  } catch (error) {
    logger.error(`Error fetching denom trace for ${denom} on ${chainInfo.chain_name}:`, error.message);
    return { baseDenom: denom, path };
  }

  if (!traceData || !traceData.denom_trace) {
    logger.warn(`No denom trace found for ${denom} on ${chainInfo.chain_name}`);
    return { baseDenom: denom, path };
  }

  const trace = traceData.denom_trace;
  const channelId = trace.path.split('/')[1];

  const ibcData = await fetchIBCData(chainInfo.chain_name, trace.path.split('/')[2]);
  
  if (!ibcData) {
    logger.error(`Failed to fetch IBC data for ${chainInfo.chain_name} and ${trace.path.split('/')[2]}`);
    return { baseDenom: trace.base_denom, path };
  }

  const counterpartyChannelId = ibcData.counterparty_channel_id;

  path.push({
    chain: chainInfo.chain_name,
    channel: channelId,
    port: trace.path.split('/')[0],
    counterpartyChain: trace.path.split('/')[2],
    counterpartyChannel: counterpartyChannelId
  });

  let nextChainInfo;
  try {
    nextChainInfo = await loadChainInfo(trace.path.split('/')[2]);
  } catch (error) {
    logger.error(`Error loading chain info for ${trace.path.split('/')[2]}:`, error.message);
    return { baseDenom: trace.base_denom, path };
  }

  if (!nextChainInfo) {
    logger.warn(`Chain info not found for ${trace.path.split('/')[2]}`);
    return { baseDenom: trace.base_denom, path };
  }

  return recursiveUnwrap(nextChainInfo, trace.base_denom, path);
}

export async function fetchTotalSupply(chainInfo, denom) {
  const restEndpoints = chainInfo.apis.rest.map(api => api.address);
  const supplyPath = `/cosmos/bank/v1beta1/supply/by_denom?denom=${encodeURIComponent(denom)}`;
  
  try {
    const supplyData = await makeRequest(restEndpoints, supplyPath);
    return supplyData.amount.amount;
  } catch (error) {
    logger.error(`Error fetching total supply for ${denom}:`, error.message);
    throw error;
  }
}

export async function auditToken(primaryChainInfo, secondaryChainInfo, denom, balance) {
  const unwrapResult = await recursiveUnwrap(primaryChainInfo, denom);
  const baseDenom = unwrapResult.baseDenom;

  const counterpartyChannelId = unwrapResult.path[unwrapResult.path.length - 1].counterpartyChannel;
  const counterpartyIbcDenom = hashIBCDenom('transfer', counterpartyChannelId, baseDenom);

  try {
    const totalSupply = await fetchTotalSupply(secondaryChainInfo, counterpartyIbcDenom);

    if (balance !== totalSupply) {
      return {
        token: baseDenom,
        escrowBalance: balance,
        totalSupply: totalSupply,
        difference: BigInt(balance) - BigInt(totalSupply),
        unwrapPath: unwrapResult.path
      };
    }
  } catch (error) {
    logger.error(`Error auditing token ${baseDenom}:`, error.message);
    return {
      token: baseDenom,
      error: error.message
    };
  }

  return null;
}