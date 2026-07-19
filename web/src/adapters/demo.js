import { randomId, isoNow } from '../utils.js';

export class DemoAdapter {
  constructor({ onEvent }) {
    this.onEvent = onEvent;
    this.pending = new Map();
    this.timers = new Set();
    this.stopped = false;
  }

  isReady() {
    return !this.stopped;
  }

  async seed(existingTasks = []) {
    if (existingTasks.some((task) => task.id.startsWith('demo-') && task.status !== 'completed')) return;
    const batch = 'showcase';
    const ago = (seconds) => new Date(Date.now() - seconds * 1000).toISOString();
    const task = (suffix, data) => ({
      type: 'task.seed',
      taskId: `demo-${batch}-${suffix}`,
      provider: 'demo',
      at: isoNow(),
      ...data,
    });

    await this.onEvent(task('payment', {
      title: '重构支付模块', agent: 'demo', status: 'running',
      summary: '正在梳理支付状态机并运行回归测试…', cwd: '/workspace/payments', startedAt: ago(286),
      tokens: { input: 28400, output: 9200, total: 37600 }, costUsd: 0.228,
      activity: [
        { id: randomId('activity-'), type: 'edit', label: 'Edit', detail: 'src/payments/state-machine.ts', at: ago(31) },
        { id: randomId('activity-'), type: 'test', label: 'Bash', detail: 'npm test -- --coverage', at: ago(8) },
      ],
    }));
    await this.onEvent(task('api', {
      title: '整理用户 API', agent: 'demo', status: 'running',
      summary: '正在对照接口定义补齐参数校验…', cwd: '/workspace/api', startedAt: ago(173),
      tokens: { input: 14300, output: 5100, total: 19400 }, costUsd: 0.094,
      activity: [{ id: randomId('activity-'), type: 'read', label: 'Read', detail: 'src/routes/users.ts', at: ago(16) }],
    }));
    await this.onEvent(task('docs', {
      title: '更新部署文档', agent: 'demo', status: 'running',
      summary: '正在核对生产环境变量与升级步骤…', cwd: '/workspace/docs', startedAt: ago(91),
      tokens: { input: 7600, output: 2800, total: 10400 }, costUsd: 0.051,
      activity: [{ id: randomId('activity-'), type: 'write', label: 'Write', detail: 'docs/deployment.md', at: ago(11) }],
    }));

    const testTaskId = `demo-${batch}-tests`;
    const deployTaskId = `demo-${batch}-deploy`;
    await this.onEvent(task('tests', {
      title: '修复测试环境', agent: 'demo', status: 'running',
      summary: '测试需要环境变量，准备写入 mock 配置。', cwd: '/workspace/web', startedAt: ago(132),
      tokens: { input: 2500, output: 900, total: 3400 }, costUsd: 0.021,
    }));
    await this.requestApproval({
      taskId: testTaskId,
      approvalId: 'demo-approval-tests',
      requestId: 'demo-request-tests',
      title: '允许写入测试配置？',
      kind: 'file_change', risk: 'medium',
      summary: 'Edit: jest.config.ts',
      details: '加入仅用于测试的环境变量 mock。',
    });
    await this.onEvent(task('deploy', {
      title: '发布预览环境', agent: 'demo', status: 'running',
      summary: '构建已完成，等待执行部署命令。', cwd: '/workspace/portal', startedAt: ago(74),
      tokens: { input: 6100, output: 1900, total: 8000 }, costUsd: 0.047,
    }));
    await this.requestApproval({
      taskId: deployTaskId,
      approvalId: 'demo-approval-deploy',
      requestId: 'demo-request-deploy',
      title: '允许执行部署命令？',
      kind: 'command', risk: 'high',
      summary: 'Bash: npm run deploy:preview',
      details: '将当前分支部署到受限的预览环境。',
    });
    await this.onEvent(task('complete', {
      title: '清理废弃类型', agent: 'demo', status: 'completed', outcome: 'success',
      summary: '删除 6 个废弃类型，类型检查和单元测试均通过。', cwd: '/workspace/shared',
      startedAt: ago(305), completedAt: ago(27),
      tokens: { input: 9200, output: 3300, total: 12500 }, costUsd: 0.067,
      activity: [{ id: randomId('activity-'), type: 'complete', label: 'Completed', detail: '42 tests passed', at: ago(27) }],
    }));
  }

  async launch({ taskId, title, prompt, cwd }) {
    await this.onEvent({
      type: 'task.started', provider: 'demo', taskId, title, agent: 'demo', status: 'running',
      summary: 'Demo agent is examining the request…', cwd, at: isoNow(),
    });
    this.later(1300, async () => {
      if (this.stopped) return;
      await this.onEvent({
        type: 'item.started', provider: 'demo', taskId, at: isoNow(),
        data: { type: 'analysis', label: 'Analyze', detail: String(prompt).slice(0, 240) },
      });
      await this.requestApproval({
        taskId,
        title: '允许执行演示操作？',
        kind: 'command', risk: 'medium',
        summary: 'Bash: npm test',
        details: 'Demo 请求；批准后会模拟测试通过并完成任务。',
      });
    });
    return { taskId };
  }

  async requestApproval({ taskId, approvalId, requestId = randomId('demo-request-'), title, kind, risk, summary, details }) {
    this.pending.set(requestId, { taskId, decision: null });
    await this.onEvent({
      type: 'approval.requested', provider: 'demo', taskId, requestId,
      approvalId,
      approvalKind: kind, risk, title, summary, details, status: 'waiting_approval', at: isoNow(),
      data: { command: summary, reason: details },
    });
    return requestId;
  }

  async resolveApproval(requestId, decision) {
    const pending = this.pending.get(requestId);
    if (!pending) throw new Error(`Demo approval is no longer pending: ${requestId}`);
    if (pending.decision && pending.decision !== decision) throw new Error('Demo approval already received the opposite decision.');
    if (pending.decision === decision) return { requestId, decision, delivered: true };
    pending.decision = decision;
    await this.onEvent({
      type: 'approval.responded', provider: 'demo', taskId: pending.taskId, requestId, decision, at: isoNow(),
    });
    if (decision === 'deny') {
      this.later(250, () => this.onEvent({
        type: 'task.completed', provider: 'demo', taskId: pending.taskId,
        outcome: 'cancelled', status: 'completed', message: '操作被拒绝，演示任务已取消。', at: isoNow(),
      }));
    } else {
      await this.onEvent({
        type: 'task.status', provider: 'demo', taskId: pending.taskId, status: 'running',
        message: '审批通过，继续执行测试…', at: isoNow(),
      });
      this.later(1900, () => this.onEvent({
        type: 'task.completed', provider: 'demo', taskId: pending.taskId,
        outcome: 'success', status: 'completed', message: '操作执行完成，测试全部通过。', at: isoNow(),
      }));
    }
    return { requestId, decision, delivered: true };
  }

  later(milliseconds, callback) {
    const timer = setTimeout(async () => {
      this.timers.delete(timer);
      try { await callback(); } catch { /* demo failures must not stop the server */ }
    }, milliseconds);
    this.timers.add(timer);
    return timer;
  }

  async stop() {
    this.stopped = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.pending.clear();
  }
}
