import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { LRUCache } from 'lru-cache';
import logger from '../core/logger.js';
import type { GrpcCache, AbciInfoResponse, ChainVersionInfo } from '../types/index.js';

// Use built-in fetch (Node.js 18+)

const CACHE_DIR = path.join(process.cwd(), 'data', 'grpc-cache');
const VERSION_CHECK_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours

export class DescriptorCache {
  private memoryCache: LRUCache<string, GrpcCache>;
  private versionCache: LRUCache<string, ChainVersionInfo>;

  constructor() {
    this.memoryCache = new LRUCache<string, GrpcCache>({
      max: 100,
      ttl: 1000 * 60 * 60 * 24, // 24 hours
    });

    this.versionCache = new LRUCache<string, ChainVersionInfo>({
      max: 200,
      ttl: 1000 * 60 * 60 * 6, // 6 hours
    });

    this.ensureCacheDir();
  }

  private async ensureCacheDir(): Promise<void> {
    try {
      await fs.mkdir(CACHE_DIR, { recursive: true });
    } catch (error) {
      logger.error(`Failed to create cache directory: ${error}`);
    }
  }

  private getCacheKey(endpoint: string): string {
    return `grpc-${endpoint.replace(/[^a-zA-Z0-9]/g, '-')}`;
  }

  private getVersionKey(chainId: string): string {
    return `version-${chainId}`;
  }

  private getCacheFilePath(key: string): string {
    return path.join(CACHE_DIR, `${key}.json`);
  }

  async getDescriptorCache(endpoint: string): Promise<GrpcCache | null> {
    const key = this.getCacheKey(endpoint);

    // Try memory cache first
    const memoryResult = this.memoryCache.get(key);
    if (memoryResult) {
      logger.debug(`Found gRPC cache in memory for ${endpoint}`);
      return memoryResult;
    }

    // Try disk cache
    try {
      const filePath = this.getCacheFilePath(key);
      const data = await fs.readFile(filePath, 'utf8');
      const cached: GrpcCache = JSON.parse(data);

      // Repopulate memory cache
      this.memoryCache.set(key, cached);
      logger.debug(`Loaded gRPC cache from disk for ${endpoint}`);
      return cached;
    } catch (error) {
      logger.debug(`No cached descriptors found for ${endpoint}: ${error}`);
      return null;
    }
  }

  async setDescriptorCache(endpoint: string, cache: GrpcCache): Promise<void> {
    const key = this.getCacheKey(endpoint);

    // Update memory cache
    this.memoryCache.set(key, cache);

    // Update disk cache
    try {
      const filePath = this.getCacheFilePath(key);
      await fs.writeFile(filePath, JSON.stringify(cache, null, 2), 'utf8');
      logger.debug(`Saved gRPC cache to disk for ${endpoint}`);
    } catch (error) {
      logger.error(`Failed to save gRPC cache for ${endpoint}: ${error}`);
    }
  }

  async checkVersionNeedsUpdate(
    chainId: string,
    rpcEndpoint: string
  ): Promise<{ needsUpdate: boolean; currentVersion?: string; cachedVersion?: string }> {
    const versionKey = this.getVersionKey(chainId);
    const cachedVersionInfo = this.versionCache.get(versionKey);

    // If we haven't checked recently, get the current version
    const now = Date.now();
    if (!cachedVersionInfo || (now - cachedVersionInfo.lastChecked) > VERSION_CHECK_INTERVAL) {
      try {
        const currentVersion = await this.fetchChainVersion(rpcEndpoint);

        if (!cachedVersionInfo) {
          // First time checking this chain
          const newVersionInfo: ChainVersionInfo = {
            chainId,
            appVersion: currentVersion,
            lastChecked: now,
            descriptorsUpdated: now,
          };
          this.versionCache.set(versionKey, newVersionInfo);
          await this.saveVersionInfo(chainId, newVersionInfo);
          return { needsUpdate: true, currentVersion };
        }

        const needsUpdate = currentVersion !== cachedVersionInfo.appVersion;
        const updatedVersionInfo: ChainVersionInfo = {
          ...cachedVersionInfo,
          lastChecked: now,
          ...(needsUpdate && {
            appVersion: currentVersion,
            descriptorsUpdated: now
          })
        };

        this.versionCache.set(versionKey, updatedVersionInfo);
        await this.saveVersionInfo(chainId, updatedVersionInfo);

        return {
          needsUpdate,
          currentVersion,
          cachedVersion: cachedVersionInfo.appVersion
        };

      } catch (error) {
        logger.warn(`Failed to check version for ${chainId}: ${error}`);
        // If version check fails, don't update unless we have no cache at all
        return { needsUpdate: !cachedVersionInfo };
      }
    }

    // Version was checked recently, no need to update
    return { needsUpdate: false, cachedVersion: cachedVersionInfo.appVersion };
  }

  private async fetchChainVersion(rpcEndpoint: string): Promise<string> {
    const url = `${rpcEndpoint}/abci_info`;
    logger.debug(`Fetching version from ${url}`);

    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json() as AbciInfoResponse;
      return data.result.response.version;
    } catch (error) {
      throw new Error(`Failed to fetch chain version from ${url}: ${error}`);
    }
  }

  private async saveVersionInfo(chainId: string, versionInfo: ChainVersionInfo): Promise<void> {
    try {
      const versionFilePath = path.join(CACHE_DIR, 'versions.json');
      let versions: Record<string, ChainVersionInfo> = {};

      try {
        const data = await fs.readFile(versionFilePath, 'utf8');
        versions = JSON.parse(data);
      } catch {
        // File doesn't exist, start with empty object
      }

      versions[chainId] = versionInfo;
      await fs.writeFile(versionFilePath, JSON.stringify(versions, null, 2), 'utf8');
    } catch (error) {
      logger.warn(`Failed to save version info for ${chainId}: ${error}`);
    }
  }

  async loadVersionInfo(chainId: string): Promise<ChainVersionInfo | null> {
    const versionKey = this.getVersionKey(chainId);

    // Try memory cache first
    const memoryResult = this.versionCache.get(versionKey);
    if (memoryResult) {
      return memoryResult;
    }

    // Try disk cache
    try {
      const versionFilePath = path.join(CACHE_DIR, 'versions.json');
      const data = await fs.readFile(versionFilePath, 'utf8');
      const versions: Record<string, ChainVersionInfo> = JSON.parse(data);
      const versionInfo = versions[chainId];

      if (versionInfo) {
        this.versionCache.set(versionKey, versionInfo);
        return versionInfo;
      }
    } catch (error) {
      logger.debug(`No cached version info found for ${chainId}: ${error}`);
    }

    return null;
  }

  async clearCache(endpoint?: string): Promise<void> {
    if (endpoint) {
      const key = this.getCacheKey(endpoint);
      this.memoryCache.delete(key);

      try {
        const filePath = this.getCacheFilePath(key);
        await fs.unlink(filePath);
        logger.info(`Cleared cache for ${endpoint}`);
      } catch (error) {
        logger.debug(`No cache file to delete for ${endpoint}: ${error}`);
      }
    } else {
      // Clear all caches
      this.memoryCache.clear();
      this.versionCache.clear();

      try {
        await fs.rmdir(CACHE_DIR, { recursive: true });
        await this.ensureCacheDir();
        logger.info('Cleared all gRPC caches');
      } catch (error) {
        logger.error(`Failed to clear all caches: ${error}`);
      }
    }
  }

  async getCacheStats(): Promise<{
    memoryEntries: number;
    versionEntries: number;
    diskCacheSize: number;
  }> {
    const memoryEntries = this.memoryCache.size;
    const versionEntries = this.versionCache.size;

    let diskCacheSize = 0;
    try {
      const files = await fs.readdir(CACHE_DIR);
      for (const file of files) {
        const stats = await fs.stat(path.join(CACHE_DIR, file));
        diskCacheSize += stats.size;
      }
    } catch (error) {
      logger.debug(`Failed to calculate disk cache size: ${error}`);
    }

    return { memoryEntries, versionEntries, diskCacheSize };
  }
}

// Singleton instance
export const descriptorCache = new DescriptorCache();