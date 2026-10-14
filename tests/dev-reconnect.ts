export {};

const NativeWebSocket = globalThis.WebSocket;
let disconnected = false;

globalThis.WebSocket = class extends NativeWebSocket {
  constructor(url: string | URL, protocols?: string | string[]) {
    super(url, protocols);
    if (!new URL(String(url)).pathname.endsWith('/v1/live')) return;
    this.addEventListener('message', event => {
      if (disconnected) return;
      try {
        const frame = JSON.parse(String(event.data));
        if (frame.type === 'event' && frame.data?.data?.event === 'response.completed') {
          disconnected = true;
          setTimeout(() => this.close(), 50);
        }
      } catch {}
    });
  }
};
