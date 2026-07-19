import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { createInterface } from "node:readline";
import { agentEnvironment } from "../utils.js";
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 3_000;
const APPROVAL_METHODS = new Map([
    ["item/commandExecution/requestApproval", { kind: "command", responseKind: "v2-decision", threadKey: "threadId", itemKey: "itemId" }],
    ["item/fileChange/requestApproval", { kind: "file-change", responseKind: "v2-decision", threadKey: "threadId", itemKey: "itemId" }],
    ["item/permissions/requestApproval", { kind: "permissions", responseKind: "permissions", threadKey: "threadId", itemKey: "itemId" }],
    ["execCommandApproval", { kind: "command", responseKind: "legacy-decision", threadKey: "conversationId", itemKey: "callId" }],
    ["applyPatchApproval", { kind: "file-change", responseKind: "legacy-decision", threadKey: "conversationId", itemKey: "callId" }],
]);
export class CodexAdapter {
    name = "codex";
    options;
    child = null;
    stdoutLines = null;
    stderrLines = null;
    nextRpcId = 1;
    pendingRpc = new Map();
    tasksByThread = new Map();
    threadsByTask = new Map();
    approvals = new Map();
    approvalIdsByRpc = new Map();
    ready = false;
    stopping = false;
    startPromise = null;
    eventChain = Promise.resolve();
    constructor(options) {
        this.options = {
            onEvent: options.onEvent,
            command: options.command ?? "codex",
            args: options.args ?? ["app-server", "--listen", "stdio://"],
            env: options.env,
            requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
            shutdownTimeoutMs: options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
            clientVersion: options.clientVersion ?? "0.1.0",
        };
    }
    isReady() {
        return this.ready && this.child !== null && this.child.exitCode === null;
    }
    async start() {
        if (this.isReady())
            return;
        if (this.startPromise)
            return this.startPromise;
        this.startPromise = this.startProcess().finally(() => {
            this.startPromise = null;
        });
        return this.startPromise;
    }
    async launch(input) {
        this.validateLaunch(input);
        await this.start();
        const threadResponse = asObject(await this.request("thread/start", compactObject({
            cwd: input.cwd,
            approvalPolicy: input.approvalPolicy ?? "on-request",
            approvalsReviewer: "user",
            sandbox: input.sandbox ?? "workspace-write",
            serviceName: input.serviceName ?? "agentsview",
            model: input.model,
            developerInstructions: input.developerInstructions,
            ephemeral: input.ephemeral,
        })));
        const thread = asObject(threadResponse.thread);
        const threadId = requiredString(thread.id, "thread/start did not return thread.id");
        const context = {
            taskId: input.taskId,
            title: input.title,
            threadId,
            completed: false,
        };
        this.tasksByThread.set(threadId, context);
        this.threadsByTask.set(input.taskId, threadId);
        this.emit({
            type: "task.started",
            taskId: input.taskId,
            title: input.title,
            threadId,
            status: "running",
        });
        try {
            const turnResponse = asObject(await this.request("turn/start", compactObject({
                threadId,
                input: [{ type: "text", text: input.prompt, text_elements: [] }],
                cwd: input.cwd,
                model: input.model,
                effort: input.effort,
            })));
            const turn = asObject(turnResponse.turn);
            const turnId = requiredString(turn.id, "turn/start did not return turn.id");
            context.turnId = turnId;
            return { taskId: input.taskId, threadId, turnId };
        }
        catch (error) {
            this.emit({
                type: "task.error",
                taskId: input.taskId,
                title: input.title,
                threadId,
                status: "error",
                message: errorMessage(error),
            });
            throw error;
        }
    }
    /**
     * Delivers a decision for an already captured request. No command, patch,
     * cwd, or other executable data is accepted from the caller.
     */
    async resolveApproval(requestId, decision) {
        const approval = this.approvals.get(requestId);
        if (!approval) {
            throw new Error(`Codex approval request is not pending: ${requestId}`);
        }
        if (!this.child || !this.isReady()) {
            throw new Error("Codex app-server is not connected");
        }
        const normalizedDecision = normalizeDecision(decision);
        if (approval.respondedDecision) {
            if (approval.respondedDecision !== normalizedDecision) {
                throw new Error(`Codex approval request already received ${approval.respondedDecision}`);
            }
            return { requestId, decision: normalizedDecision, delivered: true };
        }
        this.write({ id: approval.rpcId, result: approvalResult(approval, normalizedDecision) });
        approval.respondedDecision = normalizedDecision;
        this.emit({
            type: "approval.responded",
            taskId: approval.taskId,
            threadId: approval.threadId,
            turnId: approval.turnId,
            itemId: approval.itemId,
            requestId,
            rpcId: approval.rpcId,
            approvalKind: approval.kind,
            responseKind: approval.responseKind,
            decision: normalizedDecision,
        });
        return { requestId, decision: normalizedDecision, delivered: true };
    }
    async stop() {
        const child = this.child;
        if (!child)
            return;
        this.stopping = true;
        this.ready = false;
        const exited = new Promise((resolve) => {
            if (child.exitCode !== null) {
                resolve();
                return;
            }
            child.once("close", () => resolve());
        });
        if (!child.stdin.destroyed)
            child.stdin.end();
        const terminateTimer = setTimeout(() => {
            if (child.exitCode === null)
                child.kill("SIGTERM");
        }, 500);
        terminateTimer.unref();
        const killTimer = setTimeout(() => {
            if (child.exitCode === null)
                child.kill("SIGKILL");
        }, this.options.shutdownTimeoutMs);
        killTimer.unref();
        await exited;
        clearTimeout(terminateTimer);
        clearTimeout(killTimer);
        this.stopping = false;
        await this.eventChain;
    }
    async startProcess() {
        this.stopping = false;
        const child = spawn(this.options.command, this.options.args, {
            env: agentEnvironment(this.options.env),
            stdio: ["pipe", "pipe", "pipe"],
        });
        this.child = child;
        this.stdoutLines = createInterface({ input: child.stdout, crlfDelay: Infinity });
        this.stderrLines = createInterface({ input: child.stderr, crlfDelay: Infinity });
        this.stdoutLines.on("line", (line) => this.handleStdoutLine(line));
        this.stderrLines.on("line", (line) => {
            this.emit({ type: "adapter.stderr", message: line });
        });
        child.once("error", (error) => {
            this.failPending(new Error(`Could not start Codex app-server: ${error.message}`));
        });
        child.stdin.on("error", (error) => {
            this.failPending(new Error(`Codex app-server stdin failed: ${error.message}`));
        });
        child.once("close", (code, signal) => {
            this.handleExit(child, code, signal);
        });
        try {
            const initializeResult = await this.request("initialize", {
                clientInfo: {
                    name: "agentsview",
                    title: "AgentsView",
                    version: this.options.clientVersion,
                },
                capabilities: null,
            });
            this.notify("initialized", {});
            this.ready = true;
            this.emit({ type: "adapter.ready", data: initializeResult });
        }
        catch (error) {
            await this.closeFailedStart(child);
            throw error;
        }
    }
    validateLaunch(input) {
        if (!input.taskId.trim())
            throw new Error("Codex taskId is required");
        if (!input.title.trim())
            throw new Error("Codex task title is required");
        if (!input.prompt.trim())
            throw new Error("Codex prompt is required");
        if (!input.cwd.trim() || !isAbsolute(input.cwd)) {
            throw new Error("Codex cwd must be an absolute path");
        }
        if (this.threadsByTask.has(input.taskId)) {
            throw new Error(`Codex task is already launched: ${input.taskId}`);
        }
    }
    request(method, params) {
        const id = this.nextRpcId++;
        const key = rpcKey(id);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingRpc.delete(key);
                reject(new Error(`Codex app-server request timed out: ${method}`));
            }, this.options.requestTimeoutMs);
            timer.unref();
            this.pendingRpc.set(key, { method, resolve, reject, timer });
            try {
                this.write({ id, method, params });
            }
            catch (error) {
                clearTimeout(timer);
                this.pendingRpc.delete(key);
                reject(toError(error));
            }
        });
    }
    notify(method, params) {
        this.write({ method, params });
    }
    write(message) {
        const child = this.child;
        if (!child || child.exitCode !== null || child.stdin.destroyed || !child.stdin.writable) {
            throw new Error("Codex app-server stdin is not writable");
        }
        child.stdin.write(`${JSON.stringify(message)}\n`);
    }
    handleStdoutLine(line) {
        const trimmed = line.trim();
        if (!trimmed)
            return;
        let message;
        try {
            message = JSON.parse(trimmed);
        }
        catch (error) {
            this.emit({
                type: "protocol.error",
                message: `Invalid JSON from Codex app-server: ${errorMessage(error)}`,
            });
            return;
        }
        // App-server messages do not consistently include a `jsonrpc` field, so
        // dispatch is based only on method/id/result/error shape.
        try {
            if (typeof message.method === "string") {
                if (hasOwn(message, "id") && isRpcId(message.id)) {
                    this.handleServerRequest(message.method, message.id, message.params);
                }
                else {
                    this.handleNotification(message.method, message.params);
                }
                return;
            }
            if (hasOwn(message, "id") && isRpcId(message.id)) {
                this.handleResponse(message);
                return;
            }
            this.emit({ type: "protocol.error", message: "Unrecognized Codex app-server message" });
        }
        catch (error) {
            this.emit({
                type: "protocol.error",
                message: `Could not handle Codex app-server message: ${errorMessage(error)}`,
            });
        }
    }
    handleResponse(message) {
        if (!isRpcId(message.id))
            return;
        const key = rpcKey(message.id);
        const pending = this.pendingRpc.get(key);
        if (!pending)
            return;
        clearTimeout(pending.timer);
        this.pendingRpc.delete(key);
        if (hasOwn(message, "error") && message.error !== undefined && message.error !== null) {
            pending.reject(rpcError(pending.method, message.error));
            return;
        }
        pending.resolve(message.result);
    }
    handleServerRequest(method, rpcId, rawParams) {
        const params = asObject(rawParams);
        const specification = APPROVAL_METHODS.get(method);
        if (specification) {
            try {
                this.captureApproval(method, rpcId, params, specification);
            }
            catch (error) {
                this.replyError(rpcId, -32602, `Invalid ${method} params: ${errorMessage(error)}`);
                this.emit({ type: "protocol.error", rpcId, message: errorMessage(error) });
            }
            return;
        }
        const threadId = optionalString(params.threadId) ?? optionalString(params.conversationId);
        const task = threadId ? this.tasksByThread.get(threadId) : undefined;
        this.replyError(rpcId, -32601, `AgentsView does not support server request: ${method}`);
        this.emit({
            type: "server.request",
            taskId: task?.taskId,
            threadId,
            turnId: optionalString(params.turnId),
            itemId: optionalString(params.itemId),
            rpcId,
            message: method,
            data: rawParams,
        });
    }
    replyError(rpcId, code, message) {
        this.write({ id: rpcId, error: { code, message } });
    }
    captureApproval(method, rpcId, params, specification) {
        const threadId = requiredString(params[specification.threadKey], `${method} did not include ${specification.threadKey}`);
        const task = this.tasksByThread.get(threadId);
        const requestId = stableRequestId(threadId, rpcId);
        const approval = {
            requestId,
            rpcId,
            rpcKey: rpcKey(rpcId),
            taskId: task?.taskId,
            threadId,
            turnId: optionalString(params.turnId),
            itemId: optionalString(params[specification.itemKey]),
            kind: specification.kind,
            responseKind: specification.responseKind,
            requestedPermissions: specification.responseKind === "permissions"
                ? cloneObject(params.permissions)
                : undefined,
        };
        this.approvals.set(requestId, approval);
        this.approvalIdsByRpc.set(approval.rpcKey, requestId);
        this.emit({
            type: "approval.requested",
            taskId: task?.taskId,
            title: task?.title,
            threadId,
            turnId: approval.turnId,
            itemId: approval.itemId,
            requestId,
            rpcId,
            approvalKind: specification.kind,
            responseKind: specification.responseKind,
            status: "waiting_approval",
            data: approvalDisplayData(specification.kind, params),
        });
    }
    handleNotification(method, rawParams) {
        const params = asObject(rawParams);
        const threadId = optionalString(params.threadId);
        const task = threadId ? this.tasksByThread.get(threadId) : undefined;
        const turnId = optionalString(params.turnId) ?? task?.turnId;
        switch (method) {
            case "thread/status/changed": {
                const status = mapThreadStatus(params.status);
                if (task?.completed)
                    return;
                this.emit({
                    type: "task.status",
                    taskId: task?.taskId,
                    title: task?.title,
                    threadId,
                    turnId,
                    status,
                    data: params.status,
                });
                return;
            }
            case "turn/started": {
                if (task?.completed)
                    return;
                const turn = asObject(params.turn);
                const startedTurnId = optionalString(turn.id) ?? turnId;
                if (task && startedTurnId)
                    task.turnId = startedTurnId;
                this.emit({
                    type: "task.status",
                    taskId: task?.taskId,
                    title: task?.title,
                    threadId,
                    turnId: startedTurnId,
                    status: "running",
                    data: rawParams,
                });
                return;
            }
            case "turn/completed": {
                const turn = asObject(params.turn);
                const outcome = mapTurnOutcome(turn.status);
                if (task?.completed)
                    return;
                if (task)
                    task.completed = true;
                this.emit({
                    type: "task.completed",
                    taskId: task?.taskId,
                    title: task?.title,
                    threadId,
                    turnId: optionalString(turn.id) ?? turnId,
                    status: outcome === "completed" ? "completed" : outcome,
                    outcome,
                    data: rawParams,
                });
                return;
            }
            case "item/started":
            case "item/completed": {
                const item = asObject(params.item);
                this.emit({
                    type: method === "item/started" ? "item.started" : "item.completed",
                    taskId: task?.taskId,
                    threadId,
                    turnId,
                    itemId: optionalString(item.id),
                    data: item,
                });
                return;
            }
            case "item/agentMessage/delta":
            case "item/commandExecution/outputDelta": {
                this.emit({
                    type: "output.delta",
                    taskId: task?.taskId,
                    threadId,
                    turnId,
                    itemId: optionalString(params.itemId),
                    delta: optionalString(params.delta) ?? "",
                    data: { source: method },
                });
                return;
            }
            case "thread/tokenUsage/updated": {
                this.emit({
                    type: "token.usage",
                    taskId: task?.taskId,
                    threadId,
                    turnId,
                    data: params.tokenUsage,
                });
                return;
            }
            case "serverRequest/resolved": {
                this.clearResolvedApproval(params, task);
                return;
            }
            case "error": {
                if (task?.completed)
                    return;
                this.emit({
                    type: "task.error",
                    taskId: task?.taskId,
                    title: task?.title,
                    threadId,
                    turnId,
                    status: "error",
                    message: errorMessage(params.error ?? params.message ?? rawParams),
                    data: rawParams,
                });
                return;
            }
            default:
                this.emit({
                    type: "server.notification",
                    taskId: task?.taskId,
                    threadId,
                    turnId,
                    message: method,
                    data: rawParams,
                });
        }
    }
    clearResolvedApproval(params, task) {
        const rawRequestId = params.requestId;
        if (!isRpcId(rawRequestId))
            return;
        const key = rpcKey(rawRequestId);
        const requestId = this.approvalIdsByRpc.get(key);
        const approval = requestId ? this.approvals.get(requestId) : undefined;
        if (requestId)
            this.approvals.delete(requestId);
        this.approvalIdsByRpc.delete(key);
        this.emit({
            type: "approval.resolved",
            taskId: approval?.taskId ?? task?.taskId,
            threadId: approval?.threadId ?? optionalString(params.threadId),
            turnId: approval?.turnId,
            itemId: approval?.itemId,
            requestId: approval?.requestId,
            rpcId: rawRequestId,
            approvalKind: approval?.kind,
            decision: approval?.respondedDecision,
        });
    }
    handleExit(child, code, signal) {
        if (this.child !== child)
            return;
        const wasStopping = this.stopping;
        this.ready = false;
        this.child = null;
        this.stdoutLines?.close();
        this.stderrLines?.close();
        this.stdoutLines = null;
        this.stderrLines = null;
        const message = `Codex app-server exited (${signal ?? code ?? "unknown"})`;
        this.failPending(new Error(message));
        if (!wasStopping) {
            for (const task of this.tasksByThread.values()) {
                if (task.completed)
                    continue;
                this.emit({
                    type: "task.error",
                    taskId: task.taskId,
                    title: task.title,
                    threadId: task.threadId,
                    turnId: task.turnId,
                    status: "error",
                    message,
                });
            }
        }
        this.approvals.clear();
        this.approvalIdsByRpc.clear();
        this.tasksByThread.clear();
        this.threadsByTask.clear();
        this.emit({ type: "adapter.exit", message, data: { code, signal, expected: wasStopping } });
    }
    async closeFailedStart(child) {
        if (child.exitCode !== null || this.child !== child)
            return;
        const closed = new Promise((resolve) => child.once("close", resolve));
        if (!child.stdin.destroyed)
            child.stdin.end();
        child.kill("SIGTERM");
        const timeout = setTimeout(() => {
            if (child.exitCode === null)
                child.kill("SIGKILL");
        }, this.options.shutdownTimeoutMs);
        timeout.unref();
        await closed;
        clearTimeout(timeout);
    }
    failPending(error) {
        for (const pending of this.pendingRpc.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pendingRpc.clear();
    }
    emit(event) {
        const enriched = {
            ...event,
            provider: "codex",
            at: new Date().toISOString(),
        };
        this.eventChain = this.eventChain
            .then(() => this.options.onEvent(enriched))
            .then(() => undefined)
            .catch(() => undefined);
    }
}
function approvalDisplayData(kind, params) {
    if (kind === "command") {
        const command = Array.isArray(params.command)
            ? params.command.map((part) => String(part)).join(" ")
            : optionalString(params.command);
        return compactObject({
            command,
            cwd: optionalString(params.cwd),
            reason: optionalString(params.reason),
            startedAtMs: typeof params.startedAtMs === "number" ? params.startedAtMs : undefined,
            commandActions: Array.isArray(params.commandActions) ? params.commandActions : undefined,
            parsedCommand: Array.isArray(params.parsedCmd) ? params.parsedCmd : undefined,
            network: params.networkApprovalContext ?? asObject(params.additionalPermissions).network,
            networkApprovalContext: params.networkApprovalContext,
            additionalPermissions: params.additionalPermissions,
            proposedNetworkPolicyAmendments: params.proposedNetworkPolicyAmendments,
            proposedExecpolicyAmendment: params.proposedExecpolicyAmendment,
            availableDecisions: Array.isArray(params.availableDecisions)
                ? params.availableDecisions
                : undefined,
        });
    }
    if (kind === "permissions") {
        const permissions = cloneObject(params.permissions);
        return compactObject({
            reason: optionalString(params.reason),
            cwd: optionalString(params.cwd),
            permissions,
            network: permissions.network,
            fileSystem: permissions.fileSystem,
            startedAtMs: typeof params.startedAtMs === "number" ? params.startedAtMs : undefined,
        });
    }
    return compactObject({
        reason: optionalString(params.reason),
        grantRoot: optionalString(params.grantRoot),
        fileChanges: params.fileChanges,
        startedAtMs: typeof params.startedAtMs === "number" ? params.startedAtMs : undefined,
    });
}
function approvalResult(approval, decision) {
    if (approval.responseKind === "legacy-decision") {
        return { decision: decision === "allow" ? "approved" : "denied" };
    }
    if (approval.responseKind === "permissions") {
        return {
            scope: "turn",
            permissions: decision === "allow" ? cloneObject(approval.requestedPermissions) : {},
        };
    }
    return { decision: decision === "allow" ? "accept" : "decline" };
}
function stableRequestId(threadId, rpcId) {
    return `codex:${encodeURIComponent(threadId)}:${typeof rpcId}:${encodeURIComponent(String(rpcId))}`;
}
function cloneObject(value) {
    return structuredClone(asObject(value));
}
function mapThreadStatus(value) {
    const status = asObject(value);
    switch (status.type) {
        case "active": {
            const flags = Array.isArray(status.activeFlags) ? status.activeFlags : [];
            if (flags.includes("waitingOnApproval"))
                return "waiting_approval";
            if (flags.includes("waitingOnUserInput"))
                return "waiting_input";
            return "running";
        }
        case "idle":
        case "notLoaded":
            return "idle";
        case "systemError":
            return "error";
        default:
            return "running";
    }
}
function mapTurnOutcome(value) {
    if (value === "interrupted")
        return "interrupted";
    if (value === "failed")
        return "failed";
    return "completed";
}
function normalizeDecision(value) {
    if (value === true || value === "allow")
        return "allow";
    if (value === false || value === "deny")
        return "deny";
    throw new Error("Codex approval decision must be allow or deny");
}
function rpcKey(id) {
    return `${typeof id}:${String(id)}`;
}
function isRpcId(value) {
    return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}
function hasOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
}
function asObject(value) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
        return value;
    }
    return {};
}
function compactObject(value) {
    return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}
function optionalString(value) {
    return typeof value === "string" ? value : undefined;
}
function requiredString(value, message) {
    if (typeof value !== "string" || value.length === 0)
        throw new Error(message);
    return value;
}
function errorMessage(error) {
    if (error instanceof Error)
        return error.message;
    if (typeof error === "string")
        return error;
    try {
        return JSON.stringify(error);
    }
    catch {
        return String(error);
    }
}
function toError(error) {
    return error instanceof Error ? error : new Error(errorMessage(error));
}
function rpcError(method, error) {
    const object = asObject(error);
    const message = optionalString(object.message) ?? errorMessage(error);
    const code = typeof object.code === "number" ? ` [${object.code}]` : "";
    return new Error(`Codex app-server ${method} failed${code}: ${message}`);
}
