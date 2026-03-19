import type { BoardItem } from '@myteacher/shared';

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ConversationEvent {
  role: 'system-event';
  content: string;
}

export type HistoryEntry = ConversationTurn | ConversationEvent;

export class ConversationHistory {
  private entries: HistoryEntry[] = [];
  private maxTurns = 20;
  private maxChars = 3000;

  addUserMessage(text: string): void {
    const last = this.entries[this.entries.length - 1];
    // Merge consecutive user messages (barge-in scenario)
    if (last && last.role === 'user') {
      last.content += ' ' + text;
    } else {
      this.entries.push({ role: 'user', content: text });
    }
    this.trim();
  }

  addAssistantMessage(text: string): void {
    this.entries.push({ role: 'assistant', content: text });
    this.trim();
  }

  addBoardEvent(boardItems: BoardItem[]): void {
    const summary = boardItems
      .map((item) => {
        if (item.type === 'list') return `${item.type}: ${item.items.join(', ')}`;
        if (item.type === 'drawing') return `drawing: [${item.steps.length} adım]`;
        return `${item.type}: ${item.text}`;
      })
      .join(' | ');
    this.entries.push({ role: 'system-event', content: `[Tahta güncellendi] ${summary}` });
    this.trim();
  }

  /** Format for Claude API: user/assistant alternation, system-events folded into adjacent user messages */
  getMessagesForClaude(): { role: 'user' | 'assistant'; content: string }[] {
    const messages: { role: 'user' | 'assistant'; content: string }[] = [];

    for (const entry of this.entries) {
      if (entry.role === 'system-event') {
        // Fold into previous user message or create a new one
        const last = messages[messages.length - 1];
        if (last && last.role === 'user') {
          last.content += '\n' + entry.content;
        } else {
          messages.push({ role: 'user', content: entry.content });
        }
      } else {
        messages.push({ role: entry.role, content: entry.content });
      }
    }

    // Claude requires first message to be 'user'
    while (messages.length > 0 && messages[0].role !== 'user') {
      messages.shift();
    }

    return messages;
  }

  /** Format for Gemini API: user/model roles with parts */
  getMessagesForGemini(): { role: 'user' | 'model'; parts: { text: string }[] }[] {
    const claudeMessages = this.getMessagesForClaude();
    return claudeMessages.map((m) => ({
      role: m.role === 'assistant' ? 'model' as const : 'user' as const,
      parts: [{ text: m.content }],
    }));
  }

  private trim(): void {
    // Trim by turn count
    while (this.entries.length > this.maxTurns) {
      this.entries.shift();
    }

    // Trim by character count
    let totalChars = this.entries.reduce((sum, e) => sum + e.content.length, 0);
    while (totalChars > this.maxChars && this.entries.length > 1) {
      const removed = this.entries.shift()!;
      totalChars -= removed.content.length;
    }
  }
}
