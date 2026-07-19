import { CodexAdapter } from './adapters/codex.js';
import { ClaudeHookBridge, ClaudeSdkAdapter, CodexHookBridge } from './adapters/claude.js';
import { DemoAdapter } from './adapters/demo.js';
import { assessRisk, boundedText, commandSummary, hashText, isoNow, randomId } from './utils.js';

export class AdapterManager {
  constructor({ store, config, audit, onCapabilitiesChanged = () => {} }) {
    this.store = store;
    this.config = config;
    this.audit = audit;
    this.onCapabilitiesChanged = onCapabilitiesChanged;
    this.eventQueue = Promise.resolve();
    this.outputTimers = new Map();
    this.outputBuffers = new Map();
    this.approvalExpiryTimers = new Map();
    this.approvalExpiryHandler = null;
    this.capabilityState = {
      demo: config.demoMode,
      codex: false,
      claude: false,
      codexHooks: Boolean(config.claudeHookSecret),
      codexHooksLastSeenAt: null,
      claudeHooks: Boolean(config.claudeHookSecret),
      claudeHooksLastSeenAt: null,
    };

    const onEvent = (event) => this.enqueueEvent(event);
    this.demo = new DemoAdapter({ onEvent });
    this.codex = new CodexAdapter({ onEvent, command: config.codexCommand, clientVersion: config.version });
    this.claude = new ClaudeSdkAdapter({
      onEvent, apiKey: config.anthropicApiKey,
      enabled: config.claudeMode !== 'false',
    });
    const onHookSeen = ({ provider, at }) => {
      this.capabilityState[`${provider}HooksLastSeenAt`] = at;
      this.onCapabilitiesChanged(this.capabilities());
    };
    this.claudeHooks = new ClaudeHookBridge({ store, approvalTtlMs: config.approvalTtlMs, onSeen: onHookSeen });
    this.codexHooks = new CodexHookBridge({ store, approvalTtlMs: config.approvalTtlMs, onSeen: onHookSeen });
  }

  capabilities() {
    return { ...this.capabilityState };
  }

  async start() {
    await this.store.clearTasksByPrefix('demo-showcase-');
    if (this.config.demoMode) {
      await this.demo.seed(this.store.snapshot().tasks);
    }
    if (this.config.codexMode !== 'false') {
      try {
        await this.codex.start();
        this.capabilityState.codex = this.codex.isReady();
      } catch (error) {
        console.warn(`[AgentsView] Codex adapter unavailable: ${error.message}`);
      }
    }
    if (this.config.claudeMode !== 'false') {
      this.capabilityState.claude = await this.claude.start();
      if (!this.capabilityState.claude && this.config.anthropicApiKey) {
        console.warn('[AgentsView] Claude Agent SDK package is unavailable; Hooks remain usable when configured.');
      }
    }
    this.onCapabilitiesChanged(this.capabilities());
  }

  enqueueEvent(event) {
    const operation = this.eventQueue.then(() => this.handleEvent(event));
    this.eventQueue = operation.catch((error) => console.error('[AgentsView] Adapter event failed:', error));
    return operation;
  }

  setApprovalExpiryHandler(handler) {
    if (typeof handler !== 'function') throw new TypeError('Approval expiry handler must be a function.');
    this.approvalExpiryHandler = handler;
    for (const approval of this.store.snapshot().approvals) {
      if (approval.state === 'pending') this.scheduleApprovalExpiry(approval);
    }
  }

  clearApprovalExpiry(approvalId) {
    const timer = this.approvalExpiryTimers.get(approvalId);
    if (timer) clearTimeout(timer);
    this.approvalExpiryTimers.delete(approvalId);
  }

  scheduleApprovalExpiry(approval) {
    if (!approval?.id || !approval.expiresAt) return;
    this.clearApprovalExpiry(approval.id);
    const delay = Math.max(0, Date.parse(approval.expiresAt) - Date.now());
    const timer = setTimeout(() => void this.handleApprovalExpiry(approval.id), delay);
    timer.unref();
    this.approvalExpiryTimers.set(approval.id, timer);
  }

  async handleApprovalExpiry(approvalId) {
    this.approvalExpiryTimers.delete(approvalId);
    const approval = this.store.getApproval(approvalId);
    if (!approval || approval.state !== 'pending') return false;
    if (!this.approvalExpiryHandler) {
      console.error(`[AgentsView] Approval ${approvalId} expired without an expiry handler.`);
      return false;
    }
    try {
      return await this.approvalExpiryHandler(approvalId);
    } catch (error) {
      console.error(`[AgentsView] Could not expire approval ${approvalId}:`, error);
      return false;
    }
  }

  async handleEvent(event) {
    const taskId = event.taskId;
    switch (event.type) {
      case 'task.seed':
        await this.store.upsertTask({
          id: taskId, title: event.title, agent: event.agent, status: event.status,
          outcome: event.outcome, summary: event.summary, cwd: event.cwd,
          startedAt: event.startedAt, updatedAt: event.completedAt || event.updatedAt,
          completedAt: event.completedAt,
          tokens: event.tokens, costUsd: event.costUsd, activity: event.activity,
        });
        return;
      case 'task.started':
        if (this.store.getTask(taskId)?.status === 'completed') return;
        await this.store.upsertTask({
          id: taskId, title: event.title || this.store.getTask(taskId)?.title,
          agent: event.agent || event.provider, status: 'running',
          summary: event.summary || 'Agent started working…', cwd: event.cwd,
          externalId: event.threadId || event.externalId,
        });
        return;
      case 'task.external':
        await this.store.upsertTask({ id: taskId, externalId: event.externalId });
        return;
      case 'task.status': {
        if (!taskId || this.store.getTask(taskId)?.status === 'completed') return;
        if (event.status === 'error') {
          await this.store.upsertTask({
            id: taskId, status: 'completed', outcome: 'failed',
            summary: event.message || statusLabel(event.status), completedAt: event.at || isoNow(),
          });
          return;
        }
        const status = event.status === 'waiting_approval' ? 'waiting_approval' : 'running';
        await this.store.upsertTask({ id: taskId, status, summary: event.message || statusLabel(event.status) });
        return;
      }
      case 'task.completed':
        if (!taskId || this.store.getTask(taskId)?.status === 'completed') return;
        await this.store.upsertTask({
          id: taskId, status: 'completed', outcome: normalizeOutcome(event.outcome),
          summary: event.message || this.store.getTask(taskId)?.summary || completionLabel(event.outcome), completedAt: event.at || isoNow(),
          ...(event.data?.total_cost_usd != null ? { costUsd: event.data.total_cost_usd } : {}),
        });
        return;
      case 'task.error':
        if (taskId && this.store.getTask(taskId)?.status !== 'completed') {
          await this.store.upsertTask({ id: taskId, status: 'completed', outcome: 'failed', summary: readableError(event.message), completedAt: event.at || isoNow() });
        }
        return;
      case 'approval.requested':
        await this.registerApproval(event);
        return;
      case 'approval.resolved': {
        const approval = this.store.findApprovalByAdapterRef(event.provider, event.requestId);
        if (approval) this.clearApprovalExpiry(approval.id);
        if (approval && ['pending', 'submitting'].includes(approval.state)) await this.store.cancelApproval(approval.id);
        return;
      }
      case 'item.started':
      case 'item.completed': {
        if (!taskId) return;
        const item = event.data || {};
        await this.store.addActivity(taskId, {
          type: event.type, label: boundedText(item.type || item.label, 100, event.type),
          detail: commandSummary(item.type, item), at: event.at,
        });
        return;
      }
      case 'output.delta':
        this.bufferOutput(taskId, event.delta);
        return;
      case 'token.usage':
        if (taskId) await this.store.upsertTask({ id: taskId, tokens: normalizeTokens(event.data) });
        return;
      case 'adapter.ready':
        if (event.provider === 'codex') this.capabilityState.codex = true;
        this.onCapabilitiesChanged(this.capabilities());
        return;
      case 'adapter.exit':
        if (event.provider === 'codex') this.capabilityState.codex = false;
        this.onCapabilitiesChanged(this.capabilities());
        return;
      default:
        return;
    }
  }

  async registerApproval(event) {
    if (!event.taskId) return;
    const task = this.store.getTask(event.taskId);
    if (!task) {
      await this.store.upsertTask({
        id: event.taskId, title: event.title || 'Agent task', agent: event.provider,
        status: 'running', summary: 'Agent is requesting approval.',
      });
    }
    const toolName = event.data?.toolName || event.approvalKind || 'Tool';
    const rawSummary = event.summary || event.data?.command || commandSummary(toolName, event.data?.input || event.data);
    const nativeRequestId = String(event.requestId ?? event.rpcId ?? `${event.taskId}:${event.itemId || event.at || 'request'}`);
    const approvalId = event.approvalId || `approval-${hashText(`${event.provider}\u0000${nativeRequestId}`)}`;
    const existing = this.store.findApprovalByAdapterRef(event.provider, nativeRequestId);
    const approval = await this.store.createApproval({
      id: approvalId,
      taskId: event.taskId,
      kind: event.approvalKind === 'file-change' ? 'file_change' : (event.approvalKind || 'tool'),
      risk: event.risk || assessRisk(toolName, event.data?.input || event.data),
      title: event.title || approvalTitle(event.approvalKind, event.provider),
      summary: rawSummary,
      details: approvalDetails(event),
      requestedAt: event.at || isoNow(),
      expiresAt: new Date(Date.now() + this.config.approvalTtlMs).toISOString(),
      adapterRef: { adapter: event.provider, requestId: nativeRequestId },
    });
    if (existing) {
      if (['pending', 'submitting'].includes(existing.state)) this.scheduleApprovalExpiry(existing);
      return;
    }
    this.scheduleApprovalExpiry(approval);
    await this.audit.write('approval.requested', {
      approvalId: approval.id, taskId: event.taskId, adapter: event.provider,
      kind: approval.kind, risk: approval.risk, summaryHash: hashText(approval.summary),
    });
  }

  bufferOutput(taskId, delta) {
    if (!taskId || !delta) return;
    if (this.store.getTask(taskId)?.status === 'completed') return;
    const combined = `${this.outputBuffers.get(taskId) || ''}${delta}`.slice(-900);
    this.outputBuffers.set(taskId, combined);
    if (this.outputTimers.has(taskId)) return;
    const timer = setTimeout(async () => {
      this.outputTimers.delete(taskId);
      const summary = boundedText(this.outputBuffers.get(taskId), 520);
      this.outputBuffers.delete(taskId);
      if (summary) await this.store.upsertTask({ id: taskId, summary }).catch(() => {});
    }, 700);
    this.outputTimers.set(taskId, timer);
  }

  async launch({ agent, title, prompt, cwd }) {
    const adapter = agent === 'codex' ? this.codex : agent === 'claude' ? this.claude : this.demo;
    if (!adapter?.isReady()) throw Object.assign(new Error(`${agent} adapter is unavailable.`), { statusCode: 503, code: 'adapter_unavailable' });
    const taskId = randomId('task-');
    await this.store.upsertTask({ id: taskId, title, agent, status: 'running', summary: 'Starting agent…', cwd, startedAt: isoNow() });
    await this.audit.write('task.queued', { taskId, adapter: agent, cwd, promptHash: hashText(prompt) });
    void adapter.launch({ taskId, title, prompt, cwd })
      .then(() => this.audit.write('task.started', { taskId, adapter: agent, cwd }))
      .catch(async (error) => {
        await this.store.upsertTask({ id: taskId, status: 'completed', outcome: 'failed', summary: readableError(error.message), completedAt: isoNow() });
        await this.audit.write('task.start_failed', { taskId, adapter: agent, error: error.message });
      });
    return this.store.publicTask(this.store.getTask(taskId));
  }

  resolveApproval(approval, decision) {
    const ref = approval.adapterRef;
    if (!ref) throw new Error('Approval has no owning adapter.');
    if (ref.adapter === 'codex') return this.codex.resolveApproval(ref.requestId, decision);
    if (ref.adapter === 'claude') return this.claude.resolveApproval(ref.requestId, decision);
    if (ref.adapter === 'claude-hook') return this.claudeHooks.resolveApproval(ref.requestId, decision);
    if (ref.adapter === 'codex-hook') return this.codexHooks.resolveApproval(ref.requestId, decision);
    if (ref.adapter === 'demo') return this.demo.resolveApproval(ref.requestId, decision);
    throw new Error(`Unknown approval adapter: ${ref.adapter}`);
  }

  handleClaudeHook(input) {
    return this.claudeHooks.handle(input);
  }

  handleCodexHook(input) {
    return this.codexHooks.handle(input);
  }

  async stop() {
    for (const timer of this.outputTimers.values()) clearTimeout(timer);
    this.outputTimers.clear();
    for (const timer of this.approvalExpiryTimers.values()) clearTimeout(timer);
    this.approvalExpiryTimers.clear();
    await Promise.allSettled([this.demo.stop(), this.codex.stop(), this.claude.stop(), this.claudeHooks.stop(), this.codexHooks.stop()]);
    await this.eventQueue;
  }
}

function normalizeOutcome(value) {
  if (['success', 'failed', 'cancelled', 'interrupted'].includes(value)) return value;
  if (value === 'completed') return 'success';
  return 'success';
}

function statusLabel(value) {
  if (value === 'waiting_input') return 'Waiting for input in the owning terminal.';
  if (value === 'waiting_approval') return 'Waiting for approval.';
  if (value === 'error') return 'Agent encountered a system error.';
  return 'Agent is running…';
}

function completionLabel(value) {
  if (value === 'failed') return 'Task failed.';
  if (value === 'cancelled') return 'Task was cancelled.';
  if (value === 'interrupted') return 'Task was interrupted.';
  return 'Task completed.';
}

function approvalTitle(kind, provider) {
  if (kind === 'command') return `${provider} requests command approval`;
  if (kind === 'file-change') return `${provider} requests a file change`;
  return `${provider} requests approval`;
}

function normalizeTokens(value) {
  const root = value && typeof value === 'object' ? value : {};
  const source = root.total && typeof root.total === 'object'
    ? root.total
    : (root.usage && typeof root.usage === 'object' ? root.usage : root);
  const input = Number(source.inputTokens ?? source.input_tokens ?? source.input ?? 0) || 0;
  const output = Number(source.outputTokens ?? source.output_tokens ?? source.output ?? 0) || 0;
  const total = Number(source.totalTokens ?? source.total_tokens ?? (typeof source.total === 'number' ? source.total : input + output)) || input + output;
  return { input, output, total };
}

function approvalDetails(event) {
  const data = event.data && typeof event.data === 'object' ? event.data : {};
  const parts = [];
  const base = event.details || data.reason;
  if (base) parts.push(boundedText(base, 600));
  const network = data.network ?? data.networkApprovalContext ?? data.additionalPermissions?.network;
  if (network != null) parts.push(`Network: ${boundedText(network, 500)}`);
  if (data.grantRoot) parts.push(`Grant root: ${boundedText(data.grantRoot, 700)}`);
  if (data.permissions && network == null) parts.push(`Permissions: ${boundedText(data.permissions, 700)}`);
  return boundedText(parts.join('\n'), 1200);
}

function readableError(value) {
  const text = boundedText(value, 520, 'Agent failed.');
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      const message = boundedText(parsed.message, 300);
      const details = boundedText(parsed.additionalDetails, 180);
      if (message) return details && details !== message ? `${message} · ${details}` : message;
    }
  } catch { /* a plain error message is already suitable */ }
  return text;
}
