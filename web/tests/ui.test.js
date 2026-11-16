import { describe, expect, it } from 'vitest';
import { createMessageQueue } from '../src/message-queue.js';
import { MESSAGE, messageActionAt } from '../src/ui-layout.js';

describe('createMessageQueue', () => {
  it('shows the first message and counts the rest', () => {
    const queue = createMessageQueue();
    queue.push({ id: 'a', text: 'первое' });
    queue.push({ id: 'b', text: 'второе' });

    expect(queue.current).toEqual({ id: 'a', text: 'первое' });
    expect(queue.size).toBe(2);
  });

  it('closing shows the next one and says which was closed', () => {
    const queue = createMessageQueue();
    queue.push({ id: 'a', text: 'первое' });
    queue.push({ id: 'b', text: 'второе' });

    expect(queue.close()).toBe('a');
    expect(queue.current).toEqual({ id: 'b', text: 'второе' });
    expect(queue.close()).toBe('b');
    expect(queue.current).toBe(null);
    expect(queue.close()).toBe(null);
  });

  it('does not show the same message twice after a reconnect', () => {
    const queue = createMessageQueue();
    queue.push({ id: 'a', text: 'первое' });
    queue.push({ id: 'a', text: 'первое' });

    expect(queue.size).toBe(1);
  });
});

// centre of a rectangle as texture coordinates (v = 1 at the top)
const uv = (rect, size) => [(rect.x + rect.w / 2) / size.width, 1 - (rect.y + rect.h / 2) / size.height];

describe('what the pointer hits', () => {
  it('finds the cross of the message window', () => {
    expect(messageActionAt(...uv(MESSAGE.close, MESSAGE))).toBe('close-message');
    expect(messageActionAt(0.5, 0.5)).toBe(null);
  });
});
