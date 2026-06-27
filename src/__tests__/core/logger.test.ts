import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import logger from '../../core/logger.js';

describe('logger', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('exposes base and structured logging methods', () => {
    assert.equal(typeof logger.info, 'function');
    assert.equal(typeof logger.error, 'function');
    assert.equal(typeof logger.warn, 'function');
    assert.equal(typeof logger.debug, 'function');
    assert.equal(typeof logger.audit, 'function');
    assert.equal(typeof logger.performance, 'function');
    assert.equal(typeof logger.security, 'function');
    assert.equal(typeof logger.stream.write, 'function');
  });

  it('formats audit, performance, security, and stream helper events', () => {
    const info = mock.method(logger, 'info', () => logger);
    const warn = mock.method(logger, 'warn', () => logger);

    logger.audit('test_action', { result: 'success' });
    logger.performance('database_query', 150, { table: 'users' });
    logger.security('failed_login', { username: 'test' });
    logger.stream.write('Test message\n');

    assert.deepEqual(info.mock.calls[0].arguments, [
      'AUDIT',
      { action: 'test_action', result: 'success' },
    ]);
    assert.deepEqual(info.mock.calls[1].arguments, [
      'PERFORMANCE',
      { operation: 'database_query', duration: 150, table: 'users' },
    ]);
    assert.deepEqual(warn.mock.calls[0].arguments, [
      'SECURITY',
      { event: 'failed_login', username: 'test' },
    ]);
    assert.deepEqual(info.mock.calls[2].arguments, ['Test message']);
  });
});
