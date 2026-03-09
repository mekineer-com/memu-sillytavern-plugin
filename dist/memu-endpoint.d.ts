import { Router } from "express";
import type { Request, Response } from "express";
type MemuStep = 'preprocess' | 'memory_extract' | 'category_update' | 'reflection' | 'ranking' | 'embeddings';
interface MemuPluginConfig {
    version: number;
    defaultProfileId: string;
    stepProfileId: Partial<Record<MemuStep, string>>;
    updatedAt: string;
    serverPath?: string;
    autoStartServer?: boolean;
    embeddingModel?: string;
    embeddingModelSelected?: string;
    embeddingModelManual?: string;
}
export declare function getPluginConfig(): MemuPluginConfig;
export declare function setPluginConfig(obj: any): MemuPluginConfig;
export declare function getConnectionProfilesSummary(): {
    ok: boolean;
    profiles: Array<{
        id: string;
        name: string;
    }>;
    message?: string;
};
type ModelsKind = 'embedding' | 'chat' | 'all';
export declare function listModelsForProfile(profileId: string, opts?: {
    kind?: ModelsKind;
    force?: boolean;
}): Promise<{
    ok: boolean;
    models: string[];
    message?: string;
}>;
type ExternalServerShutdownInfo = {
    draining: boolean;
    stopping: boolean;
    requestedAtUnix: number | null;
    requestedBy: string | null;
    reason: string | null;
    maxWaitSec: number;
    timedOut: boolean;
    activeHttpRequests: number;
    activeWorkRequests: number;
};
export declare function externalServerStatus(): Promise<{
    ok: boolean;
    running: boolean;
    healthy: boolean;
    pid?: number | null;
    baseUrl?: string;
    logPath?: string | null;
    logTail?: string[];
    serverInstanceId?: string | null;
    ephemeralDb?: boolean | null;
    shutdown?: ExternalServerShutdownInfo | null;
}>;
export declare function externalServerPingInfo(): Promise<{
    ok: boolean;
    serverInstanceId?: string | null;
    ephemeralDb?: boolean | null;
}>;
export declare function externalServerStart(): Promise<{
    ok: boolean;
    message?: string;
    status?: any;
}>;
export declare function externalServerStop(): Promise<{
    ok: boolean;
    message?: string;
    status?: any;
}>;
export declare function registerServerControl(router: Router): void;
export declare function proxyMemorizeConversation(req: Request, res: Response): Promise<void>;
export declare function proxyGetTaskStatus(req: Request, res: Response): Promise<void>;
export declare function proxyGetTaskSummaryReady(req: Request, res: Response): Promise<void>;
export declare function proxyRetrieveDefaultCategories(req: Request, res: Response): Promise<void>;
export declare function proxyConversationRetrieve(req: Request, res: Response): Promise<void>;
export declare function proxyScopeStorageProbe(req: Request, res: Response): Promise<void>;
export declare function proxyLocalHealth(_req: Request, res: Response): Promise<void>;
export declare function registerMemorizeConversation(router: Router): void;
export declare function registerGetTaskStatus(router: Router): void;
export declare function registerGetTaskSummaryReady(router: Router): void;
export declare function registerRetrieveDefaultCategories(router: Router): void;
export declare function registerConversationRetrieve(router: Router): void;
export declare function registerScopeStorageProbe(router: Router): void;
export declare function registerLocalHealth(router: Router): void;
export {};
