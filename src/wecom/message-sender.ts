import type { WSClient } from './client.js';
import { getWSClient } from './client.js';
import type { WsFrame } from '@wecom/aibot-node-sdk';
import { generateReqId } from '@wecom/aibot-node-sdk';
import { createLogger } from '../logger.js';
import { splitLongContent, buildInputSummary } from '../shared/utils.js';
import { MAX_WECOM_MESSAGE_LENGTH, WECOM_STREAM_TIMEOUT_MS } from '../constants.js';

const log = createLogger('WecomSender');

export type { WsFrame };

/**
 * 流式会话状态
 */
interface StreamSession {
  frame: WsFrame;
  chatId: string | null;
  streamId: string;
  streamStartedAt: number;
  isFirstUpdate: boolean;
  taskKey: string;
}

/**
 * 企业微信消息发送器接口
 */
export interface WecomSender {
  sendTextReply(chatId: string, text: string): Promise<void>;
  initStream(frame: WsFrame, taskKey?: string): void;
  sendStreamUpdate(content: string, toolNote?: string): Promise<void>;
  resetStreamForTextSwitch(content: string): Promise<void>;
  sendStreamComplete(content: string, note: string): Promise<void>;
  sendStreamError(error: string): Promise<void>;
  cleanupStream(): void;
  sendPermissionCard(chatId: string, requestId: string, toolName: string, toolInput: Record<string, unknown>): Promise<string>;
  updatePermissionCard(params: { messageId: string; chatId: string; toolName: string; decision: 'allow' | 'deny' }): Promise<void>;
  sendImage(chatId: string, imagePath: string): Promise<void>;
}

/**
 * 创建企业微信消息发送器
 */
export function createWecomSender(wsClient: WSClient): WecomSender {
  let session: StreamSession | null = null;

  /**
   * 如果流式消息接近超时（330s），结束当前流并开始新流。
   * 企业微信 SDK 的 replyStream(finish=true) 会终结当前流内容并展示最终文本，
   * 新流会以独立消息出现，因此重发完整内容不会导致用户侧重复显示。
   */
  async function renewStreamIfNeeded(content: string): Promise<void> {
    if (!session) return;
    const elapsed = Date.now() - session.streamStartedAt;
    if (elapsed > WECOM_STREAM_TIMEOUT_MS) {
      log.info(`Stream ${session.streamId} elapsed ${Math.round(elapsed / 1000)}s, renewing`);
      try {
        await wsClient.replyStream(session.frame, session.streamId, content, true);
      } catch (err) {
        log.warn('Failed to finish stream during renewal:', err);
      }
      session.streamId = generateReqId('stream');
      session.streamStartedAt = Date.now();
      session.isFirstUpdate = true;
    }
  }

  return {
    async sendTextReply(chatId: string, text: string): Promise<void> {
      try {
        await wsClient.sendMessage(chatId, {
          msgtype: 'markdown',
          markdown: { content: text },
        });
      } catch (err) {
        log.error('Failed to send text reply:', err);
      }
    },

    initStream(frame: WsFrame, taskKey?: string): void {
      const body = frame.body as Record<string, unknown> | undefined;
      const chatId = (body?.chatid as string) ?? (body?.from as Record<string, string>)?.userid ?? null;
      session = {
        frame,
        chatId,
        streamId: generateReqId('stream'),
        streamStartedAt: Date.now(),
        isFirstUpdate: true,
        taskKey: taskKey ?? '',
      };
    },

    async sendStreamUpdate(content: string, toolNote?: string): Promise<void> {
      if (!session) return;

      await renewStreamIfNeeded(content);

      const text = toolNote ? `${content}\n\n─────────\n${toolNote}` : content;

      try {
        if (session.isFirstUpdate && session.taskKey) {
          // 首次更新且有 taskKey：发送带停止按钮的卡片
          await wsClient.replyStreamWithCard(session.frame, session.streamId, text, false, {
            templateCard: {
              card_type: 'button_interaction',
              main_title: { title: 'Claude Code' },
              task_id: `stop_${session.taskKey}`,
              button_list: [
                { text: '⏹️ 停止', style: 3, key: `stop_${session.taskKey}` },
              ],
            },
          });
        } else {
          await wsClient.replyStream(session.frame, session.streamId, text, false);
        }
        session.isFirstUpdate = false;
      } catch (err) {
        log.warn('Failed to send stream update:', err);
      }
    },

    async resetStreamForTextSwitch(content: string): Promise<void> {
      if (!session) return;

      try {
        // 结束当前流
        await wsClient.replyStream(session.frame, session.streamId, '', true);
      } catch (err) {
        log.warn('Failed to finish stream during text switch:', err);
      }

      // 开始新流
      session.streamId = generateReqId('stream');
      session.streamStartedAt = Date.now();
      session.isFirstUpdate = true;
    },

    async sendStreamComplete(content: string, note: string): Promise<void> {
      if (!session) return;

      const parts = splitLongContent(content, MAX_WECOM_MESSAGE_LENGTH);
      const firstPart = note ? `${parts[0]}\n\n─────────\n${note}` : parts[0];

      try {
        await wsClient.replyStream(session.frame, session.streamId, firstPart, true);
      } catch (err) {
        log.warn('Failed to finish stream, falling back to sendMessage:', err);
        if (session.chatId) {
          try {
            await wsClient.sendMessage(session.chatId, {
              msgtype: 'markdown',
              markdown: { content: firstPart },
            });
          } catch (fallbackErr) {
            log.error('Fallback sendMessage also failed:', fallbackErr);
          }
        }
      }

      // 发送后续分片
      if (parts.length > 1 && session.chatId) {
        for (let i = 1; i < parts.length; i++) {
          try {
            const partText = `${parts[i]}\n\n─────────\n(续 ${i + 1}/${parts.length}) ${note}`;
            await wsClient.sendMessage(session.chatId, {
              msgtype: 'markdown',
              markdown: { content: partText },
            });
          } catch (err) {
            log.error(`Failed to send continuation part ${i + 1}/${parts.length}:`, err);
          }
        }
      }
    },

    async sendStreamError(error: string): Promise<void> {
      if (!session) return;

      const text = `❌ 错误\n\n${error}`;
      try {
        await wsClient.replyStream(session.frame, session.streamId, text, true);
      } catch (err) {
        log.warn('Failed to send stream error, falling back to sendMessage:', err);
        if (session.chatId) {
          try {
            await wsClient.sendMessage(session.chatId, {
              msgtype: 'markdown',
              markdown: { content: text },
            });
          } catch (fallbackErr) {
            log.error('Fallback sendMessage also failed:', fallbackErr);
          }
        }
      }
    },

    cleanupStream(): void {
      session = null;
    },

    async sendPermissionCard(chatId: string, requestId: string, toolName: string, toolInput: Record<string, unknown>): Promise<string> {
      const inputSummary = buildInputSummary(toolName, toolInput);
      try {
        await wsClient.sendMessage(chatId, {
          msgtype: 'template_card',
          template_card: {
            card_type: 'button_interaction',
            main_title: { title: `🔐 权限确认 - ${toolName}` },
            sub_title_text: inputSummary.length > 200 ? inputSummary.slice(0, 200) + '...' : inputSummary,
            task_id: `perm_${requestId}`,
            button_list: [
              { text: '✅ 允许', style: 1, key: `perm_allow_${requestId}` },
              { text: '❌ 拒绝', style: 3, key: `perm_deny_${requestId}` },
            ],
          },
        });
      } catch (err) {
        log.error('Failed to send permission card:', err);
      }
      // 企业微信通过 sendMessage 发送的模板卡片没有可追踪的 messageId。
      // 权限卡片的更新不依赖 messageId，而是通过 template_card_event 事件的回调帧完成（见 event-handler.ts）。
      return '';
    },

    async updatePermissionCard(params: { messageId: string; chatId: string; toolName: string; decision: 'allow' | 'deny' }): Promise<void> {
      // 企业微信的模板卡片更新通过 template_card_event 事件的回调帧完成
      // 在 event-handler 中处理，此处仅记录日志
      log.info(`Permission card update: ${params.toolName} ${params.decision} (handled via template_card_event)`);
    },

    async sendImage(chatId: string, imagePath: string): Promise<void> {
      // 企业微信智能机器人不支持独立发送图片消息
      log.info(`Image sending not supported in WeCom (path: ${imagePath})`);
    },
  };
}

/**
 * 独立的 sendTextReply 函数，使用全局 WSClient
 * 供 index.ts 等模块发送生命周期通知使用
 */
export async function sendTextReply(chatId: string, text: string): Promise<void> {
  try {
    const client = getWSClient();
    await client.sendMessage(chatId, {
      msgtype: 'markdown',
      markdown: { content: text },
    });
  } catch (err) {
    log.error('Failed to send text reply (standalone):', err);
  }
}
