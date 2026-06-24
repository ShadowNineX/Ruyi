import type { ToolContext } from '../../src/utils/types';
import { describe, expect, test } from 'bun:test';
import { getCurrentToolConfigScope } from '../../src/utils/tool-config-scope';
import { runWithToolContext, toolContextManager } from '../../src/utils/types';

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    surface: 'discord',
    identity: null,
    message: null,
    channel: null,
    guild: null,
    referencedMessage: null,
    ...overrides,
  };
}

describe('tool context manager', () => {
  test('returns an empty Discord context outside a bound turn', () => {
    expect(toolContextManager.get()).toMatchObject({
      surface: 'discord',
      message: null,
      channel: null,
      guild: null,
    });
  });

  test('binds Steam context inside a tool turn', async () => {
    await runWithToolContext(
      context({
        surface: 'steam',
        steam: {
          accountId: 'ruyi',
          profileId: '76561198000000002',
          sourceCommentId: 'comment-1',
        },
      }),
      async () => {
        expect(toolContextManager.get()).toMatchObject({
          surface: 'steam',
          steam: {
            accountId: 'ruyi',
            profileId: '76561198000000002',
            sourceCommentId: 'comment-1',
          },
        });
      },
    );
  });

  test('enforces reverse image follow-up budgets only after reverse search starts', async () => {
    await runWithToolContext(context(), async () => {
      expect(toolContextManager.consumeToolCall('web_search')).toEqual({
        allowed: true,
      });
      expect(toolContextManager.consumeToolCall('reverse_image_search')).toEqual({
        allowed: true,
      });
      expect(toolContextManager.consumeToolCall('web_search')).toEqual({
        allowed: true,
      });

      const denied = toolContextManager.consumeToolCall('web_search');
      expect(denied).toMatchObject({
        allowed: false,
        tool: 'web_search',
        limit: 1,
        used: 1,
      });
    });
  });

  test('refunds budgeted tool calls', async () => {
    await runWithToolContext(context(), async () => {
      toolContextManager.consumeToolCall('reverse_image_search');
      toolContextManager.consumeToolCall('describe_image');
      expect(toolContextManager.consumeToolCall('describe_image')).toMatchObject({
        allowed: false,
      });

      toolContextManager.refundToolCall('describe_image');
      expect(toolContextManager.consumeToolCall('describe_image')).toEqual({
        allowed: true,
      });
    });
  });

  test('tracks failed image descriptions for retry limits', async () => {
    await runWithToolContext(context(), async () => {
      expect(toolContextManager.imageDescriptionFailureLimitExceeded()).toBe(false);
      expect(toolContextManager.rememberImageDescriptionFailure('a', '404')).toBe(1);
      expect(toolContextManager.getImageDescriptionFailure('a')).toBe('404');
      expect(toolContextManager.rememberImageDescriptionFailure('b', '403')).toBe(2);
      expect(toolContextManager.imageDescriptionFailureLimitExceeded()).toBe(true);
    });
  });
});

describe('tool config scope', () => {
  test('uses Steam profile scope in Steam tool context', async () => {
    await runWithToolContext(
      context({
        surface: 'steam',
        steam: { accountId: 'ruyi', profileId: '76561198000000002' },
      }),
      async () => {
        expect(getCurrentToolConfigScope()).toEqual({
          kind: 'steam:profile',
          id: '76561198000000002',
        });
      },
    );
  });

  test('uses Discord message guild or DM scope in Discord tool context', async () => {
    const message = {
      guild: { id: 'guild-1' },
      author: { id: 'user-1' },
    } as unknown as NonNullable<ToolContext['message']>;

    await runWithToolContext(context({ message }), async () => {
      expect(getCurrentToolConfigScope()).toEqual({
        kind: 'discord:guild',
        id: 'guild-1',
      });
    });
  });

  test('falls back to guild scope when only guild context exists', async () => {
    const guild = { id: 'guild-2' } as unknown as NonNullable<
      ToolContext['guild']
    >;

    await runWithToolContext(context({ guild }), async () => {
      expect(getCurrentToolConfigScope()).toEqual({
        kind: 'discord:guild',
        id: 'guild-2',
      });
    });
  });
});
