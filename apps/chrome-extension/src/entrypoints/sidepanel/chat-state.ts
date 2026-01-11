import type { ChatMessage } from './types'

export type ChatHistoryLimits = {
  maxMessages: number
  maxChars: number
}

export type ChatContextUsage = {
  totalChars: number
  percent: number
  totalMessages: number
}

function messageTextLength(message: ChatMessage): number {
  if (message.role === 'user') {
    if (typeof message.content === 'string') return message.content.length
    return message.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('').length
  }
  if (message.role === 'assistant') {
    if (typeof message.content === 'string') return message.content.length
    return message.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('').length
  }
  if (message.role === 'toolResult') {
    if (typeof message.content === 'string') return message.content.length
    return message.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('').length
  }
  return 0
}

export function compactChatHistory(
  messages: ChatMessage[],
  limits: ChatHistoryLimits
): ChatMessage[] {
  const filtered = messages.filter((msg) => {
    if (msg.role !== 'user') return true
    return messageTextLength(msg) > 0
  })
  const trimmed: ChatMessage[] = []
  let totalChars = 0
  for (let i = filtered.length - 1; i >= 0; i -= 1) {
    const msg = filtered[i]
    const len = messageTextLength(msg)
    if (trimmed.length >= limits.maxMessages) break
    if (trimmed.length > 0 && totalChars + len > limits.maxChars) break
    trimmed.push(msg)
    totalChars += len
  }
  return trimmed.reverse()
}

export function computeChatContextUsage(
  messages: ChatMessage[],
  limits: ChatHistoryLimits
): ChatContextUsage {
  const totalChars = messages.reduce((sum, msg) => sum + messageTextLength(msg), 0)
  const percent = Math.min(100, Math.round((totalChars / limits.maxChars) * 100))
  return { totalChars, percent, totalMessages: messages.length }
}

export function hasUserChatMessage(messages: ChatMessage[]): boolean {
  return messages.some((msg) => msg.role === 'user' && messageTextLength(msg) > 0)
}

export function buildChatRequestMessages(messages: ChatMessage[]) {
  return messages
    .filter((message) => messageTextLength(message) > 0)
    .map(({ id: _id, timestamp: _timestamp, ...rest }) => rest)
}
