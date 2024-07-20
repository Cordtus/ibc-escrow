const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const dotenv = require('dotenv');

dotenv.config();

const DATA_DIR = path.join(__dirname, 'data');
const IBC_DATA_DIR = path.join(DATA_DIR, 'ibc');
const CONFIG = require('./config.json');

const axiosInstance = axios.create({
  headers: {
    'Authorization': `token ${process.env.GITHUB_PAT}`,
    'Accept': 'application/vnd.github.v3+json'
  }
});

async function ensureDirectories() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(IBC_DATA_DIR, { recursive: true });
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

async function fetchIBCData() {
  try {
    const ibcDir = await axiosInstance.get(`https://api.github.com/repos/${CONFIG.github.owner}/${CONFIG.github.repo}/contents/_IBC`);
    
    for (const item of ibcDir.data) {
      if (item.type === 'file' && item.name.endsWith('.json')) {
        const fileContent = await axiosInstance.get(item.download_url);
        const [chain1, chain2] = item.name.replace('.json', '').split('-').sort();
        const fileName = `${chain1}-${chain2}.json`;
        await fs.writeFile(path.join(IBC_DATA_DIR, fileName), JSON.stringify(fileContent.data, null, 2));
        console.log(`IBC data for ${fileName} updated successfully.`);
      }
    }
  } catch (error) {
    console.error('Error fetching IBC data:', error.message);
    throw error;
  }
}

async function updateChainData(forceUpdate = false) {
  await ensureDirectories();

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

    // Fetch and update IBC data
    await fetchIBCData();

    await fs.writeFile(path.join(DATA_DIR, 'update_complete'), new Date().toISOString());
    console.log('Chain and IBC data update completed.');
  } catch (error) {
    console.error('Error updating data:', error.message);
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