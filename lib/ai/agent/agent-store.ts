export type StoredAgentMessage = {
  role: "user" | "assistant";
  content: string;
  metadata?: Record<string, unknown>;
};

export type AgentConversation = {
  metadata?: Record<string, unknown>;
};

export interface AgentConversationStore {
  getMessages(input: {
    conversationId: string;
    limit: number;
    order?: "asc" | "desc";
  }): Promise<StoredAgentMessage[]>;
  appendMessage(input: {
    conversationId: string;
    role: "user" | "assistant";
    content: string;
    metadata?: Record<string, unknown>;
  }): Promise<void>;
  getConversation(conversationId: string): Promise<AgentConversation | null>;
  updateConversation(
    conversationId: string,
    input: { metadata: Record<string, unknown> },
  ): Promise<void>;
}

export class InMemoryAgentConversationStore implements AgentConversationStore {
  private readonly messages = new Map<string, StoredAgentMessage[]>();
  private readonly conversations = new Map<string, AgentConversation>();

  async getMessages(input: { conversationId: string; limit: number; order?: "asc" | "desc" }) {
    const messages = this.messages.get(input.conversationId) ?? [];
    const limited = messages.slice(-Math.min(Math.max(input.limit, 1), 100));
    return input.order === "desc" ? [...limited].reverse() : limited;
  }

  async appendMessage(input: {
    conversationId: string;
    role: "user" | "assistant";
    content: string;
    metadata?: Record<string, unknown>;
  }) {
    const messages = this.messages.get(input.conversationId) ?? [];
    messages.push({ role: input.role, content: input.content, metadata: input.metadata });
    this.messages.set(input.conversationId, messages);
  }

  async getConversation(conversationId: string) {
    return this.conversations.get(conversationId) ?? null;
  }

  async updateConversation(
    conversationId: string,
    input: { metadata: Record<string, unknown> },
  ) {
    const conversation = this.conversations.get(conversationId) ?? {};
    conversation.metadata = { ...(conversation.metadata ?? {}), ...input.metadata };
    this.conversations.set(conversationId, conversation);
  }
}
