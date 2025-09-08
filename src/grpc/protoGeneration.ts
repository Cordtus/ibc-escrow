import { promises as fs } from 'fs';
import path from 'path';
import { Root, Type, Service, Method } from 'protobufjs';
import logger from '../core/logger.js';

export interface GeneratedService {
  serviceName: string;
  packageName: string;
  methods: GeneratedMethod[];
}

export interface GeneratedMethod {
  name: string;
  requestType: string;
  responseType: string;
  requestStream: boolean;
  responseStream: boolean;
  fullRequestType: string;
  fullResponseType: string;
}

export interface ProtoDefinitions {
  services: GeneratedService[];
  messages: Map<string, Type>;
  root: Root;
}

export class ProtoDefinitionGenerator {
  private root: Root = new Root();

  async generateFromDescriptors(
    descriptorProtos: Uint8Array[]
  ): Promise<ProtoDefinitions> {
    logger.info('Generating proto definitions from descriptors');

    try {
      // Load descriptors into protobuf.js Root
      for (const descriptorProto of descriptorProtos) {
        await this.loadDescriptorProto(descriptorProto);
      }

      // Extract services and methods
      const services = this.extractServices();
      const messages = this.extractMessages();

      logger.info(`Generated ${services.length} services and ${messages.size} message types`);

      return {
        services,
        messages,
        root: this.root
      };

    } catch (error) {
      logger.error(`Failed to generate proto definitions: ${error}`);
      throw error;
    }
  }

  private async loadDescriptorProto(descriptorProto: Uint8Array): Promise<void> {
    try {
      // This would normally use protobufjs descriptor loading
      // For now, we'll create a simplified version
      
      // In a real implementation, you would:
      // 1. Parse the FileDescriptorProto
      // 2. Extract services, messages, and enums
      // 3. Build the protobuf.js Root structure
      
      logger.debug('Loading descriptor proto (simplified implementation)');
      
    } catch (error) {
      logger.error(`Failed to load descriptor proto: ${error}`);
      throw error;
    }
  }

  private extractServices(): GeneratedService[] {
    const services: GeneratedService[] = [];

    // Walk through the root to find all services
    this.root.nestedArray.forEach(namespace => {
      if (namespace instanceof Service) {
        const service = this.processService(namespace);
        if (service) {
          services.push(service);
        }
      }
    });

    return services;
  }

  private processService(service: Service): GeneratedService | null {
    try {
      const methods: GeneratedMethod[] = [];

      // Extract methods from the service
      for (const [methodName, method] of Object.entries(service.methods)) {
        if (method instanceof Method) {
          methods.push({
            name: methodName,
            requestType: method.requestType,
            responseType: method.responseType,
            requestStream: method.requestStream || false,
            responseStream: method.responseStream || false,
            fullRequestType: method.resolvedRequestType?.fullName || method.requestType,
            fullResponseType: method.resolvedResponseType?.fullName || method.responseType
          });
        }
      }

      return {
        serviceName: service.name,
        packageName: service.parent?.fullName || '',
        methods
      };

    } catch (error) {
      logger.error(`Failed to process service ${service.name}: ${error}`);
      return null;
    }
  }

  private extractMessages(): Map<string, Type> {
    const messages = new Map<string, Type>();

    const walkNamespace = (ns: any, path: string = '') => {
      if (ns.nestedArray) {
        ns.nestedArray.forEach((nested: any) => {
          const fullPath = path ? `${path}.${nested.name}` : nested.name;
          
          if (nested instanceof Type) {
            messages.set(fullPath, nested);
          }
          
          // Recursively walk nested types
          if (nested.nestedArray) {
            walkNamespace(nested, fullPath);
          }
        });
      }
    };

    walkNamespace(this.root);
    return messages;
  }

  async generateTypeScriptDefinitions(
    definitions: ProtoDefinitions,
    outputPath: string
  ): Promise<void> {
    logger.info(`Generating TypeScript definitions to ${outputPath}`);

    try {
      let tsContent = `// Generated TypeScript definitions from gRPC reflection\n\n`;

      // Generate message type definitions
      definitions.messages.forEach((type, name) => {
        tsContent += this.generateMessageInterface(name, type);
      });

      // Generate service interfaces
      definitions.services.forEach(service => {
        tsContent += this.generateServiceInterface(service);
      });

      await fs.writeFile(outputPath, tsContent, 'utf8');
      logger.info(`TypeScript definitions written to ${outputPath}`);

    } catch (error) {
      logger.error(`Failed to generate TypeScript definitions: ${error}`);
      throw error;
    }
  }

  private generateMessageInterface(name: string, type: Type): string {
    let interfaceCode = `\nexport interface ${name} {\n`;

    if (type.fieldsArray) {
      type.fieldsArray.forEach(field => {
        const optional = field.optional ? '?' : '';
        const fieldType = this.mapProtoTypeToTypeScript(field.type);
        const repeated = field.repeated ? '[]' : '';
        
        interfaceCode += `  ${field.name}${optional}: ${fieldType}${repeated};\n`;
      });
    }

    interfaceCode += `}\n`;
    return interfaceCode;
  }

  private generateServiceInterface(service: GeneratedService): string {
    let serviceCode = `\nexport interface ${service.serviceName}Client {\n`;

    service.methods.forEach(method => {
      const requestType = method.fullRequestType;
      const responseType = method.fullResponseType;

      if (method.requestStream && method.responseStream) {
        // Bidirectional streaming
        serviceCode += `  ${method.name}(): ClientDuplexStream<${requestType}, ${responseType}>;\n`;
      } else if (method.requestStream) {
        // Client streaming
        serviceCode += `  ${method.name}(callback: (error: Error | null, response: ${responseType}) => void): ClientWritableStream<${requestType}>;\n`;
      } else if (method.responseStream) {
        // Server streaming
        serviceCode += `  ${method.name}(request: ${requestType}): ClientReadableStream<${responseType}>;\n`;
      } else {
        // Unary
        serviceCode += `  ${method.name}(request: ${requestType}, callback: (error: Error | null, response: ${responseType}) => void): void;\n`;
        serviceCode += `  ${method.name}(request: ${requestType}): Promise<${responseType}>;\n`;
      }
    });

    serviceCode += `}\n`;
    return serviceCode;
  }

  private mapProtoTypeToTypeScript(protoType: string): string {
    const typeMap: Record<string, string> = {
      'double': 'number',
      'float': 'number',
      'int32': 'number',
      'int64': 'string | number',
      'uint32': 'number', 
      'uint64': 'string | number',
      'sint32': 'number',
      'sint64': 'string | number',
      'fixed32': 'number',
      'fixed64': 'string | number',
      'sfixed32': 'number',
      'sfixed64': 'string | number',
      'bool': 'boolean',
      'string': 'string',
      'bytes': 'Uint8Array'
    };

    return typeMap[protoType] || protoType;
  }

  generateClientCode(service: GeneratedService): string {
    return `
// Generated client for ${service.serviceName}
import { credentials, ServiceDefinition, UntypedServiceImplementation } from '@grpc/grpc-js';

export class ${service.serviceName}GrpcClient {
  private client: any;

  constructor(endpoint: string, creds = credentials.createInsecure()) {
    // This would be populated with the actual service definition
    const serviceDefinition: ServiceDefinition = {
      // Service methods would be defined here
    };
    
    // Client initialization would happen here
    // this.client = new GrpcClient(endpoint, creds, serviceDefinition);
  }

  ${service.methods.map(method => this.generateMethodWrapper(method)).join('\n\n  ')}
}
`;
  }

  private generateMethodWrapper(method: GeneratedMethod): string {
    if (method.requestStream || method.responseStream) {
      return `${method.name}(...args: any[]): any {
    // Streaming method implementation
    return this.client.${method.name}(...args);
  }`;
    } else {
      return `async ${method.name}(request: ${method.fullRequestType}): Promise<${method.fullResponseType}> {
    return new Promise((resolve, reject) => {
      this.client.${method.name}(request, (error: any, response: any) => {
        if (error) reject(error);
        else resolve(response);
      });
    });
  }`;
    }
  }
}

export const protoGenerator = new ProtoDefinitionGenerator();