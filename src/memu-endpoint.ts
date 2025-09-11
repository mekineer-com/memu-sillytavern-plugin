import bodyParser from "body-parser";
import chalk from "chalk";
import { Router } from "express";
import { MemuClient } from "memu-js";
import { MEMU_BASE_URL, MEMU_DEFAULT_MAX_RETRIES, MEMU_DEFAULT_TIMEOUT, MODULE_NAME } from "./consts";

const jsonParser = bodyParser.json();

export function registerGetTaskStatus(router: Router): void {
    router.post('/getTaskStatus', jsonParser, async (req, res) => {
        try {
            const { apiKey, timeout, taskId } = req.body as {
                apiKey: string,
                timeout: number,
                taskId: string,
            };
            if (!apiKey || !taskId) {
                return res.status(400).json({
                    error: 'Invalid request',
                    message: 'apiKey and taskId are required',
                });
            }
            const client = createMemuClient(apiKey, timeout);
            const task = await client.getTaskStatus(taskId);
            return res.json(task);
        } catch (error: any) {
            console.error(chalk.red(MODULE_NAME), 'Failed to get task status', error.message);
            return res.status(500).json({
                error: 'Failed to get task status',
                message: error.message,
            });
        }
    });
}

export function registerGetTaskSummaryReady(router: Router): void {
    router.post('/getTaskSummaryReady', jsonParser, async (req, res) => {
        try {
            const { apiKey, timeout, taskId } = req.body as {
                apiKey: string,
                timeout: number,
                taskId: string,
            };
            if (!apiKey || !taskId) {
                return res.status(400).json({
                    error: 'Invalid request',
                    message: 'apiKey and taskId are required',
                });
            }
            const client = createMemuClient(apiKey, timeout);
            const summaryReady = await client.getTaskSummaryReady(taskId);
            return res.json(summaryReady);
        } catch (error: any) {
            console.error(chalk.red(MODULE_NAME), 'Failed to get task summary ready info', error.message);
            return res.status(500).json({
                error: 'Failed to get task summary ready info',
                message: error.message,
            });
        }
    });
}

export function registerRetrieveDefaultCategories(router: Router): void {
    router.post('/retrieveDefaultCategories', jsonParser, async (req, res) => {
        try {
            const { apiKey, userId, agentId } = req.body as {
                apiKey: string,
                userId: string,
                agentId?: string,
            };
            if (!apiKey || !userId) {
                return res.status(400).json({
                    error: 'Invalid request',
                    message: 'apiKey and userId are required',
                });
            }
            const client = createMemuClient(apiKey);
            const categories = await client.retrieveDefaultCategories({
                userId: userId,
                agentId: agentId,
            });
            return res.json(categories);
        } catch (error: any) {
            console.error(chalk.red(MODULE_NAME), 'Failed to retrieve default categories', error.message);
            return res.status(500).json({
                error: 'Failed to retrieve default categories',
                message: error.message,
            });
        }
    });
}

export function registerMemorizeConversation(router: Router): void {
    router.post('/memorizeConversation', jsonParser, async (req, res) => {
        try {
            const { apiKey, conversation, userId, userName, agentId, agentName } = req.body as {
                apiKey: string,
                conversation: string | Array<{
                    role: string,
                    name?: string,
                    content: string,
                }>,
                userId: string,
                userName: string,
                agentId: string,
                agentName: string,
            };
            if (!apiKey || !conversation || !userId || !userName || !agentId || !agentName) {
                return res.status(400).json({
                    error: 'Invalid request',
                    message: 'apiKey, conversation, userId, userName, agentId, and agentName are required',
                });
            }
            const client = createMemuClient(apiKey);
            const task = await client.memorizeConversation(
                conversation,
                userId,
                userName,
                agentId,
                agentName,
            );
            return res.json(task);
        } catch (error: any) {
            console.error(chalk.red(MODULE_NAME), 'Failed to memorize conversation', error.message);
            return res.status(500).json({
                error: 'Failed to memorize conversation',
                message: error.message,
            });
        }
    });
}

function createMemuClient(apiKey: string, timeout: number = MEMU_DEFAULT_TIMEOUT): MemuClient {
    return new MemuClient({
        baseUrl: MEMU_BASE_URL,
        apiKey: apiKey,
        timeout: timeout,
        maxRetries: MEMU_DEFAULT_MAX_RETRIES,
    });
}
