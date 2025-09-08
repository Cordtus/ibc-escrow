import { ServiceDefinition, MethodDefinition } from '@grpc/grpc-js';

export interface GrpcEndpointInfo {
  address: string;
  provider?: string;
}

export interface ServiceInfo {
  name: string;
  methods: MethodInfo[];
  packageName: string;
}

export interface MethodInfo {
  name: string;
  requestType: string;
  responseType: string;
  requestStream: boolean;
  responseStream: boolean;
  options?: Record<string, unknown>;
}

export interface ReflectionResponse {
  services: ServiceInfo[];
  descriptors: FileDescriptor[];
  packageDefinition: Record<string, unknown>;
}

export interface FileDescriptor {
  name: string;
  package: string;
  dependencies: string[];
  services: ServiceInfo[];
  messages: MessageDescriptor[];
  enums: EnumDescriptor[];
}

export interface MessageDescriptor {
  name: string;
  fields: FieldDescriptor[];
  fullName: string;
}

export interface FieldDescriptor {
  name: string;
  number: number;
  type: string;
  label: string;
  typeName?: string;
  defaultValue?: unknown;
  jsonName?: string;
}

export interface EnumDescriptor {
  name: string;
  values: EnumValueDescriptor[];
  fullName: string;
}

export interface EnumValueDescriptor {
  name: string;
  number: number;
}

export interface GrpcCache {
  endpoint: string;
  version: string;
  lastChecked: number;
  reflection: ReflectionResponse;
}

export interface AbciInfoResponse {
  jsonrpc: string;
  id: number;
  result: {
    response: {
      data: string;
      version: string;
      last_block_height: string;
      last_block_app_hash: string;
    };
  };
}

export interface GrpcClientConfig {
  endpoint: string;
  credentials?: 'insecure' | 'ssl';
  maxRetries?: number;
  timeout?: number;
  keepAlive?: boolean;
}

export interface GrpcMethod<TRequest = unknown, TResponse = unknown> {
  path: string;
  requestSerialize: (value: TRequest) => Buffer;
  requestDeserialize: (value: Buffer) => TRequest;
  responseSerialize: (value: TResponse) => Buffer;
  responseDeserialize: (value: Buffer) => TResponse;
}

export interface GrpcService {
  [methodName: string]: GrpcMethod;
}

export interface GrpcClient {
  [serviceName: string]: GrpcService;
}