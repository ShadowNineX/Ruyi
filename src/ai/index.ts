// Main AI module - re-exports all public APIs

import { aiLogger } from '../logger';
import { agentsRuntimeManager } from './client';
// Runtime management
// Convenience shutdown
import { sessionManager } from './session';

// Chat
export { chatService } from './chat';

// Classifier
export { replyClassifier } from './classifier';

export { agentsRuntimeManager } from './client';

// Context and memory
export { type ChatMessage, conversationContext } from './context';

export { editClassifier } from './edit-classifier';
// Permissions
export { permissionManager } from './permissions';

// Session management
export { sessionManager } from './session';

export async function shutdownAgentsRuntime(): Promise<void> {
  aiLogger.info(
    { sessionCount: sessionManager.getActiveCount() },
    'Shutting down OpenAI Agents runtime',
  );

  await sessionManager.destroyAll();
  await agentsRuntimeManager.stop();

  aiLogger.info('OpenAI Agents runtime shutdown complete');
}
