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
export declare function init(router: Router): Promise<void>;
export declare function exit(): Promise<void>;
export declare const info: PluginInfo;
declare const plugin: Plugin;
export default plugin;
