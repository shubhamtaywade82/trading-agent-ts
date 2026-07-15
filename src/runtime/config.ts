/**
 * Runtime configuration constants. Values can be overridden via environment variables.
 * This allows CI or interactive sessions to tune buffer sizes without code changes.
 */

export const MAX_LOGS = process.env.TRADINGAGENT_MAX_LOGS ? parseInt(process.env.TRADINGAGENT_MAX_LOGS, 10) : 500;
export const MAX_CONVERSATION = process.env.TRADINGAGENT_MAX_CONVERSATION ? parseInt(process.env.TRADINGAGENT_MAX_CONVERSATION, 10) : 500;
export const MAX_TOOL_CALLS = process.env.TRADINGAGENT_MAX_TOOL_CALLS ? parseInt(process.env.TRADINGAGENT_MAX_TOOL_CALLS, 10) : 200;
export const MAX_NOTIFICATIONS = process.env.TRADINGAGENT_MAX_NOTIFICATIONS ? parseInt(process.env.TRADINGAGENT_MAX_NOTIFICATIONS, 10) : 20;
