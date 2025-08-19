import { Router } from "express";
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
export declare function init(router: Router): Promise<void>;
export declare function exit(): Promise<void>;
export declare const info: PluginInfo;
declare const plugin: Plugin;
export default plugin;
