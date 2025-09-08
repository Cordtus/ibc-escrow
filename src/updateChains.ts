#!/usr/bin/env node

import { main } from './utils/updateChains.js';

// This is the main entry point for the updateChains script
main(process.argv).catch(console.error);