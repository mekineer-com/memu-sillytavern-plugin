import { Router } from "express";
import type { Request, Response } from "express";
interface MemuPluginConfig {
    version: number;
    updatedAt: string;
    serverPath?: string;
    autoStartWithSillyTavern?: boolean;
    embeddingModelSelected?: string;
    embeddingModelManual?: string;
    embeddingBatchSize?: number;
}
export declare function getPluginConfig(): MemuPluginConfig;
export declare function setPluginConfig(obj: any): MemuPluginConfig;
export declare function getConnectionProfilesSummary(): {
    ok: boolean;
    profiles: Array<{
        id: string;
        name: string;
        provider?: string;
        memuChatCapable?: boolean;
        memuEmbeddingListCapable?: boolean;
        selected?: boolean;
        resolvedProfileId?: string;
    }>;
    selectedProfileId?: string | null;
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
export declare function proxyModelMappings(req: Request, res: Response): Promise<void>;
export declare function registerModelMappings(router: Router): void;
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
    error?: string;
}>;
export declare function externalServerStart(): Promise<{
    ok: boolean;
    message?: string;
    status?: any;
}>;
export declare function externalServerStop(config?: MemuPluginConfig, confirmUnknown?: boolean): Promise<{
    ok: boolean;
    confirmationRequired?: boolean;
    message?: string;
    status?: any;
}>;
export declare function startServerWithSillyTavern(): Promise<void>;
export declare function stopServerWithSillyTavern(): Promise<void>;
export declare function registerServerControl(router: Router): void;
export declare function proxyMemorizeConversation(req: Request, res: Response): Promise<void>;
export declare function proxyGetTaskStatus(req: Request, res: Response): Promise<void>;
export declare function proxyRetrieveDefaultCategories(req: Request, res: Response): Promise<void>;
export declare function proxyConversationRetrieve(req: Request, res: Response): Promise<void>;
export declare function proxyConversationTurn(req: Request, res: Response): Promise<void>;
export declare function proxyConversationTurnUndo(req: Request, res: Response): Promise<void>;
export declare function proxyDeleteConversationSource(req: Request, res: Response): Promise<void>;
export declare function proxyScopeStorageProbe(req: Request, res: Response): Promise<void>;
export declare function proxyLocalHealth(_req: Request, res: Response): Promise<void>;
export declare function proxyOwner(req: Request, res: Response): Promise<void>;
export declare function proxySouls(req: Request, res: Response): Promise<void>;
export declare function registerMemorizeConversation(router: Router): void;
export declare function registerGetTaskStatus(router: Router): void;
export declare function proxyCancelMemorize(req: Request, res: Response): Promise<void>;
export declare function registerCancelMemorize(router: Router): void;
export declare function registerRetrieveDefaultCategories(router: Router): void;
export declare function registerConversationRetrieve(router: Router): void;
export declare function registerConversationTurn(router: Router): void;
export declare function registerConversationTurnUndo(router: Router): void;
export declare function registerDeleteConversationSource(router: Router): void;
export declare function registerScopeStorageProbe(router: Router): void;
export declare function registerLocalHealth(router: Router): void;
export declare function registerOwner(router: Router): void;
export declare function registerSouls(router: Router): void;
export declare function proxyNarrativeSuggestion(req: Request, res: Response): Promise<void>;
export declare function registerNarrativeSuggestion(router: Router): void;
export declare function proxyListRelationships(req: Request, res: Response): Promise<void>;
export declare function proxyCreateRelationship(req: Request, res: Response): Promise<void>;
export declare function proxyUpdateRelationship(req: Request, res: Response): Promise<void>;
export declare function proxyDeleteRelationship(req: Request, res: Response): Promise<void>;
export declare function registerRelationships(router: Router): void;
export {};
