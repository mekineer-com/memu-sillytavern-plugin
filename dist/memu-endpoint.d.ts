import { Router } from "express";
import type { Request, Response } from "express";
/**
 * NOTE:
 *  - Cloud mode: proxy to memU SaaS (memu-js)
 *  - Local mode: long-lived Python bridge (daemon) that talks to memU locally
 *
 * Local mode goal:
 *  - Reuse SillyTavern connection profiles (base_url + model)
 *  - Reuse SillyTavern secrets.json keys (best-effort; ST doesn't bind keys to profiles)
 *  - By default, the metadata store is in-memory. For persistence, switch dbProvider to Postgres.
 *  - Local blob resources are stored under <ST_ROOT>/data/memu-local/
 */
type MemuMode = "cloud" | "local";
type MemuStep = "preprocess" | "memory_extract" | "category_update" | "reflection" | "ranking" | "embeddings";
interface MemuPluginConfig {
    version: number;
    mode: MemuMode;
    defaultProfileId: string;
    stepProfileId: Partial<Record<MemuStep, string>>;
    updatedAt: string;
    pythonCmd?: string;
    /** Effective embedding model (legacy single-field). */
    embeddingModel?: string;
    /** Dropdown-selected embedding model (preferred over manual). */
    embeddingModelSelected?: string;
    /** Optional manual embedding model (used when dropdown is blank). */
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
export declare function getLocalBridgeSessionId(): string | null;
export declare function proxyMemorizeConversation(req: Request, res: Response): Promise<void>;
export declare function proxyGetTaskStatus(req: Request, res: Response): Promise<void>;
export declare function proxyGetTaskSummaryReady(req: Request, res: Response): Promise<void>;
export declare function proxyRetrieveDefaultCategories(req: Request, res: Response): Promise<void>;
export declare function proxyLocalHealth(req: Request, res: Response): Promise<void>;
export declare function registerMemorizeConversation(router: Router): void;
export declare function registerGetTaskStatus(router: Router): void;
export declare function registerGetTaskSummaryReady(router: Router): void;
export declare function registerRetrieveDefaultCategories(router: Router): void;
export declare function registerLocalHealth(router: Router): void;
export {};
