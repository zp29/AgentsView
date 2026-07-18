import { EventEmitter } from 'node:events';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { APPROVAL_STATES, TASK_STATUSES, basenameOnly, boundedText, isoNow, randomId } from './utils.js';

const MAX_TASKS = 240;
const MAX_ACTIVITY = 80;

function copy(value) {
  return structuredClone(value);
}

function normalizeTask(input) {
  const now = isoNow();
  const status = TASK_STATUSES.has(input.status) ? input.status : 'running';
  return {
    id: boundedText(input.id, 160) || randomId('task-'),
    title: boundedText(input.title, 160, 'Untitled task'),
    agent: ['codex', 'claude', 'demo'].includes(input.agent) ? input.agent : 'demo',
    status,
    ...(input.outcome ? { outcome: boundedText(input.outcome, 32) } : {}),
    summary: boundedText(input.summary, 520, ''),
    cwd: boundedText(input.cwd, 1000, ''),
    startedAt: input.startedAt || now,
    updatedAt: input.updatedAt || now,
    ...(input.completedAt ? { completedAt: input.completedAt } : {}),
    tokens: {
      input: Math.max(0, Number(input.tokens?.input) || 0),
      output: Math.max(0, Number(input.tokens?.output) || 0),
      total: Math.max(0, Number(input.tokens?.total) || 0),
    },
    costUsd: Math.max(0, Number(input.costUsd) || 0),
    activity: Array.isArray(input.activity) ? input.activity.slice(-MAX_ACTIVITY) : [],
    externalId: boundedText(input.externalId, 240, ''),
  };
}

function normalizeApproval(input) {
  const state = APPROVAL_STATES.has(input.state) ? input.state : 'pending';
  return {
    id: boundedText(input.id, 160) || randomId('approval-'),
    taskId: boundedText(input.taskId, 160),
    kind: ['command', 'file_change', 'permissions', 'tool'].includes(input.kind) ? input.kind : 'tool',
    risk: ['low', 'medium', 'high'].includes(input.risk) ? input.risk : 'medium',
    title: boundedText(input.title, 180, 'Approval required'),
    summary: boundedText(input.summary, 520, ''),
    details: boundedText(input.details, 1200, ''),
    requestedAt: input.requestedAt || isoNow(),
    expiresAt: input.expiresAt || null,
    state,
    decision: input.decision || null,
    decisionAt: input.decisionAt || null,
    actor: input.actor ? boundedText(input.actor, 120) : null,
    adapterRef: input.adapterRef && typeof input.adapterRef === 'object' ? input.adapterRef : null,
    deliveryError: input.deliveryError ? boundedText(input.deliveryError, 300) : null,
  };
}

export class StateStore extends EventEmitter {
  constructor(dataDir) {
    super();
    this.dataDir = dataDir;
    this.stateFile = path.join(dataDir, 'state.json');
    this.tasks = new Map();
    this.approvals = new Map();
    this.operation = Promise.resolve();
  }

  async init() {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    await chmod(this.dataDir, 0o700).catch(() => {});
    try {
      const persisted = JSON.parse(await readFile(this.stateFile, 'utf8'));
      for (const task of persisted.tasks || []) {
        const normalized = normalizeTask(task);
        if (normalized.status !== 'completed') {
          normalized.status = 'completed';
          normalized.outcome = 'interrupted';
          normalized.completedAt = isoNow();
          normalized.updatedAt = normalized.completedAt;
          normalized.summary = normalized.summary || 'Service restarted before the task finished.';
        }
        this.tasks.set(normalized.id, normalized);
      }
      for (const approval of persisted.approvals || []) {
        const normalized = normalizeApproval(approval);
        if (normalized.state === 'pending' || normalized.state === 'submitting') {
          normalized.state = 'expired';
          normalized.decisionAt = isoNow();
        }
        this.approvals.set(normalized.id, normalized);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await this.persist();
  }

  mutate(mutator) {
    const next = this.operation.then(async () => {
      const result = await mutator();
      this.prune();
      await this.persist();
      this.emit('changed');
      return result;
    });
    this.operation = next.catch(() => {});
    return next;
  }

  async persist() {
    const temporary = `${this.stateFile}.${process.pid}.tmp`;
    const payload = JSON.stringify({
      version: 1,
      savedAt: isoNow(),
      tasks: [...this.tasks.values()],
      approvals: [...this.approvals.values()],
    }, null, 2);
    await writeFile(temporary, payload, { mode: 0o600 });
    await rename(temporary, this.stateFile);
  }

  prune() {
    if (this.tasks.size <= MAX_TASKS) return;
    const removable = [...this.tasks.values()]
      .filter((task) => task.status === 'completed')
      .sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)));
    for (const task of removable.slice(0, this.tasks.size - MAX_TASKS)) {
      this.tasks.delete(task.id);
      for (const approval of this.approvals.values()) {
        if (approval.taskId === task.id) this.approvals.delete(approval.id);
      }
    }
  }

  snapshot(capabilities = {}) {
    return {
      tasks: [...this.tasks.values()].map((task) => this.publicTask(task)),
      approvals: [...this.approvals.values()].map((approval) => this.publicApproval(approval)),
      capabilities,
    };
  }

  publicTask(task) {
    const result = copy(task);
    delete result.externalId;
    result.cwd = basenameOnly(task.cwd);
    return result;
  }

  publicApproval(approval) {
    const result = copy(approval);
    delete result.adapterRef;
    delete result.actor;
    delete result.deliveryError;
    return result;
  }

  getTask(id) {
    return this.tasks.get(id) || null;
  }

  getApproval(id) {
    return this.approvals.get(id) || null;
  }

  findTaskByExternalId(agent, externalId) {
    return [...this.tasks.values()].filter((task) => task.agent === agent && task.externalId === externalId).at(-1) || null;
  }

  findApprovalByAdapterRef(adapter, requestId) {
    return [...this.approvals.values()].find((approval) =>
      approval.adapterRef?.adapter === adapter && String(approval.adapterRef?.requestId) === String(requestId)
    ) || null;
  }

  clearTasksByPrefix(prefix) {
    const normalizedPrefix = boundedText(prefix, 120);
    if (!normalizedPrefix) return Promise.resolve(0);
    return this.mutate(() => {
      const taskIds = [...this.tasks.keys()].filter((id) => id.startsWith(normalizedPrefix));
      const removed = new Set(taskIds);
      for (const id of taskIds) this.tasks.delete(id);
      for (const approval of [...this.approvals.values()]) {
        if (removed.has(approval.taskId)) this.approvals.delete(approval.id);
      }
      return taskIds.length;
    });
  }

  upsertTask(input) {
    return this.mutate(() => {
      const current = this.tasks.get(input.id);
      const definedInput = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
      if (current?.status === 'completed' && definedInput.status && definedInput.status !== 'completed') {
        delete definedInput.status;
        delete definedInput.outcome;
        delete definedInput.completedAt;
      }
      const merged = normalizeTask({ ...current, ...definedInput, updatedAt: input.updatedAt || isoNow() });
      if (merged.status === 'completed' && !merged.completedAt) merged.completedAt = merged.updatedAt;
      if (merged.status !== 'completed') {
        delete merged.completedAt;
        delete merged.outcome;
      }
      this.tasks.set(merged.id, merged);
      return copy(merged);
    });
  }

  addActivity(taskId, activity) {
    return this.mutate(() => {
      const task = this.tasks.get(taskId);
      if (!task) return null;
      const item = {
        id: boundedText(activity.id, 160) || randomId('activity-'),
        type: boundedText(activity.type, 48, 'event'),
        label: boundedText(activity.label, 220, 'Activity'),
        detail: boundedText(activity.detail, 700, ''),
        at: activity.at || isoNow(),
      };
      task.activity = [...(task.activity || []), item].slice(-MAX_ACTIVITY);
      task.updatedAt = item.at;
      if (activity.summary) task.summary = boundedText(activity.summary, 520);
      return copy(item);
    });
  }

  createApproval(input) {
    return this.mutate(() => {
      const existing = this.findApprovalByAdapterRef(input.adapterRef?.adapter, input.adapterRef?.requestId);
      if (existing) return copy(existing);
      const approval = normalizeApproval({ ...input, id: input.id || randomId('approval-'), state: 'pending' });
      this.approvals.set(approval.id, approval);
      const task = this.tasks.get(approval.taskId);
      if (task && task.status !== 'completed') {
        task.status = 'waiting_approval';
        task.updatedAt = isoNow();
      }
      return copy(approval);
    });
  }

  beginDecision(id, decision, actor) {
    return this.mutate(() => {
      const approval = this.approvals.get(id);
      if (!approval) throw Object.assign(new Error('Approval request was not found.'), { statusCode: 404, code: 'approval_not_found' });
      if (approval.expiresAt && Date.parse(approval.expiresAt) <= Date.now() && ['pending', 'submitting'].includes(approval.state)) {
        return { approval: copy(approval), idempotent: false, expired: true };
      }
      if (['approved', 'denied'].includes(approval.state)) {
        if (approval.decision === decision) return { approval: copy(approval), idempotent: true };
        throw Object.assign(new Error('This request already has the opposite decision.'), { statusCode: 409, code: 'decision_conflict' });
      }
      if (approval.state === 'expired' || approval.state === 'cancelled') {
        throw Object.assign(new Error('This approval request is no longer active.'), { statusCode: 410, code: 'approval_stale' });
      }
      if (approval.state === 'submitting') {
        throw Object.assign(new Error('A decision is already being delivered.'), { statusCode: 409, code: 'decision_in_flight' });
      }
      approval.state = 'submitting';
      approval.decision = decision;
      approval.actor = boundedText(actor, 120, 'session');
      approval.deliveryError = null;
      return { approval: copy(approval), idempotent: false };
    });
  }

  beginExpiry(id) {
    return this.mutate(() => {
      const approval = this.approvals.get(id);
      if (!approval || approval.state !== 'pending') return null;
      approval.state = 'submitting';
      approval.decision = 'deny';
      approval.actor = 'system:timeout';
      approval.deliveryError = null;
      return copy(approval);
    });
  }

  completeDecision(id) {
    return this.mutate(() => {
      const approval = this.approvals.get(id);
      if (!approval) return null;
      approval.state = approval.decision === 'allow' ? 'approved' : 'denied';
      approval.decisionAt = isoNow();
      this.refreshTaskAfterApproval(approval);
      return copy(approval);
    });
  }

  completeExpiry(id, deliveryError = null) {
    return this.mutate(() => {
      const approval = this.approvals.get(id);
      if (!approval || approval.state !== 'submitting' || approval.actor !== 'system:timeout') return approval ? copy(approval) : null;
      approval.state = 'expired';
      approval.decision = null;
      approval.decisionAt = isoNow();
      approval.deliveryError = deliveryError ? boundedText(deliveryError?.message || deliveryError, 300) : null;
      this.refreshTaskAfterApproval(approval);
      return copy(approval);
    });
  }

  rollbackDecision(id, error) {
    return this.mutate(() => {
      const approval = this.approvals.get(id);
      if (!approval || approval.state !== 'submitting') return null;
      approval.state = 'pending';
      approval.deliveryError = boundedText(error?.message || error, 300);
      approval.decision = null;
      approval.actor = null;
      return copy(approval);
    });
  }

  expireApproval(id) {
    return this.mutate(() => {
      const approval = this.approvals.get(id);
      if (!approval || !['pending', 'submitting'].includes(approval.state)) return approval ? copy(approval) : null;
      approval.state = 'expired';
      approval.decision = null;
      approval.decisionAt = isoNow();
      this.refreshTaskAfterApproval(approval);
      return copy(approval);
    });
  }

  cancelApproval(id) {
    return this.mutate(() => {
      const approval = this.approvals.get(id);
      if (!approval || !['pending', 'submitting'].includes(approval.state)) return approval ? copy(approval) : null;
      approval.state = 'cancelled';
      approval.decisionAt = isoNow();
      this.refreshTaskAfterApproval(approval);
      return copy(approval);
    });
  }

  refreshTaskAfterApproval(approval) {
    const task = this.tasks.get(approval.taskId);
    if (!task || task.status === 'completed') return;
    const stillWaiting = [...this.approvals.values()].some((candidate) =>
      candidate.taskId === task.id && candidate.id !== approval.id && ['pending', 'submitting'].includes(candidate.state)
    );
    task.status = stillWaiting ? 'waiting_approval' : 'running';
    task.updatedAt = approval.decisionAt || isoNow();
  }
}
