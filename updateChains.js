// updateChains.js
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import dotenv from 'dotenv';
import AdmZip from 'adm-zip';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, 'data');
const IBC_DATA_DIR = path.join(DATA_DIR, 'ibc');

// Load config file
const configPath = path.join(__dirname, 'config.json');
const CONFIG = JSON.parse(await fs.readFile(configPath, 'utf8'));

const axiosInstance = axios.create({
  headers: {
    Authorization: `token ${process.env.GITHUB_PAT}`,
    Accept: 'application/vnd.github.v3+json',
  },
});

/**
 * Create data directories if not present.
 */
async function ensureDirectories() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(IBC_DATA_DIR, { recursive: true });
}

/**
 * Fetch the most recent commit date for the entire repo (not per file).
 * We'll use this to compare against local "update_complete" timestamp.
 */
async function getLastRepoCommitDate() {
  try {
    const response = await axiosInstance.get(
      `https://api.github.com/repos/${CONFIG.github.owner}/${CONFIG.github.repo}/commits`,
      {
        params: { per_page: 1 },
      }
    );
    return new Date(response.data[0].commit.committer.date);
  } catch (error) {
    console.error('Error fetching last commit date:', error.message);
    return null;
  }
}

/**
 * Download the repo as a zipball (one call), and unzip it into a temporary directory.
 * Returns the path to the unzipped folder containing the repo files.
 */
async function downloadAndUnzipRepo() {
  console.log(`Downloading ZIP for ${CONFIG.github.owner}/${CONFIG.github.repo}. This can take a few minutes...`);
  const response = await axiosInstance.get(
    `https://api.github.com/repos/${CONFIG.github.owner}/${CONFIG.github.repo}/zipball`,
    { responseType: 'arraybuffer' }
  );

  // Write the buffer to a temp ZIP file
  const tempZipPath = path.join(__dirname, 'temp_repo.zip');
  await fs.writeFile(tempZipPath, response.data);

  // Unzip using adm-zip
  const zip = new AdmZip(tempZipPath);
  const tempExtractPath = path.join(__dirname, 'temp_extracted');
  // Clear out anything that might've been in temp_extracted from a previous run
  await fs.rm(tempExtractPath, { recursive: true, force: true });
  zip.extractAllTo(tempExtractPath, true);

  // Clean up the downloaded zip
  await fs.rm(tempZipPath, { force: true });

  /**
   * GitHub’s zipball typically creates a folder named something like:
   *   cosmos-chain-registry-<commitHash>/
   * inside `tempExtractPath`.
   * We need to find that folder so we know where to read chain.json files, etc.
   */
  const extractedDirs = await fs.readdir(tempExtractPath, { withFileTypes: true });
  const repoFolder = extractedDirs.find((dirent) => dirent.isDirectory());
  if (!repoFolder) {
    throw new Error('Could not find unzipped repo directory');
  }

  const unzippedRepoPath = path.join(tempExtractPath, repoFolder.name);
  return unzippedRepoPath;
}

/**
 * Read local chain.json files from the unzipped repo, and copy them to data/.
 */
async function processChains(unzippedRepoPath, forceUpdate) {
  const dirs = await fs.readdir(unzippedRepoPath, { withFileTypes: true });

  for (const item of dirs) {
    // Skip hidden directories, _IBC, testnets, etc.
    if (
      item.isDirectory() &&
      !item.name.startsWith('.') &&
      !item.name.startsWith('_') &&
      item.name !== 'testnets'
    ) {
      const chainDir = path.join(unzippedRepoPath, item.name);
      const remoteFilePath = path.join(chainDir, 'chain.json');
      const localFilePath = path.join(DATA_DIR, `${item.name}.json`);

      // Decide whether to update
      let shouldUpdate = forceUpdate;
      if (!shouldUpdate) {
        // If we don't have the local file, we should update
        try {
          await fs.access(localFilePath);
          // If it exists and not forced, skip
          console.log(`${item.name} is up to date (local file exists).`);
          continue;
        } catch {
          shouldUpdate = true;
        }
      }

      if (shouldUpdate) {
        try {
          console.log(`Updating ${item.name}...`);
          const chainData = await fs.readFile(remoteFilePath, 'utf8');
          await fs.writeFile(localFilePath, chainData, 'utf8');
          console.log(`${item.name} updated successfully.`);
        } catch (error) {
          console.error(`Error updating ${item.name}:`, error.message);
        }
      }

      // Optional: respect the delay from config
      await new Promise((resolve) => setTimeout(resolve, CONFIG.api.delay));
    }
  }
}

/**
 * Process IBC data from the local `_IBC` folder in the unzipped repo,
 * then copy it to data/ibc/.
 */
async function processIBC(unzippedRepoPath) {
  const ibcDir = path.join(unzippedRepoPath, '_IBC');
  let ibcEntries;

  try {
    ibcEntries = await fs.readdir(ibcDir, { withFileTypes: true });
  } catch (error) {
    console.warn(`No _IBC folder found in ${unzippedRepoPath}, skipping IBC step.`);
    return;
  }

  for (const entry of ibcEntries) {
    if (entry.isFile() && entry.name.endsWith('.json')) {
      const filePath = path.join(ibcDir, entry.name);
      try {
        const fileContent = await fs.readFile(filePath, 'utf8');
        const [chain1, chain2] = entry.name.replace('.json', '').split('-').sort();
        const destFilename = `${chain1}-${chain2}.json`;
        await fs.writeFile(path.join(IBC_DATA_DIR, destFilename), fileContent, 'utf8');
        console.log(`Registered IBC channels from ${destFilename}.`);
      } catch (err) {
        console.error(`Error reading IBC file: ${filePath}`, err.message);
      }
    }
  }
}

/**
 * Main function to update chain data and IBC data from the repo ZIP.
 */
async function updateChainData(forceUpdate = false) {
  await ensureDirectories();

  // If not forced, check if there's a new commit since our last update
  let newCommitAvailable = true;
  if (!forceUpdate) {
    const lastCommitDate = await getLastRepoCommitDate();
    if (lastCommitDate) {
      // Compare with local "update_complete" file if exists
      const updateCompletePath = path.join(DATA_DIR, 'update_complete');
      try {
        const stats = await fs.stat(updateCompletePath);
        const localModTime = stats.mtime;
        // If local is newer or equal, presumably up-to-date
        if (localModTime >= lastCommitDate) {
          newCommitAvailable = false;
        }
      } catch {
        // Means we have no update_complete file yet, so let's proceed
      }
    }
  }

  // If forced or a new commit is available, download/unzip and process
  if (forceUpdate || newCommitAvailable) {
    try {
      const unzippedRepoPath = await downloadAndUnzipRepo();

      // Process chain.json files
      await processChains(unzippedRepoPath, forceUpdate);

      // Process IBC data
      await processIBC(unzippedRepoPath);

      // Write the update_complete file
      await fs.writeFile(
        path.join(DATA_DIR, 'update_complete'),
        new Date().toISOString(),
        'utf8'
      );
      console.log('Update completed.');
    } catch (error) {
      console.error('Error during repository update:', error.message);
      throw error;
    }
  } else {
    console.log('No new commits found. Your data is up to date.');
  }
}

export default updateChainData;

// Handle script execution
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const forceUpdate = process.argv.includes('-f') || process.argv.includes('--force');
  updateChainData(forceUpdate).catch((error) => {
    console.error('An unexpected error occurred:', error);
    process.exit(1);
  });
}
