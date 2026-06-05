export interface RedisConnectionObjectOptions {
    host : string;
    port : number;
    tls ?: {
        rejectUnauthorized : boolean;
        ca ?: string;
    }
    password : string;
    username ?: string;
    commandTimeout ?: number;
    keepAlive ?: number;
    connectTimeout ?: number;
    enableAutoPipelining ?: boolean;
    enableReadyCheck ?: boolean;
    maxRetriesPerRequest ?: number;
}

export interface RedisClusterNode {
    host: string;
    port: number;
}

export interface RedisClusterOptions {
    nodes: RedisClusterNode[];
    password?: string;
    username?: string;
    tls?: {
        rejectUnauthorized: boolean;
        ca?: string;
    };
    scaleReads?: "master" | "slave" | "all";
    maxRedirections?: number;
    retryDelayOnFailover?: number;
    retryDelayOnClusterDown?: number;
    retryDelayOnTryAgain?: number;
    slotsRefreshTimeout?: number;
    slotsRefreshInterval?: number;
    enableAutoPipelining?: boolean;
    enableReadyCheck?: boolean;
    commandTimeout?: number;
    keepAlive?: number;
    connectTimeout?: number;
    natMap?: Record<string, { host: string; port: number }>;
}