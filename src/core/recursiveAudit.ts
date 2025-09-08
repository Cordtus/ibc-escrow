import { makeRequest, loadChainInfo } from './chainUtils.js';
import { hashIBCDenom, recursiveUnwrapToken, getAllEscrowTokens, getTokenOrigin } from './ibcUtils.js';
import logger from './logger.js';
import type { ChainInfo, AuditResult } from '../types/common.js';

export interface ComprehensiveAuditResult extends AuditResult {
  tokens: Array<{
    denom: string;
    amount: string;
    isNative: boolean;
    originChain?: string;
    originalDenom?: string;
    escrowBalance?: string;
    originBalance?: string;
    discrepancy?: string;
    traceComplete: boolean;
    hops?: Array<{
      fromChain: string;
      toChain: string;
      channelId: string;
      portId: string;
    }>;
  }>;
  totalTokensAudited: number;
  nativeTokens: number;
  ibcTokens: number;
  successfulTraces: number;
  failedTraces: number;
}

export async function performComprehensiveAudit(
  primaryChain: string,
  secondaryChain: string,
  channelId?: string
): Promise<ComprehensiveAuditResult> {
  logger.info(`Starting comprehensive audit: ${primaryChain} <-> ${secondaryChain}`);
  const startTime = Date.now();

  try {
    // Load chain information
    const primaryChainInfo = await loadChainInfo(primaryChain);
    const secondaryChainInfo = await loadChainInfo(secondaryChain);
    
    if (!primaryChainInfo || !secondaryChainInfo) {
      throw new Error(`Failed to load chain information for ${primaryChain} or ${secondaryChain}`);
    }

    // Get the escrow address (simplified - in practice this would be calculated properly)
    const escrowAddress = getEscrowAddress(primaryChainInfo, channelId || 'channel-0');
    
    // Get all tokens in escrow
    const escrowTokens = await getAllEscrowTokens(primaryChainInfo, escrowAddress);
    logger.info(`Found ${escrowTokens.length} tokens in escrow address ${escrowAddress}`);

    const auditResults = [];
    let nativeCount = 0;
    let ibcCount = 0;
    let successfulTraces = 0;
    let failedTraces = 0;

    // Audit each token
    for (const token of escrowTokens) {
      logger.info(`Auditing token: ${token.denom} (${token.amount})`);
      
      if (token.isNative) {
        nativeCount++;
        const nativeAudit = await auditNativeToken(
          primaryChainInfo,
          secondaryChainInfo,
          token,
          channelId
        );
        auditResults.push(nativeAudit);
      } else {
        ibcCount++;
        const ibcAudit = await auditIbcToken(
          primaryChainInfo,
          token,
          channelId
        );
        auditResults.push(ibcAudit);
        
        if (ibcAudit.traceComplete) {
          successfulTraces++;
        } else {
          failedTraces++;
        }
      }
    }

    const duration = Date.now() - startTime;
    logger.performance('comprehensive_audit', duration, {
      primaryChain,
      secondaryChain,
      tokensAudited: escrowTokens.length,
      nativeTokens: nativeCount,
      ibcTokens: ibcCount
    });

    return {
      chainName: primaryChain,
      escrowAddress,
      nativeToken: primaryChainInfo.staking?.staking_tokens?.[0]?.denom || '',
      escrowBalance: escrowTokens.find(t => t.isNative)?.amount || '0',
      timestamp: Date.now(),
      tokens: auditResults,
      totalTokensAudited: escrowTokens.length,
      nativeTokens: nativeCount,
      ibcTokens: ibcCount,
      successfulTraces,
      failedTraces
    };

  } catch (error) {
    logger.error(`Comprehensive audit failed: ${error}`);
    throw error;
  }
}

async function auditNativeToken(
  primaryChainInfo: ChainInfo,
  secondaryChainInfo: ChainInfo,
  token: { denom: string; amount: string; isNative: boolean },
  channelId?: string
): Promise<ComprehensiveAuditResult['tokens'][0]> {
  try {
    // Calculate what the IBC denom would be on the secondary chain
    const portId = 'transfer';
    const ibcDenom = hashIBCDenom(portId, channelId || 'channel-0', token.denom);
    
    // Get the escrow address on the secondary chain for the reverse direction
    const secondaryEscrowAddress = getEscrowAddress(secondaryChainInfo, channelId || 'channel-0');
    
    // Fetch balance on secondary chain
    const secondaryBalance = await fetchTokenBalance(secondaryChainInfo, secondaryEscrowAddress, ibcDenom);
    
    // Calculate discrepancy
    const escrowAmount = BigInt(token.amount);
    const secondaryAmount = BigInt(secondaryBalance || '0');
    const discrepancy = escrowAmount - secondaryAmount;
    
    logger.debug(`Native token audit - Escrow: ${token.amount}, Secondary: ${secondaryBalance}, Discrepancy: ${discrepancy}`);
    
    return {
      denom: token.denom,
      amount: token.amount,
      isNative: true,
      escrowBalance: token.amount,
      originBalance: secondaryBalance || undefined,
      discrepancy: discrepancy.toString(),
      traceComplete: true
    };
    
  } catch (error) {
    logger.error(`Failed to audit native token ${token.denom}: ${error}`);
    return {
      denom: token.denom,
      amount: token.amount,
      isNative: true,
      traceComplete: false
    };
  }
}

async function auditIbcToken(
  primaryChainInfo: ChainInfo,
  token: { denom: string; amount: string; isNative: boolean; origin?: any },
  channelId?: string
): Promise<ComprehensiveAuditResult['tokens'][0]> {
  try {
    // Use the enhanced recursive unwrapping to trace the token
    const traceResult = await recursiveUnwrapToken(primaryChainInfo, token.denom);
    
    if (!traceResult.isComplete) {
      logger.warn(`Incomplete trace for IBC token ${token.denom}`);
      return {
        denom: token.denom,
        amount: token.amount,
        isNative: false,
        traceComplete: false
      };
    }
    
    // Load the origin chain info
    const originChainInfo = await loadChainInfo(traceResult.originChain);
    if (!originChainInfo) {
      throw new Error(`Failed to load origin chain info: ${traceResult.originChain}`);
    }
    
    // Get total supply of the origin token
    const originSupply = await fetchTokenSupply(originChainInfo, traceResult.baseDenom);
    
    // Calculate how much of this token should be in various escrow accounts
    const escrowBalances = await calculateTotalEscrowBalances(
      traceResult.baseDenom,
      traceResult.originChain,
      traceResult.path
    );
    
    return {
      denom: token.denom,
      amount: token.amount,
      isNative: false,
      originChain: traceResult.originChain,
      originalDenom: traceResult.baseDenom,
      escrowBalance: token.amount,
      originBalance: originSupply,
      hops: traceResult.path.map(hop => ({
        fromChain: hop.chain,
        toChain: 'next-chain', // Would need to be calculated
        channelId: hop.channelId,
        portId: hop.portId
      })),
      traceComplete: true
    };
    
  } catch (error) {
    logger.error(`Failed to audit IBC token ${token.denom}: ${error}`);
    return {
      denom: token.denom,
      amount: token.amount,
      isNative: false,
      traceComplete: false
    };
  }
}

async function fetchTokenBalance(
  chainInfo: ChainInfo,
  address: string,
  denom: string
): Promise<string | null> {
  try {
    const balances = await makeRequest<{
      balances: Array<{ denom: string; amount: string }>;
    }>(chainInfo.apis.rest.map(api => api.address), `/cosmos/bank/v1beta1/balances/${address}`);
    
    const balance = balances.balances.find(b => b.denom === denom);
    return balance?.amount || null;
    
  } catch (error) {
    logger.error(`Failed to fetch balance for ${denom} at ${address}: ${error}`);
    return null;
  }
}

async function fetchTokenSupply(chainInfo: ChainInfo, denom: string): Promise<string> {
  try {
    const supply = await makeRequest<{
      amount: { denom: string; amount: string };
    }>(chainInfo.apis.rest.map(api => api.address), `/cosmos/bank/v1beta1/supply/by_denom?denom=${encodeURIComponent(denom)}`);
    
    return supply.amount.amount;
    
  } catch (error) {
    logger.error(`Failed to fetch supply for ${denom}: ${error}`);
    return '0';
  }
}

async function calculateTotalEscrowBalances(
  baseDenom: string,
  originChain: string,
  path: Array<{ chain: string; channelId: string; portId: string }>
): Promise<string> {
  // This would implement logic to calculate total escrow across all chains
  // For now, return a placeholder
  return '0';
}

function getEscrowAddress(chainInfo: ChainInfo, channelId: string): string {
  // Simplified escrow address generation - in practice this would use the actual IBC module logic
  const portId = 'transfer';
  return `${chainInfo.bech32_prefix}1escrow${channelId.replace('channel-', '')}`;
}

export { auditNativeToken, auditIbcToken };