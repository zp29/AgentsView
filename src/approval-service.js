import { DECISIONS, hashText } from './utils.js';

export class ApprovalService {
  constructor({ store, adapters, audit }) {
    this.store = store;
    this.adapters = adapters;
    this.audit = audit;
    this.locks = new Map();
    this.adapters.setApprovalExpiryHandler?.((id) => this.expire(id));
  }

  async decide(id, decision, actor = 'session') {
    if (!DECISIONS.has(decision)) throw Object.assign(new Error('Decision must be allow or deny.'), { statusCode: 400, code: 'invalid_decision' });
    return this.withLock(id, () => this.deliver(id, decision, actor));
  }

  async expire(id) {
    return this.withLock(id, () => this.deliverExpiry(id));
  }

  async withLock(id, callback) {
    const existing = this.locks.get(id);
    if (existing) {
      await existing.catch(() => {});
      return this.withLock(id, callback);
    }
    const operation = callback();
    this.locks.set(id, operation);
    try {
      return await operation;
    } finally {
      if (this.locks.get(id) === operation) this.locks.delete(id);
    }
  }

  async deliver(id, decision, actor) {
    const begun = await this.store.beginDecision(id, decision, actor);
    if (begun.expired) {
      await this.deliverExpiry(id);
      throw Object.assign(new Error('This approval request is no longer active.'), { statusCode: 410, code: 'approval_stale' });
    }
    if (begun.idempotent) {
      this.adapters.clearApprovalExpiry?.(id);
      return {
        approval: this.store.publicApproval(this.store.getApproval(id)),
        task: this.store.publicTask(this.store.getTask(begun.approval.taskId)),
        idempotent: true,
      };
    }
    const approval = this.store.getApproval(id);
    try {
      await this.audit.write('approval.submitted', {
        approvalId: id, taskId: approval.taskId, adapter: approval.adapterRef?.adapter,
        decision, actor, risk: approval.risk, summaryHash: hashText(approval.summary),
      });
    } catch (error) {
      await this.store.rollbackDecision(id, error).catch(() => {});
      this.adapters.scheduleApprovalExpiry?.(this.store.getApproval(id));
      throw Object.assign(new Error('The audit trail is unavailable; the decision was not sent.'), { statusCode: 503, code: 'audit_unavailable' });
    }
    try {
      await this.adapters.resolveApproval(approval, decision);
    } catch (error) {
      await this.store.rollbackDecision(id, error).catch(() => {});
      this.adapters.scheduleApprovalExpiry?.(this.store.getApproval(id));
      await this.safeAudit('approval.delivery_failed', {
        approvalId: id, taskId: approval.taskId, adapter: approval.adapterRef?.adapter, decision, actor, error: error.message,
      });
      throw Object.assign(new Error(`Could not deliver the decision: ${error.message}`), { statusCode: 502, code: 'delivery_failed' });
    }
    const completed = await this.store.completeDecision(id);
    this.adapters.clearApprovalExpiry?.(id);
    await this.store.addActivity(approval.taskId, {
      type: 'approval', label: decision === 'allow' ? 'Approved' : 'Denied', detail: approval.title,
    }).catch((error) => console.error('[AgentsView] Could not append approval activity:', error));
    await this.safeAudit('approval.delivered', {
      approvalId: id, taskId: approval.taskId, adapter: approval.adapterRef?.adapter, decision, actor,
    });
    return {
      approval: this.store.publicApproval(completed),
      task: this.store.publicTask(this.store.getTask(approval.taskId)),
      idempotent: false,
    };
  }

  async deliverExpiry(id) {
    const approval = await this.store.beginExpiry(id);
    if (!approval) return false;
    await this.safeAudit('approval.expiry_submitted', {
      approvalId: id, taskId: approval.taskId, adapter: approval.adapterRef?.adapter,
      decision: 'deny', actor: 'system:timeout', summaryHash: hashText(approval.summary),
    });
    let deliveryError = null;
    try {
      await this.adapters.resolveApproval(approval, 'deny');
    } catch (error) {
      deliveryError = error;
    }
    await this.store.completeExpiry(id, deliveryError);
    this.adapters.clearApprovalExpiry?.(id);
    await this.store.addActivity(approval.taskId, {
      type: 'approval', label: 'Expired', detail: approval.title,
    }).catch(() => {});
    await this.safeAudit('approval.expired', {
      approvalId: id, taskId: approval.taskId, adapter: approval.adapterRef?.adapter,
      delivered: !deliveryError, error: deliveryError?.message,
    });
    return true;
  }

  async safeAudit(action, fields) {
    try {
      await this.audit.write(action, fields);
    } catch (error) {
      console.error(`[AgentsView] Audit write failed for ${action}:`, error);
    }
  }
}
