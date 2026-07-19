import { randomUUID } from 'node:crypto';
import { agentEnvironment, assessRisk, basenameOnly, boundedText, commandSummary, hashText, isoNow } from '../utils.js';

export class ClaudeSdkAdapter {
  constructor({ onEvent, apiKey, enabled = true }) {
    this.onEvent = onEvent;
    this.apiKey = apiKey;
    this.enabled = enabled;
    this.query = null;
    this.pending = new Map();
    this.runs = new Set();
    this.controllers = new Set();
  }

  async start() {
    if (!this.enabled || !this.apiKey) return false;
    try {
      const module = await import('@anthropic-ai/claude-agent-sdk');
      this.query = module.query;
      return typeof this.query === 'function';
    } catch {
      this.query = null;
      return false;
    }
  }

  isReady() {
    return typeof this.query === 'function';
  }

  async launch({ taskId, title, prompt, cwd }) {
    if (!this.isReady()) throw new Error('Claude Agent SDK is unavailable. Install @anthropic-ai/claude-agent-sdk and set ANTHROPIC_API_KEY.');
    const abortController = new AbortController();
    this.controllers.add(abortController);
    const run = this.run({ taskId, title, prompt, cwd, abortController });
    this.runs.add(run);
    run.finally(() => {
      this.runs.delete(run);
      this.controllers.delete(abortController);
    });
    return { taskId };
  }

  async run({ taskId, title, prompt, cwd, abortController }) {
    await this.onEvent({ type: 'task.started', provider: 'claude', taskId, title, agent: 'claude', cwd, status: 'running', at: isoNow() });
    try {
      const stream = this.query({
        prompt,
        options: {
          cwd,
          abortController,
          permissionMode: 'default',
          env: agentEnvironment({ ANTHROPIC_API_KEY: this.apiKey }),
          canUseTool: (toolName, input) => this.requestPermission(taskId, toolName, input),
        },
      });
      for await (const message of stream) await this.handleMessage(taskId, message);
    } catch (error) {
      await this.onEvent({ type: 'task.error', provider: 'claude', taskId, status: 'error', message: error.message, at: isoNow() });
    }
  }

  requestPermission(taskId, toolName, input) {
    const requestId = `claude:${randomUUID()}`;
    return new Promise((resolve) => {
      this.pending.set(requestId, { taskId, toolName, input, resolve });
      void this.onEvent({
        type: 'approval.requested', provider: 'claude', taskId, requestId,
        approvalKind: String(toolName).toLowerCase() === 'bash' ? 'command' : 'tool',
        risk: assessRisk(toolName, input), title: `${toolName} needs permission`,
        summary: commandSummary(toolName, input), details: boundedText(input, 900),
        data: { toolName, input }, status: 'waiting_approval', at: isoNow(),
      });
    });
  }

  async resolveApproval(requestId, decision) {
    const pending = this.pending.get(requestId);
    if (!pending) throw new Error(`Claude approval is no longer pending: ${requestId}`);
    this.pending.delete(requestId);
    if (decision === 'allow') pending.resolve({ behavior: 'allow', updatedInput: pending.input });
    else pending.resolve({ behavior: 'deny', message: 'Denied from AgentsView.' });
    return { requestId, decision, delivered: true };
  }

  async handleMessage(taskId, message) {
    if (!message || typeof message !== 'object') return;
    if (message.session_id) await this.onEvent({ type: 'task.external', provider: 'claude', taskId, externalId: message.session_id, at: isoNow() });
    if (message.type === 'result') {
      const failed = message.is_error || message.subtype === 'error';
      await this.onEvent({
        type: 'task.completed', provider: 'claude', taskId, status: 'completed',
        outcome: failed ? 'failed' : 'success', message: boundedText(message.result, 520), at: isoNow(),
        data: { usage: message.usage, total_cost_usd: message.total_cost_usd },
      });
    } else if (message.type === 'assistant') {
      const text = Array.isArray(message.message?.content)
        ? message.message.content.filter((item) => item?.type === 'text').map((item) => item.text).join('\n')
        : '';
      if (text) await this.onEvent({ type: 'output.delta', provider: 'claude', taskId, delta: text, at: isoNow() });
    }
  }

  async stop() {
    for (const controller of this.controllers) controller.abort();
    for (const pending of this.pending.values()) pending.resolve({ behavior: 'deny', message: 'AgentsView is shutting down.' });
    this.pending.clear();
    await Promise.race([
      Promise.allSettled([...this.runs]),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }
}

export class ClaudeHookBridge {
  constructor({ store, approvalTtlMs, provider = 'claude', onSeen = () => {} }) {
    this.store = store;
    this.approvalTtlMs = approvalTtlMs;
    this.provider = provider;
    this.onSeen = onSeen;
    this.displayName = provider === 'codex' ? 'Codex' : 'Claude Code';
    this.adapterRef = `${provider}-hook`;
    this.pending = new Map();
  }

  async handle(input) {
    const eventName = boundedText(input.hook_event_name, 80);
    const sessionId = boundedText(input.session_id, 240);
    if (!eventName || !sessionId) throw Object.assign(new Error(`${this.displayName} hook event and session id are required.`), { statusCode: 400, code: 'invalid_hook_event' });
    this.onSeen({ provider: this.provider, eventName, at: isoNow() });
    const task = await this.ensureTask(sessionId, input);
    if (eventName === 'PermissionRequest') return this.permission(task.id, input);

    if (eventName === 'UserPromptSubmit') {
      await this.store.upsertTask({ id: task.id, status: 'running', summary: boundedText(input.prompt, 520, `${this.displayName} is processing a prompt.`) });
    } else if (eventName === 'Stop') {
      await this.store.upsertTask({ id: task.id, status: 'completed', outcome: 'success', summary: boundedText(input.last_assistant_message, 520, `${this.displayName} finished the task.`) });
    } else if (eventName === 'StopFailure') {
      await this.store.upsertTask({ id: task.id, status: 'completed', outcome: 'failed', summary: boundedText(input.error, 520, `${this.displayName} stopped with an error.`) });
    } else if (eventName === 'SessionEnd') {
      const current = this.store.getTask(task.id);
      if (current?.status !== 'completed') await this.store.upsertTask({ id: task.id, status: 'completed', outcome: 'interrupted', summary: `${this.displayName} session ended.` });
    } else if (['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'SubagentStart', 'SubagentStop'].includes(eventName)) {
      await this.store.addActivity(task.id, {
        type: eventName, label: boundedText(input.tool_name || input.agent_type, 120, eventName),
        detail: commandSummary(input.tool_name || input.agent_type, input.tool_input || input), at: isoNow(),
      });
    }
    return {};
  }

  async ensureTask(sessionId, input) {
    const existing = this.store.findTaskByExternalId(this.provider, sessionId);
    if (existing) {
      if (existing.status !== 'completed' || input.hook_event_name === 'SessionEnd') return existing;
    }
    const id = `${this.provider}-hook-${hashText(sessionId)}-${randomUUID().slice(0, 8)}`;
    const project = basenameOnly(boundedText(input.cwd, 1000));
    return this.store.upsertTask({
      id, externalId: sessionId, title: boundedText(input.session_title, 160, `${this.displayName} · ${project || hashText(sessionId).slice(0, 6)}`),
      agent: this.provider, status: 'running', cwd: boundedText(input.cwd, 1000),
      summary: existing ? `${this.displayName} session started a new task through Hooks.` : `${this.displayName} session connected through Hooks.`,
      startedAt: isoNow(),
    });
  }

  async permission(taskId, input) {
    const nativeId = `${this.adapterRef}:${randomUUID()}`;
    const toolName = boundedText(input.tool_name, 120, 'Tool');
    const toolInput = input.tool_input && typeof input.tool_input === 'object' ? structuredClone(input.tool_input) : {};
    const expiresAt = new Date(Date.now() + this.approvalTtlMs).toISOString();
    const approval = await this.store.createApproval({
      taskId,
      kind: toolName.toLowerCase() === 'bash' ? 'command' : 'tool',
      risk: assessRisk(toolName, toolInput),
      title: `${toolName} needs permission`,
      summary: commandSummary(toolName, toolInput),
      details: boundedText(toolInput, 1000),
      requestedAt: isoNow(), expiresAt,
      adapterRef: { adapter: this.adapterRef, requestId: nativeId },
    });
    return new Promise((resolve) => {
      const timer = setTimeout(async () => {
        this.pending.delete(nativeId);
        await this.store.expireApproval(approval.id).catch(() => {});
        resolve(this.hookDecision('deny', toolInput, 'Approval timed out in AgentsView.'));
      }, this.approvalTtlMs);
      this.pending.set(nativeId, { taskId, approvalId: approval.id, toolInput, resolve, timer });
    });
  }

  hookDecision(decision, toolInput, message = '') {
    return {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: decision === 'allow'
          ? { behavior: 'allow', updatedInput: toolInput }
          : { behavior: 'deny', message: message || 'Denied from AgentsView.' },
      },
    };
  }

  async resolveApproval(requestId, decision) {
    const pending = this.pending.get(requestId);
    if (!pending) throw new Error(`${this.displayName} Hook approval is no longer pending: ${requestId}`);
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve(this.hookDecision(decision, pending.toolInput));
    return { requestId, decision, delivered: true };
  }

  async stop() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve(this.hookDecision('deny', pending.toolInput, 'AgentsView is shutting down.'));
    }
    this.pending.clear();
  }
}

export class CodexHookBridge extends ClaudeHookBridge {
  constructor(options) {
    super({ ...options, provider: 'codex' });
  }
}
