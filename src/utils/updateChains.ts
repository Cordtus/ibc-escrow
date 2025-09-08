import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import AdmZip from 'adm-zip';
import logger from '../core/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface GitHubConfig {
  owner: string;
  repo: string;
}

interface AppConfig {
  github: GitHubConfig;
  api: {
    retries: number;
    delay: number;
  };
  paths: {
    dataDir: string;
  };
}

interface GitHubAsset {
  name: string;
  download_url: string;
  size: number;
}

interface GitHubRelease {
  tag_name: string;
  assets: GitHubAsset[];
  zipball_url: string;
  created_at: string;
}

interface DownloadProgress {
  downloaded: number;
  total: number;
  percentage: number;
}

export class ChainDataUpdater {
  private config: AppConfig;
  private dataDir: string;
  private headers: Record<string, string>;

  constructor() {
    this.config = { github: { owner: 'cosmos', repo: 'chain-registry' }, api: { retries: 3, delay: 250 }, paths: { dataDir: 'data' } };
    this.dataDir = path.join(process.cwd(), this.config.paths.dataDir);
    
    // Setup GitHub API headers
    this.headers = {
      'User-Agent': 'ibc-escrow-audit/1.0.0',
      'Accept': 'application/vnd.github.v3+json'
    };
    
    // Add GitHub PAT if available
    if (process.env.GITHUB_PAT) {
      this.headers['Authorization'] = `token ${process.env.GITHUB_PAT}`;
      logger.info('Using GitHub PAT for enhanced API limits');
    } else {
      logger.warn('No GitHub PAT provided, using limited API rate');
    }
  }

  private async loadConfig(): Promise<AppConfig> {
    try {
      const configPath = path.join(process.cwd(), 'config.json');
      const configFile = await fs.readFile(configPath, 'utf8');
      return JSON.parse(configFile) as AppConfig;
    } catch (error) {
      logger.warn(`Failed to load config, using defaults: ${error}`);
      return {
        github: { owner: 'cosmos', repo: 'chain-registry' },
        api: { retries: 3, delay: 250 },
        paths: { dataDir: 'data' }
      };
    }
  }

  async updateChains(forceUpdate: boolean = false): Promise<void> {
    const startTime = Date.now();
    logger.info(`Starting chain data update (force: ${forceUpdate})`);

    try {
      // Ensure data directories exist
      await this.ensureDirectories();

      // Check if we need to update
      if (!forceUpdate && await this.isUpdateRecent()) {
        logger.info('Chain data is recent, skipping update');
        return;
      }

      // Download and extract chain registry
      await this.downloadChainRegistry();

      // Post-process the data
      await this.processChainData();

      const duration = Date.now() - startTime;
      logger.performance('chain_data_update', duration, { forceUpdate });
      logger.info(`Chain data update completed in ${duration}ms`);

    } catch (error) {
      logger.error(`Chain data update failed: ${error}`);
      throw error;
    }
  }

  private async ensureDirectories(): Promise<void> {
    const dirs = [
      this.dataDir,
      path.join(this.dataDir, 'ibc'),
      path.join(this.dataDir, 'grpc-cache')
    ];

    for (const dir of dirs) {
      try {
        await fs.mkdir(dir, { recursive: true });
        logger.debug(`Ensured directory exists: ${dir}`);
      } catch (error) {
        logger.error(`Failed to create directory ${dir}: ${error}`);
        throw error;
      }
    }
  }

  private async isUpdateRecent(): Promise<boolean> {
    try {
      const updateFile = path.join(this.dataDir, '.last-update');
      const stats = await fs.stat(updateFile);
      const lastUpdate = stats.mtime.getTime();
      const now = Date.now();
      const hoursSinceUpdate = (now - lastUpdate) / (1000 * 60 * 60);
      
      logger.debug(`Last update: ${hoursSinceUpdate.toFixed(1)} hours ago`);
      return hoursSinceUpdate < 24; // Update once per day
    } catch {
      return false; // Update file doesn't exist
    }
  }

  private async downloadChainRegistry(): Promise<void> {
    logger.info('Downloading chain registry...');
    
    try {
      // Get the latest release or use main branch
      const downloadUrl = await this.getDownloadUrl();
      
      // Download the zip file
      const zipBuffer = await this.downloadWithProgress(downloadUrl);
      
      // Extract and process
      await this.extractChainRegistry(zipBuffer);
      
      // Mark update timestamp
      await this.markUpdateTime();
      
    } catch (error) {
      logger.error(`Failed to download chain registry: ${error}`);
      throw error;
    }
  }

  private async getDownloadUrl(): Promise<string> {
    const apiUrl = `https://api.github.com/repos/${this.config.github.owner}/${this.config.github.repo}/releases/latest`;
    
    try {
      const response = await axios.get<GitHubRelease>(apiUrl, { headers: this.headers });
      logger.info(`Using release: ${response.data.tag_name}`);
      return response.data.zipball_url;
    } catch (error) {
      logger.warn(`Failed to get latest release, using main branch: ${error}`);
      return `https://github.com/${this.config.github.owner}/${this.config.github.repo}/archive/refs/heads/main.zip`;
    }
  }

  private async downloadWithProgress(url: string): Promise<Buffer> {
    logger.info(`Downloading from ${url}`);
    
    const response = await axios.get(url, {
      headers: this.headers,
      responseType: 'arraybuffer',
      onDownloadProgress: (progress) => {
        if (progress.total) {
          const percentage = Math.round((progress.loaded / progress.total) * 100);
          if (percentage % 10 === 0) { // Log every 10%
            logger.debug(`Download progress: ${percentage}%`);
          }
        }
      }
    });

    logger.info(`Downloaded ${response.data.byteLength} bytes`);
    return Buffer.from(response.data);
  }

  private async extractChainRegistry(zipBuffer: Buffer): Promise<void> {
    logger.info('Extracting chain registry...');
    
    const zip = new AdmZip(zipBuffer);
    const entries = zip.getEntries();
    
    let extracted = 0;
    let skipped = 0;
    
    for (const entry of entries) {
      if (entry.isDirectory) continue;
      
      const entryPath = entry.entryName;
      let targetPath: string | null = null;
      
      // Extract chain files
      if (entryPath.match(/\/[^\/]+\.json$/) && !entryPath.includes('/')) {
        const fileName = path.basename(entryPath);
        targetPath = path.join(this.dataDir, fileName);
      }
      
      // Extract IBC files
      if (entryPath.includes('/_IBC/') && entryPath.endsWith('.json')) {
        const fileName = path.basename(entryPath);
        targetPath = path.join(this.dataDir, 'ibc', fileName);
      }
      
      if (targetPath) {
        try {
          const content = entry.getData();
          await fs.writeFile(targetPath, content);
          extracted++;
        } catch (error) {
          logger.warn(`Failed to extract ${entryPath}: ${error}`);
          skipped++;
        }
      } else {
        skipped++;
      }
    }
    
    logger.info(`Extraction complete: ${extracted} files extracted, ${skipped} files skipped`);
  }

  private async processChainData(): Promise<void> {
    logger.info('Processing chain data...');
    
    try {
      // Validate and clean up chain files
      const chainFiles = await fs.readdir(this.dataDir);
      const validChains = [];
      
      for (const file of chainFiles) {
        if (!file.endsWith('.json') || file.startsWith('.')) continue;
        
        const filePath = path.join(this.dataDir, file);
        try {
          const content = await fs.readFile(filePath, 'utf8');
          const chainData = JSON.parse(content);
          
          // Basic validation
          if (chainData.chain_name && chainData.apis) {
            validChains.push(chainData.chain_name);
          } else {
            logger.warn(`Invalid chain data in ${file}, removing...`);
            await fs.unlink(filePath);
          }
        } catch (error) {
          logger.warn(`Failed to process ${file}: ${error}`);
          await fs.unlink(filePath);
        }
      }
      
      logger.info(`Processed ${validChains.length} valid chains`);
      
      // Process IBC files
      const ibcDir = path.join(this.dataDir, 'ibc');
      const ibcFiles = await fs.readdir(ibcDir);
      let validIbcFiles = 0;
      
      for (const file of ibcFiles) {
        if (!file.endsWith('.json')) continue;
        
        const filePath = path.join(ibcDir, file);
        try {
          const content = await fs.readFile(filePath, 'utf8');
          const ibcData = JSON.parse(content);
          
          // Basic IBC validation
          if (ibcData.chain_1 && ibcData.chain_2 && ibcData.channels) {
            validIbcFiles++;
          } else {
            logger.warn(`Invalid IBC data in ${file}, removing...`);
            await fs.unlink(filePath);
          }
        } catch (error) {
          logger.warn(`Failed to process IBC file ${file}: ${error}`);
          await fs.unlink(filePath);
        }
      }
      
      logger.info(`Processed ${validIbcFiles} valid IBC files`);
      
    } catch (error) {
      logger.error(`Failed to process chain data: ${error}`);
      throw error;
    }
  }

  private async markUpdateTime(): Promise<void> {
    const updateFile = path.join(this.dataDir, '.last-update');
    await fs.writeFile(updateFile, new Date().toISOString());
  }

  async getUpdateStatus(): Promise<{
    lastUpdate: string | null;
    chainCount: number;
    ibcCount: number;
    cacheSize: number;
  }> {
    try {
      let lastUpdate: string | null = null;
      try {
        const updateFile = path.join(this.dataDir, '.last-update');
        lastUpdate = await fs.readFile(updateFile, 'utf8');
      } catch {
        // Update file doesn't exist
      }

      // Count chain files
      const chainFiles = await fs.readdir(this.dataDir);
      const chainCount = chainFiles.filter(f => f.endsWith('.json') && !f.startsWith('.')).length;

      // Count IBC files
      const ibcDir = path.join(this.dataDir, 'ibc');
      let ibcCount = 0;
      try {
        const ibcFiles = await fs.readdir(ibcDir);
        ibcCount = ibcFiles.filter(f => f.endsWith('.json')).length;
      } catch {
        // IBC directory doesn't exist
      }

      // Calculate cache size
      let cacheSize = 0;
      const cacheDir = path.join(this.dataDir, 'grpc-cache');
      try {
        const cacheFiles = await fs.readdir(cacheDir);
        for (const file of cacheFiles) {
          const stats = await fs.stat(path.join(cacheDir, file));
          cacheSize += stats.size;
        }
      } catch {
        // Cache directory doesn't exist
      }

      return { lastUpdate, chainCount, ibcCount, cacheSize };
    } catch (error) {
      logger.error(`Failed to get update status: ${error}`);
      throw error;
    }
  }
}

// CLI interface
export async function main(args: string[] = process.argv): Promise<void> {
  const forceUpdate = args.includes('-f') || args.includes('--force');
  
  const updater = new ChainDataUpdater();
  
  try {
    if (args.includes('--status')) {
      const status = await updater.getUpdateStatus();
      console.log('Chain Registry Status:');
      console.log(`  Last Update: ${status.lastUpdate || 'Never'}`);
      console.log(`  Chain Files: ${status.chainCount}`);
      console.log(`  IBC Files: ${status.ibcCount}`);
      console.log(`  Cache Size: ${(status.cacheSize / 1024 / 1024).toFixed(2)} MB`);
      return;
    }
    
    await updater.updateChains(forceUpdate);
    console.log('Chain data update completed successfully');
    
  } catch (error) {
    console.error('Chain data update failed:', error);
    process.exit(1);
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}