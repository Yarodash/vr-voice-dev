// Answers from Claude waiting to be read in the headset: one is shown at a time, closing it
// shows the next.
export function createMessageQueue() {
  const items = [];
  return {
    push(message) {
      if (!items.some((item) => item.id === message.id)) items.push(message); // re-sent after a reconnect
    },
    get current() {
      return items[0] ?? null;
    },
    get size() {
      return items.length;
    },
    // Removes the shown message; returns its id (null if there was none).
    close() {
      return items.shift()?.id ?? null;
    },
  };
}
