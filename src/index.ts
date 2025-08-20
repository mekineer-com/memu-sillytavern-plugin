import chalk from "chalk";
import { Router } from "express";
import { MODULE_NAME } from "./consts";
import { registerGetTaskStatus, registerGetTaskSummaryReady, registerMemorizeConversation, registerRetrieveDefaultCategories } from "./memu-endpoint";

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

/**
 * Initialize the plugin.
 * @param router Express Router
 */
export async function init(router: Router): Promise<void> {
  registerGetTaskStatus(router);
  registerGetTaskSummaryReady(router);
  registerRetrieveDefaultCategories(router);
  registerMemorizeConversation(router);
  console.log(chalk.green(MODULE_NAME), 'Plugin initialized');
}

export async function exit(): Promise<void> {
  console.log(chalk.yellow(MODULE_NAME), 'Plugin exited');
}


export const info: PluginInfo = {
  id: 'memu',
  name: 'Memu SillyTavern Plugin',
  description: 'Ability to use Memu api in SillyTavern',
};

const plugin: Plugin = {
  init,
  exit,
  info,
};

export default plugin;
