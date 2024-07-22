// chainUtils.js
import axios from 'axios';
import { promises as fs } from 'fs';
import path from 'path';
import logger from './logger.js';

async function makeRequest(endpoints, path, method = 'get', payload = null) {
  logger.info(`Making API request to path: ${path}`);
  const maxRetries = 3;
  const delay = 250;

  for (let i = 0; i < maxRetries; i++) {
    for (const endpoint of endpoints) {
      const url = `${endpoint}${path}`;
      logger.info(`Attempting request to: ${url}`);
      try {
        const response = await axios({
          method,
          url,
          data: payload,
        });
        logger.info(`Successful response from ${url}`);
        return response.data;
      } catch (error) {
        const status = error.response ? error.response.status : 'Unknown';
        logger.error(`Error fetching data from ${url}:`, {
          error: error.message,
          status: status,
          data: error.response ? error.response.data : 'No data',
        });
      }
    }
    if (i < maxRetries - 1) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error(`All endpoints failed for path: ${path}`);
}

async function loadChainInfo(chainName) {
  logger.info(`Loading chain info for: ${chainName}`);
  const filePath = path.join(process.cwd(), 'data', `${chainName}.json`);
  try {
    const data = await fs.readFile(filePath, 'utf8');
    logger.info(`Chain info loaded successfully for: ${chainName}`);
    return JSON.parse(data);
  } catch (error) {
    logger.error(`Error loading chain info for ${chainName}:`, {
      error: error.message,
    });
    return null;
  }
}

export { makeRequest, loadChainInfo };
