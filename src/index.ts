import chalk from "chalk";
import { Router } from "express";
import type { Request, Response } from "express";
import { MODULE_NAME } from "./consts";
import {
  registerGetTaskStatus,
  registerGetTaskSummaryReady,
  registerMemorizeConversation,
  registerRetrieveDefaultCategories,
  registerLocalHealth,
  getConnectionProfilesSummary,
  listModelsForProfile,
  getPluginConfig,
  setPluginConfig,
} from "./memu-endpoint";

interface PluginInfo {
  id: string;
  name: string;
  description: string;
}

interface Plugin {
  init: (router: Router) => Promise<void>;
  exit: () => Promise<void>;
  info: PluginInfo;
}

function registerMetaEndpoints(router: Router) {
  router.get("/ping", (_req: Request, res: Response) => {
    const cfg = getPluginConfig();
    return res.json({ ok: true, module: MODULE_NAME, mode: cfg.mode });
  });

  router.get("/config", (_req: Request, res: Response) => {
    return res.json(getPluginConfig());
  });

  router.post("/config", (req: Request, res: Response) => {
    const bodyObj = req.body;
    if (bodyObj && typeof bodyObj === "object") {
      const cfg = setPluginConfig(bodyObj);
      return res.json({ ok: true, config: cfg });
    }

    // Fallback: manual body parsing
    let raw = "";
    req.on("data", (chunk: any) => (raw += chunk));
    req.on("end", () => {
      try {
        const parsed = raw ? JSON.parse(raw) : {};
        const cfg = setPluginConfig(parsed);
        return res.json({ ok: true, config: cfg });
      } catch {
        return res.status(400).json({ error: "Invalid JSON" });
      }
    });
  });

  router.get("/profiles", (_req: Request, res: Response) => {
    return res.json(getConnectionProfilesSummary());
  });

  router.get("/models", async (req: Request, res: Response) => {
    const profileId = typeof (req.query as any).profileId === "string" ? String((req.query as any).profileId) : "";
    if (!profileId.trim()) return res.status(400).json({ ok: false, models: [], message: "profileId is required" });
		const kindRaw = typeof (req.query as any).kind === "string" ? String((req.query as any).kind).trim() : "";
		const kind = (kindRaw === "embedding" || kindRaw === "chat" || kindRaw === "all") ? (kindRaw as any) : undefined;
		const force = String((req.query as any).force || "") === "1" || String((req.query as any).force || "").toLowerCase() === "true";
		const out = await listModelsForProfile(profileId.trim(), { kind, force });
    return res.json(out);
  });
}

export async function init(router: Router): Promise<void> {
  registerGetTaskStatus(router);
  registerGetTaskSummaryReady(router);
  registerRetrieveDefaultCategories(router);
  registerMemorizeConversation(router);
  registerLocalHealth(router);

  registerMetaEndpoints(router);

  console.log(chalk.green(MODULE_NAME), "Plugin initialized");
}

export async function exit(): Promise<void> {
  console.log(chalk.yellow(MODULE_NAME), "Plugin exited");
}

export const info: PluginInfo = {
  id: "memu",
  name: "Memu SillyTavern Plugin",
  description: "Ability to use Memu api in SillyTavern",
};

const plugin: Plugin = {
  init,
  exit,
  info,
};

export default plugin;
