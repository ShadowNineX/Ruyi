import { describe, expect, test } from 'bun:test';
import { HeadlessChatSession } from '../../src/steam/headless-session';

describe('HeadlessChatSession', () => {
  test('accepts the full chat runtime lifecycle without UI side effects', () => {
    const session = new HeadlessChatSession();

    expect(() => {
      session.onThinking();
      session.onApprovalPending();
      session.onTextGenerationStart('hello');
      session.onTextGenerationEnd();
      session.onToolStart('web_search', { query: 'test' });
      session.onToolEnd('web_search');
      session.onComplete();
      session.onError();
    }).not.toThrow();
  });
});
