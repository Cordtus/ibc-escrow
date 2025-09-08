import { DescriptorCache } from '../../cache/descriptorCache.js';
import { promises as fs } from 'fs';

jest.mock('fs', () => ({
  promises: {
    mkdir: jest.fn(),
    readFile: jest.fn(),
    writeFile: jest.fn(),
    readdir: jest.fn(),
    stat: jest.fn(),
    unlink: jest.fn(),
    rmdir: jest.fn()
  }
}));

// Mock fetch globally
global.fetch = jest.fn();

const mockedFs = fs as jest.Mocked<typeof fs>;
const mockedFetch = fetch as jest.MockedFunction<typeof fetch>;

describe('DescriptorCache', () => {
  let cache: DescriptorCache;

  beforeEach(() => {
    jest.clearAllMocks();
    cache = new DescriptorCache();
    mockedFs.mkdir.mockResolvedValue(undefined);
  });

  describe('checkVersionNeedsUpdate', () => {
    const chainId = 'osmosis-1';
    const rpcEndpoint = 'http://rpc.osmosis.zone';
    const mockAbciResponse = {
      result: {
        response: {
          version: 'v15.0.0',
          data: 'osmosis',
          last_block_height: '12345678',
          last_block_app_hash: 'somehash'
        }
      }
    };

    it('should return needsUpdate=true for first-time chain', async () => {
      mockedFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockAbciResponse)
      } as Response);

      const result = await cache.checkVersionNeedsUpdate(chainId, rpcEndpoint);

      expect(result.needsUpdate).toBe(true);
      expect(result.currentVersion).toBe('v15.0.0');
      expect(mockedFetch).toHaveBeenCalledWith(`${rpcEndpoint}/abci_info`);
    });

    it('should return needsUpdate=false for same version within interval', async () => {
      // First call - simulate cached version info exists
      const now = Date.now();
      const cachedVersionInfo = {
        chainId,
        appVersion: 'v15.0.0',
        lastChecked: now - 1000 * 60 * 60, // 1 hour ago (within 24h interval)
        descriptorsUpdated: now - 1000 * 60 * 60 * 25 // 25 hours ago
      };

      // Mock the version cache to return existing info
      cache['versionCache'].set(`version-${chainId}`, cachedVersionInfo);

      const result = await cache.checkVersionNeedsUpdate(chainId, rpcEndpoint);

      expect(result.needsUpdate).toBe(false);
      expect(result.cachedVersion).toBe('v15.0.0');
      expect(mockedFetch).not.toHaveBeenCalled();
    });

    it('should return needsUpdate=true for version change', async () => {
      // Mock existing cached version
      const cachedVersionInfo = {
        chainId,
        appVersion: 'v14.0.0',
        lastChecked: Date.now() - 1000 * 60 * 60 * 25, // 25 hours ago (outside interval)
        descriptorsUpdated: Date.now() - 1000 * 60 * 60 * 25
      };

      cache['versionCache'].set(`version-${chainId}`, cachedVersionInfo);

      mockedFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockAbciResponse)
      } as Response);

      const result = await cache.checkVersionNeedsUpdate(chainId, rpcEndpoint);

      expect(result.needsUpdate).toBe(true);
      expect(result.currentVersion).toBe('v15.0.0');
      expect(result.cachedVersion).toBe('v14.0.0');
    });

    it('should handle fetch errors gracefully', async () => {
      mockedFetch.mockRejectedValueOnce(new Error('Network error'));

      const result = await cache.checkVersionNeedsUpdate(chainId, rpcEndpoint);

      expect(result.needsUpdate).toBe(true); // Default to update on error
    });

    it('should handle HTTP errors', async () => {
      mockedFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error'
      } as Response);

      await expect(cache.checkVersionNeedsUpdate(chainId, rpcEndpoint))
        .resolves.toEqual({ needsUpdate: true });
    });
  });

  describe('getDescriptorCache and setDescriptorCache', () => {
    const endpoint = 'grpc.osmosis.zone:9090';
    const mockCache = {
      endpoint,
      version: 'v15.0.0',
      lastChecked: Date.now(),
      reflection: {
        services: [],
        descriptors: [],
        packageDefinition: {}
      }
    };

    it('should retrieve cache from memory first', async () => {
      // Set in memory cache
      cache['memoryCache'].set('grpc-grpc-osmosis-zone-9090', mockCache);

      const result = await cache.getDescriptorCache(endpoint);

      expect(result).toEqual(mockCache);
      expect(mockedFs.readFile).not.toHaveBeenCalled();
    });

    it('should retrieve cache from disk if not in memory', async () => {
      mockedFs.readFile.mockResolvedValueOnce(JSON.stringify(mockCache));

      const result = await cache.getDescriptorCache(endpoint);

      expect(result).toEqual(mockCache);
      expect(mockedFs.readFile).toHaveBeenCalled();
    });

    it('should return null if no cache exists', async () => {
      mockedFs.readFile.mockRejectedValueOnce(new Error('File not found'));

      const result = await cache.getDescriptorCache(endpoint);

      expect(result).toBeNull();
    });

    it('should save cache to both memory and disk', async () => {
      mockedFs.writeFile.mockResolvedValueOnce(undefined);

      await cache.setDescriptorCache(endpoint, mockCache);

      // Check memory cache
      const memoryCached = cache['memoryCache'].get('grpc-grpc-osmosis-zone-9090');
      expect(memoryCached).toEqual(mockCache);

      // Check disk write
      expect(mockedFs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('grpc-grpc-osmosis-zone-9090.json'),
        JSON.stringify(mockCache, null, 2),
        'utf8'
      );
    });
  });

  describe('getCacheStats', () => {
    it('should return cache statistics', async () => {
      // Mock some cache entries
      cache['memoryCache'].set('key1', {} as any);
      cache['memoryCache'].set('key2', {} as any);
      cache['versionCache'].set('version1', {} as any);

      // Mock file system stats
      mockedFs.readdir.mockResolvedValueOnce(['cache1.json', 'cache2.json'] as any);
      mockedFs.stat
        .mockResolvedValueOnce({ size: 1024 } as any)
        .mockResolvedValueOnce({ size: 2048 } as any);

      const stats = await cache.getCacheStats();

      expect(stats.memoryEntries).toBe(2);
      expect(stats.versionEntries).toBe(1);
      expect(stats.diskCacheSize).toBe(3072);
    });

    it('should handle disk read errors', async () => {
      mockedFs.readdir.mockRejectedValueOnce(new Error('Directory not found'));

      const stats = await cache.getCacheStats();

      expect(stats.diskCacheSize).toBe(0);
    });
  });

  describe('clearCache', () => {
    it('should clear specific endpoint cache', async () => {
      const endpoint = 'grpc.osmosis.zone:9090';
      cache['memoryCache'].set('grpc-grpc-osmosis-zone-9090', {} as any);
      mockedFs.unlink.mockResolvedValueOnce(undefined);

      await cache.clearCache(endpoint);

      expect(cache['memoryCache'].has('grpc-grpc-osmosis-zone-9090')).toBe(false);
      expect(mockedFs.unlink).toHaveBeenCalled();
    });

    it('should clear all caches when no endpoint specified', async () => {
      cache['memoryCache'].set('key1', {} as any);
      cache['versionCache'].set('version1', {} as any);
      mockedFs.rmdir.mockResolvedValueOnce(undefined);

      await cache.clearCache();

      expect(cache['memoryCache'].size).toBe(0);
      expect(cache['versionCache'].size).toBe(0);
      expect(mockedFs.rmdir).toHaveBeenCalled();
    });
  });
});