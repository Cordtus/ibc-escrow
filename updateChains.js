// updateChains.js
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const dotenv = require('dotenv');

dotenv.config();

const DATA_DIR = path.join(__dirname, 'data');
const CONFIG = require('./config.json');

const axiosInstance = axios.create({
  headers: {
    'Authorization': `token ${process.env.GITHUB_PAT}`,
    'Accept': 'application/vnd.github.v3+json'
  }
});

async function ensureDataDirectory() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
  } catch (error) {
    if (error.code !== 'EEXIST') {
      console.error('Error creating data directory:', error);
      throw error;
    }
  }
}

async function getLastCommitDate(filePath) {
  try {
    const response = await axiosInstance.get(`https://api.github.com/repos/${CONFIG.github.owner}/${CONFIG.github.repo}/commits`, {
      params: { path: filePath, per_page: 1 }
    });
    return new Date(response.data[0].commit.committer.date);
  } catch (error) {
    if (error.response && error.response.status === 404) {
      console.warn(`Warning: ${filePath} not found in the repository.`);
      return null;
    }
    throw error;
  }
}

async function updateChainData(forceUpdate = false) {
  await ensureDataDirectory();

  try {
    const dirs = await axiosInstance.get(`https://api.github.com/repos/${CONFIG.github.owner}/${CONFIG.github.repo}/contents`);
    
    for (const item of dirs.data) {
      if (item.type === 'dir' && !/^[._]/.test(item.name) && item.name !== 'testnets') {
        const remoteFilePath = `${item.name}/chain.json`;
        const localFilePath = path.join(DATA_DIR, `${item.name}.json`);

        let shouldUpdate = forceUpdate;

        if (!shouldUpdate) {
          try {
            const stats = await fs.stat(localFilePath);
            const localModTime = stats.mtime;
            const remoteLastCommit = await getLastCommitDate(remoteFilePath);
            
            if (remoteLastCommit && remoteLastCommit > localModTime) {
              shouldUpdate = true;
            }
          } catch (error) {
            // File doesn't exist locally, we should update
            shouldUpdate = true;
          }
        }

        if (shouldUpdate) {
          try {
            console.log(`Updating ${item.name}...`);
            const chainData = await axiosInstance.get(`https://raw.githubusercontent.com/${CONFIG.github.owner}/${CONFIG.github.repo}/master/${remoteFilePath}`);
            await fs.writeFile(localFilePath, JSON.stringify(chainData.data, null, 2));
            console.log(`${item.name} updated successfully.`);
          } catch (error) {
            if (error.response && error.response.status === 404) {
              console.warn(`Warning: ${item.name}/chain.json not found. Skipping this chain.`);
            } else {
              console.error(`Error updating ${item.name}:`, error.message);
            }
          }
        } else {
          console.log(`${item.name} is up to date.`);
        }

        // Respect rate limits
        await new Promise(resolve => setTimeout(resolve, CONFIG.api.delay));
      }
    }
    await fs.writeFile(path.join(DATA_DIR, 'update_complete'), new Date().toISOString());
    console.log('Chain data update completed.');
  } catch (error) {
    console.error('Error fetching repository contents:', error.message);
    throw error;
  }
}

module.exports = updateChainData;

if (require.main === module) {
  const forceUpdate = process.argv.includes('-f') || process.argv.includes('--force');
  updateChainData(forceUpdate).catch(error => {
    console.error('An unexpected error occurred:', error);
    process.exit(1);
  });
}