import { Client, credentials, ServiceDefinition } from '@grpc/grpc-js';
import { loadPackageDefinition } from '@grpc/grpc-js';
import { load } from '@grpc/proto-loader';
import logger from '../core/logger.js';
import { descriptorCache } from '../cache/descriptorCache.js';
import type {
  GrpcCache,
  ReflectionResponse,
  ServiceInfo,
  MethodInfo,
  GrpcClientConfig,
  FileDescriptor
} from '../types/grpc.js';

export class GrpcReflectionClient {
  private clients: Map<string, Client> = new Map();
  private config: GrpcClientConfig;

  constructor(config: Partial<GrpcClientConfig> = {}) {
    this.config = {
      endpoint: '',
      credentials: 'insecure',
      maxRetries: 3,
      timeout: 30000,
      keepAlive: true,
      ...config
    };
  }

  async getOrCreateClient(endpoint: string): Promise<Client> {
    const existing = this.clients.get(endpoint);
    if (existing) {
      return existing;
    }

    const clientCredentials = this.config.credentials === 'ssl'
      ? credentials.createSsl()
      : credentials.createInsecure();

    const client = new Client(endpoint, clientCredentials, {
      'grpc.keepalive_time_ms': 30000,
      'grpc.keepalive_timeout_ms': 5000,
      'grpc.keepalive_permit_without_calls': 1,
      'grpc.http2.max_pings_without_data': 0,
      'grpc.http2.min_time_between_pings_ms': 10000,
      'grpc.http2.min_ping_interval_without_data_ms': 300000
    });

    this.clients.set(endpoint, client);
    return client;
  }

  async getReflectionData(
    grpcEndpoint: string,
    chainId: string,
    rpcEndpoint?: string
  ): Promise<ReflectionResponse> {
    logger.info(`Getting reflection data for ${grpcEndpoint} (chain: ${chainId})`);

    // Check if we need to update descriptors based on chain version
    if (rpcEndpoint) {
      const versionCheck = await descriptorCache.checkVersionNeedsUpdate(chainId, rpcEndpoint);

      if (versionCheck.needsUpdate) {
        logger.info(`Chain version changed or no cache found for ${chainId}, fetching new descriptors`);
        if (versionCheck.currentVersion && versionCheck.cachedVersion) {
          logger.info(`Version changed: ${versionCheck.cachedVersion} -> ${versionCheck.currentVersion}`);
        }
      } else {
        // Try to get from cache
        const cached = await descriptorCache.getDescriptorCache(grpcEndpoint);
        if (cached) {
          logger.info(`Using cached reflection data for ${grpcEndpoint}`);
          return cached.reflection;
        }
      }
    }

    // Fetch fresh data from reflection service
    const reflection = await this.fetchFromReflection(grpcEndpoint);

    // Cache the results
    const cacheEntry: GrpcCache = {
      endpoint: grpcEndpoint,
      version: '', // Will be filled by version check
      lastChecked: Date.now(),
      reflection
    };

    await descriptorCache.setDescriptorCache(grpcEndpoint, cacheEntry);

    logger.info(`Successfully fetched and cached reflection data for ${grpcEndpoint}`);
    return reflection;
  }

  private async fetchFromReflection(endpoint: string): Promise<ReflectionResponse> {
    logger.debug(`Fetching reflection data from ${endpoint}`);

    try {
      // Load the reflection proto definition
      const reflectionProtoPath = await this.getReflectionProtoPath();
      const packageDefinition = await load(reflectionProtoPath, {
        keepCase: true,
        longs: String,
        enums: String,
        defaults: true,
        oneofs: true
      });

      const reflectionPackage = loadPackageDefinition(packageDefinition);
      const client = await this.getOrCreateClient(endpoint);

      // Use the reflection service to list all services
      const services = await this.listServices(client, reflectionPackage);
      const descriptors: FileDescriptor[] = [];

      // For each service, get its file descriptors
      for (const service of services) {
        const serviceDescriptors = await this.getFileDescriptorsForService(
          client,
          reflectionPackage,
          service.name
        );
        descriptors.push(...serviceDescriptors);
      }

      return {
        services,
        descriptors,
        packageDefinition: packageDefinition
      };

    } catch (error) {
      logger.error(`Failed to fetch reflection data from ${endpoint}: ${error}`);
      throw new Error(`Reflection failed for ${endpoint}: ${error}`);
    }
  }

  private async listServices(client: Client, reflectionPackage: any): Promise<ServiceInfo[]> {
    return new Promise((resolve, reject) => {
      // This is a simplified implementation - in practice you'd use the actual
      // reflection protocol to enumerate services
      const reflectionClient = new (reflectionPackage.grpc.reflection.v1alpha.ServerReflection as any)(
        client.getChannel()
      );

      const stream = reflectionClient.ServerReflectionInfo();

      stream.write({
        list_services: "*"
      });

      stream.on('data', (response: any) => {
        if (response.list_services_response) {
          const services: ServiceInfo[] = response.list_services_response.service.map((svc: any) => ({
            name: svc.name,
            methods: [], // Will be filled later
            packageName: this.extractPackageName(svc.name)
          }));
          resolve(services);
        }
      });

      stream.on('error', (error: any) => {
        logger.error(`Reflection list services error: ${error}`);
        reject(error);
      });

      stream.end();
    });
  }

  private async getFileDescriptorsForService(
    client: Client,
    reflectionPackage: any,
    serviceName: string
  ): Promise<FileDescriptor[]> {
    return new Promise((resolve, reject) => {
      const reflectionClient = new (reflectionPackage.grpc.reflection.v1alpha.ServerReflection as any)(
        client.getChannel()
      );

      const stream = reflectionClient.ServerReflectionInfo();

      stream.write({
        file_containing_symbol: serviceName
      });

      stream.on('data', (response: any) => {
        if (response.file_descriptor_response) {
          const descriptors = this.parseFileDescriptors(
            response.file_descriptor_response.file_descriptor_proto
          );
          resolve(descriptors);
        }
      });

      stream.on('error', (error: any) => {
        logger.error(`Reflection file descriptor error for ${serviceName}: ${error}`);
        reject(error);
      });

      stream.end();
    });
  }

  private parseFileDescriptors(descriptorProtos: Uint8Array[]): FileDescriptor[] {
    // This would parse the protobuf descriptors - simplified implementation
    return descriptorProtos.map((proto, index) => ({
      name: `descriptor_${index}.proto`,
      package: '',
      dependencies: [],
      services: [],
      messages: [],
      enums: []
    }));
  }

  private extractPackageName(serviceName: string): string {
    const parts = serviceName.split('.');
    return parts.slice(0, -1).join('.');
  }

  private async getReflectionProtoPath(): Promise<string> {
    // In practice, you'd either bundle the reflection proto files
    // or dynamically download them
    return 'grpc/reflection/v1alpha/reflection.proto';
  }

  async makeUnaryCall<TRequest, TResponse>(
    endpoint: string,
    serviceName: string,
    methodName: string,
    request: TRequest
  ): Promise<TResponse> {
    const client = await this.getOrCreateClient(endpoint);

    return new Promise((resolve, reject) => {
      // This would use the actual service definition to make the call
      // Implementation depends on having the service definitions from reflection
      const timeout = setTimeout(() => {
        reject(new Error(`Request timeout after ${this.config.timeout}ms`));
      }, this.config.timeout);

      try {
        // Placeholder - would use actual service method
        const result = {} as TResponse;
        clearTimeout(timeout);
        resolve(result);
      } catch (error) {
        clearTimeout(timeout);
        reject(error);
      }
    });
  }

  async close(endpoint?: string): Promise<void> {
    if (endpoint) {
      const client = this.clients.get(endpoint);
      if (client) {
        client.close();
        this.clients.delete(endpoint);
      }
    } else {
      // Close all clients
      for (const [endpoint, client] of this.clients) {
        client.close();
        this.clients.delete(endpoint);
      }
    }
  }
}

// Singleton instance
export const grpcReflection = new GrpcReflectionClient();