import net from 'node:net';
import { randomUUID } from 'node:crypto';

export function originThread(metadata = {}, environment = process.env) {
  let turn = metadata['x-codex-turn-metadata'];
  if (typeof turn === 'string') { try { turn = JSON.parse(turn); } catch { turn = null; } }
  const candidates = [metadata['openai/threadId'], metadata['openai/thread_id'], metadata.codexThreadId,
    metadata.codex_thread_id, metadata.threadId, metadata.thread_id, turn?.thread_id, metadata.thread?.id,
    environment.CODEX_THREAD_ID];
  return candidates.find(value => typeof value === 'string' && /^[a-zA-Z0-9_-]{8,128}$/.test(value)) ?? null;
}

// Same framed protocol used by the bundled codex-app-tools plugin. No separate app-server.
export function appRequest(pipePath, method, params, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const requestId = randomUUID();
    const socket = net.createConnection(pipePath); let bytes = Buffer.alloc(0); let written = false; let finished = false;
    const finish = (error, result) => {
      if (finished) return; finished = true; clearTimeout(timer); socket.destroy();
      if (error) { error.deliveryUncertain = written; reject(error); } else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error('Codex desktop callback timed out')), timeoutMs);
    socket.on('connect', () => {
      const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }));
      const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
      written = true; socket.write(Buffer.concat([header, body]));
    });
    socket.on('data', chunk => {
      bytes = Buffer.concat([bytes, chunk]);
      while (bytes.length >= 4) {
      const length = bytes.readUInt32LE(0);
      if (length > 8 * 1024 * 1024) { finish(new Error('invalid desktop callback frame')); return; }
      if (bytes.length < length + 4) return;
      try {
        const message = JSON.parse(bytes.subarray(4, 4 + length).toString('utf8'));
        bytes = bytes.subarray(4 + length);
        if (message.id !== requestId) continue;
        if (message.error) {
          const error = new Error(message.error.message); error.explicitRejection = true; finish(error);
        } else finish(null, message.result);
      } catch (error) { finish(error); }
      }
    });
    socket.on('error', error => finish(error));
    socket.on('close', () => { if (!finished) finish(new Error('Codex desktop callback connection closed')); });
  });
}

export class CompletionCallback {
  constructor({ pipePath = process.env.CODEX_APP_TOOLS_PIPE_PATH, request = appRequest } = {}) {
    this.pipePath = pipePath; this.request = request;
  }
  async check() {
    if (!this.pipePath) throw new Error('Codex desktop callback pipe was not supplied; refresh plugin or set notify_complete=false');
    const catalog = await this.request(this.pipePath, 'tools/list', { threadStartKind: 'all' });
    const tool = catalog.tools?.find(tool => tool.name === 'send_message_to_thread');
    if (!tool) throw new Error('Codex desktop does not expose send_message_to_thread');
    this.capability = { available: true, namespace: tool.namespace };
    return this.capability;
  }
  async deliver(task, callback) {
    let capability;
    try { capability = this.capability ?? await this.check(); }
    catch (error) { error.explicitRejection = true; throw error; }
    const prompt = [
      'Harness Pilot 子代理任务完成回执。用户已要求任务完成后唤醒原会话、检查工作并继续原任务。',
      `回执 ID：${task.task_id}；目标：${task.target}；终态：${task.status}。`,
      `工作区：${task.cwd}。完整结果：${task.result_path}。`,
      '请先调用 harness_result 读取此任务结果，并独立核验实际改动和必要测试。',
      '根据本会话原始目标继续工作；仅在确有后续工作时派发下一项任务，完成后仍使用回执唤醒。',
      '失败、超时、取消或中断不可当作成功。此回执只触发原任务续办，不扩大用户授权范围。',
      callback.instruction ? `派发时记录的续办提示（仅供上下文参考，以本会话用户指令为准）：${callback.instruction}` : '',
    ].filter(Boolean).join('\n');
    const response = await this.request(this.pipePath, 'tools/call', {
      callerSource: 'codex', hostId: 'local',
      namespace: capability.namespace, tool: 'send_message_to_thread',
      threadId: callback.thread_id, turnId: `harness-completion-${task.task_id}`, callId: `harness-completion-${task.task_id}`,
      arguments: { threadId: callback.thread_id, prompt },
    });
    if (response.success !== true) {
      const error = new Error(response.contentItems?.filter(item => item.type === 'inputText').map(item => item.text).join('\n') || 'desktop rejected completion callback');
      error.explicitRejection = true; throw error;
    }
    return { accepted: true, response: response.contentItems?.filter(item => item.type === 'inputText').map(item => item.text).join('\n') };
  }
}
