import logger from '../../core/logger.js';

describe('Logger', () => {
  beforeEach(() => {
    // Reset any spies
    jest.clearAllMocks();
  });

  it('should have basic logging methods', () => {
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.debug).toBe('function');
  });

  it('should have extended logging methods', () => {
    expect(typeof logger.audit).toBe('function');
    expect(typeof logger.performance).toBe('function');
    expect(typeof logger.security).toBe('function');
  });

  it('should have stream interface', () => {
    expect(logger.stream).toBeDefined();
    expect(typeof logger.stream.write).toBe('function');
  });

  it('should log audit events with proper format', () => {
    const logSpy = jest.spyOn(logger, 'info').mockImplementation();
    
    logger.audit('test_action', { userId: '123', result: 'success' });
    
    expect(logSpy).toHaveBeenCalledWith('AUDIT', {
      action: 'test_action',
      userId: '123',
      result: 'success'
    });
  });

  it('should log performance metrics', () => {
    const logSpy = jest.spyOn(logger, 'info').mockImplementation();
    
    logger.performance('database_query', 150, { table: 'users' });
    
    expect(logSpy).toHaveBeenCalledWith('PERFORMANCE', {
      operation: 'database_query',
      duration: 150,
      table: 'users'
    });
  });

  it('should log security events as warnings', () => {
    const logSpy = jest.spyOn(logger, 'warn').mockImplementation();
    
    logger.security('failed_login', { username: 'test', ip: '127.0.0.1' });
    
    expect(logSpy).toHaveBeenCalledWith('SECURITY', {
      event: 'failed_login',
      username: 'test',
      ip: '127.0.0.1'
    });
  });

  it('should handle stream write properly', () => {
    const logSpy = jest.spyOn(logger, 'info').mockImplementation();
    
    logger.stream.write('Test message\n');
    
    expect(logSpy).toHaveBeenCalledWith('Test message');
  });
});