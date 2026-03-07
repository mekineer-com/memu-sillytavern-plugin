import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import express from 'express';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { MODULE_NAME } from './consts';
import {
  registerGetTaskStatus,
  registerGetTaskSummaryReady,
  registerMemorizeConversation,
  registerRetrieveDefaultCategories,
  registerScopeStorageProbe,
  registerLocalHealth,
  getConnectionProfilesSummary,
  listModelsForProfile,
  externalServerPingInfo,
  getPluginConfig,
  setPluginConfig,
  registerServerControl,
} from './memu-endpoint';

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
  router.get('/ping', async (_req: Request, res: Response) => {
    let serverInstanceId: string | null = null;
    let ephemeralDb: boolean | null = null;

    try {
      const st = await externalServerPingInfo();
      serverInstanceId = (st && typeof (st as any).serverInstanceId === 'string') ? (st as any).serverInstanceId : null;
      ephemeralDb = (st && typeof (st as any).ephemeralDb === 'boolean') ? (st as any).ephemeralDb : null;
    } catch {
      // ignore
    }

    return res.json({
      ok: true,
      module: MODULE_NAME,
      ...(serverInstanceId ? { serverInstanceId } : {}),
      ...(ephemeralDb !== null ? { ephemeralDb } : {}),
    });
  });

  router.get('/troubleshooting', (_req: Request, res: Response) => {
    try {
      const filePath = path.join(__dirname, '..', 'public', 'troubleshooting.html');
      const html = fs.readFileSync(filePath, 'utf8');
      res.setHeader('content-type', 'text/html; charset=utf-8');
      return res.status(200).send(html);
    } catch (e: any) {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      const msg = (e && e.message) ? String(e.message) : String(e);
      return res.status(500).send(`<pre>memu troubleshooting page missing or unreadable.\nExpected: plugins/memu/public/troubleshooting.html\nError: ${msg}</pre>`);
    }
  });

  router.get('/config', (_req: Request, res: Response) => {
    return res.json(getPluginConfig());
  });

  router.post('/config', (req: Request, res: Response) => {
    const bodyObj = req.body;
    if (bodyObj && typeof bodyObj === 'object') {
      const cfg = setPluginConfig(bodyObj);
      return res.json({ ok: true, config: cfg });
    }
    return res.status(400).json({ error: 'Invalid JSON' });
  });

  router.get('/profiles', (_req: Request, res: Response) => {
    return res.json(getConnectionProfilesSummary());
  });

  router.get('/models', async (req: Request, res: Response) => {
    const profileId = typeof (req.query as any).profileId === 'string' ? String((req.query as any).profileId) : '';
    if (!profileId.trim()) return res.status(400).json({ ok: false, models: [], message: 'profileId is required' });
    const kindRaw = typeof (req.query as any).kind === 'string' ? String((req.query as any).kind).trim() : '';
    const kind = (kindRaw === 'embedding' || kindRaw === 'chat' || kindRaw === 'all') ? (kindRaw as any) : undefined;
    const force = String((req.query as any).force || '') === '1' || String((req.query as any).force || '').toLowerCase() === 'true';
    const out = await listModelsForProfile(profileId.trim(), { kind, force });
    return res.json(out);
  });
}

export async function init(router: Router): Promise<void> {
  router.use(express.json({ limit: '10mb' }));

  registerGetTaskStatus(router);
  registerGetTaskSummaryReady(router);
  registerRetrieveDefaultCategories(router);
  registerScopeStorageProbe(router);
  registerMemorizeConversation(router);
  registerLocalHealth(router);

  registerMetaEndpoints(router);
  registerServerControl(router);

  console.log(chalk.green(MODULE_NAME), 'Plugin initialized');
}

export async function exit(): Promise<void> {
  console.log(chalk.yellow(MODULE_NAME), 'Plugin exited');
}

export const info: PluginInfo = {
  id: 'memu',
  name: 'memu SillyTavern Plugin',
  description: 'Local-only memu integration (mcp-memu-server)',
};

const plugin: Plugin = {
  init,
  exit,
  info,
};

export default plugin;
