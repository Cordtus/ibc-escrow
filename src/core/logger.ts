import winston from 'winston';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface LogConfig {
  level: string;
  fileLogLevel: string;
}

interface AppConfig {
  logging: LogConfig;
  paths: {
    logsDir: string;
  };
}

// Ensure logs directory exists
const createLogsDirectory = async (logsDir: string): Promise<void> => {
  try {
    await fs.mkdir(logsDir, { recursive: true });
  } catch (error) {
    console.error('Failed to create logs directory:', error);
  }
};

// Load configuration
const loadConfig = async (): Promise<AppConfig> => {
  const configPath = path.join(process.cwd(), 'config.json');
  try {
    const configFile = await fs.readFile(configPath, 'utf8');
    return JSON.parse(configFile) as AppConfig;
  } catch (error) {
    // Fallback configuration
    return {
      logging: {
        level: 'info',
        fileLogLevel: 'error'
      },
      paths: {
        logsDir: 'logs'
      }
    };
  }
};

const config = await loadConfig();
const LOGS_DIR = path.join(process.cwd(), config.paths.logsDir);

// Create logs directory
await createLogsDirectory(LOGS_DIR);

// Custom format for console output
const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    const metaString = Object.keys(meta).length ? JSON.stringify(meta, null, 2) : '';
    return `${timestamp} [${level}]: ${message} ${metaString}`;
  })
);

// Custom format for file output
const fileFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

const logger = winston.createLogger({
  level: config.logging.level,
  defaultMeta: { service: 'ibc-escrow-audit' },
  transports: [
    // Console transport
    new winston.transports.Console({
      format: consoleFormat
    }),

    // Error log file
    new winston.transports.File({
      filename: path.join(LOGS_DIR, 'error.log'),
      level: config.logging.fileLogLevel,
      format: fileFormat,
      maxsize: 5242880, // 5MB
      maxFiles: 5
    }),

    // Combined log file
    new winston.transports.File({
      filename: path.join(LOGS_DIR, 'combined.log'),
      format: fileFormat,
      maxsize: 5242880, // 5MB
      maxFiles: 5
    })
  ],

  // Handle exceptions
  exceptionHandlers: [
    new winston.transports.File({
      filename: path.join(LOGS_DIR, 'exceptions.log'),
      format: fileFormat
    })
  ],

  // Handle rejections
  rejectionHandlers: [
    new winston.transports.File({
      filename: path.join(LOGS_DIR, 'rejections.log'),
      format: fileFormat
    })
  ]
});

// Add helper methods for structured logging
const extendedLogger = Object.assign(logger, {
  stream: {
    write: (message: string): void => {
      logger.info(message.trim());
    }
  },
  audit: (action: string, details: Record<string, unknown>): void => {
    logger.info('AUDIT', { action, ...details });
  },
  performance: (operation: string, duration: number, metadata?: Record<string, unknown>): void => {
    logger.info('PERFORMANCE', { operation, duration, ...metadata });
  },
  security: (event: string, details: Record<string, unknown>): void => {
    logger.warn('SECURITY', { event, ...details });
  }
});

export default extendedLogger;